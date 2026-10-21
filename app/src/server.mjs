// Two HTTP servers:
//   public  127.0.0.1:<publicPort>  the tunnel points here; /mcp/<secret> is the only path that answers.
//   panel   127.0.0.1:<panelPort>   this machine only; approvals, records, settings.
//                                    Keep it off the tunnel.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, saveConfig, applySettings, LOG_FILE, CONFIG_FILE, DEFAULT_RELAY_URL } from './config.mjs';
import { createCore } from './core.mjs';
import { createApprovals } from './approvals.mjs';
import { createMcpServer, VERSION } from './mcp.mjs';
import { startTunnel, available, installCloudflared, PROVIDER_IDS, providerLabel } from './tunnel.mjs';
import { createRelaySetup } from './relaySetup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PANEL_HTML = path.join(HERE, '..', 'panel', 'index.html');
const MAX_BODY = 8 * 1024 * 1024;

let cfg = loadConfig();
let core = createCore(cfg);
const approvals = createApprovals({ logFile: LOG_FILE, timeoutMs: cfg.approvalTimeoutMs });
const ctx = () => ({ core, cfg });

const same = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// Rejected early: still read the body. Left unread, the connection breaks
// while the client is writing, and it sees ECONNRESET
// instead of the 401/403/404 meant for it.
const drain = (req) => { if (!req.complete) req.resume(); };

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

// ---- public server: MCP -----------------------------------------------------
const sessions = new Map();   // mcp-session-id -> transport
// Last client to connect (claude.ai sends clientInfo on initialize). The panel
// reads it to confirm the setup worked.
let lastClient = null;

const publicServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(/^\/mcp\/([0-9a-f]{64})\/?$/);
  // A wrong secret path gets an empty 404, nothing else.
  if (!m || !same(m[1], cfg.secret)) { drain(req); res.writeHead(404).end(); return; }

  try {
    const sid = req.headers['mcp-session-id'];
    if (req.method === 'POST') {
      const body = await readBody(req);
      let transport = sid ? sessions.get(sid) : null;
      if (!transport) {
        if (sid || !isInitializeRequest(body)) {
          // Restart dropped the session. 404 tells the client to start over.
          return json(res, sid ? 404 : 400, { jsonrpc: '2.0', error: { code: -32000, message: sid ? 'session not found' : 'initialize first' }, id: null });
        }
        const ci = body.params?.clientInfo || {};
        lastClient = { name: String(ci.name || '?').slice(0, 80), version: String(ci.version || '').slice(0, 40), at: new Date().toISOString() };
        broadcast('client', lastClient);
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id) => { sessions.set(id, transport); },
        });
        transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
        await createMcpServer(ctx, approvals).connect(transport);
      }
      await transport.handleRequest(req, res, body);
      return;
    }
    if (req.method === 'GET' || req.method === 'DELETE') {
      const transport = sid && sessions.get(sid);
      if (!transport) return json(res, 404, { jsonrpc: '2.0', error: { code: -32000, message: 'session not found' }, id: null });
      await transport.handleRequest(req, res);
      return;
    }
    res.writeHead(405, { Allow: 'GET, POST, DELETE' }).end();
  } catch (e) {
    if (!res.headersSent) json(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: e.message }, id: null });
  }
});

// ---- tunnel -----------------------------------------------------------------
// What the tunnel providers need from the config. A function (hoisted), so the first
// call just below and every restart read the current secret and settings.
function tunnelOpts() {
  return { relayUrl: process.env.CC_RELAY_URL || cfg.relayUrl || DEFAULT_RELAY_URL, secret: cfg.secret };
}
let tunnel = startTunnel(cfg.tunnel, cfg.publicPort, tunnelOpts());
const watchTunnel = () => tunnel.ev.on('change', () => broadcast('tunnel', tunnelView()));

// "Get a permanent address": the relay on the user's own Cloudflare account.
const relaySetup = createRelaySetup();
relaySetup.ev.on('change', (s) => broadcast('relaySetup', s));
async function setUpRelay() {
  const url = await relaySetup.run();
  if (!url) return;
  // A fixed provider choice would skip the relay; auto tries it first and still falls
  // back to the quick tunnels if the relay is ever unreachable.
  cfg = { ...cfg, relayUrl: url, tunnel: cfg.tunnel === 'relay' ? 'relay' : 'auto' };
  saveConfig(cfg);
  broadcast('settings', settingsView());
  // A new workers.dev name gets its TLS certificate a few minutes after deploy; until
  // then the handshake fails. Switch now if it already answers, otherwise the watcher
  // below switches as soon as Cloudflare activates it.
  await checkRelay();
}

// Relay watcher: while a relay is set up but this app is not on it (just deployed, or
// it was unreachable at startup and auto fell back to a quick tunnel), look every
// 30 s; the moment it answers, reopen the tunnel so auto picks the relay.
const relayWatch = { reachable: false, checkedAt: '' };
async function probeRelay(u) {
  try { const r = await fetch(`${u}/`, { signal: AbortSignal.timeout(8000) }); return r.status > 0; } catch { return false; }
}
let checking = false;
async function checkRelay() {
  const u = tunnelOpts().relayUrl;
  if (!u || checking || !['auto', 'relay'].includes(cfg.tunnel)) return;
  if (tunnel.state.kind === 'relay' && tunnel.state.status === 'up') return;
  checking = true;
  try {
    relayWatch.reachable = await probeRelay(u);
    relayWatch.checkedAt = new Date().toISOString();
    if (relayWatch.reachable) {
      tunnel.stop();
      tunnel = startTunnel(cfg.tunnel, cfg.publicPort, tunnelOpts());
      watchTunnel();
    }
    broadcast('tunnel', tunnelView());
  } finally { checking = false; }
}
setInterval(checkRelay, 30_000).unref();

// cloudflared is the default tunnel. When it is missing, fetch Cloudflare's signed
// release in the background (no click needed) and move onto it, unless the
// relay already serves the permanent address.
(async () => {
  if (cfg.tunnel === 'none' || available().cloudflared || !['win32', 'linux'].includes(process.platform)) return;
  const r = await installCloudflared().catch((e) => ({ ok: false, error: e.message }));
  if (!r.ok) { console.log(`[cos] cloudflared could not be installed: ${r.error}`); return; }
  console.log(`[cos] cloudflared installed: ${r.path}`);
  if (tunnel.state.kind === 'relay' && tunnel.state.status === 'up') { broadcast('tunnel', tunnelView()); return; }
  tunnel.stop();
  tunnel = startTunnel(cfg.tunnel, cfg.publicPort, tunnelOpts());
  watchTunnel();
  broadcast('tunnel', tunnelView());
})();
watchTunnel();
const baseUrl = () => (tunnel.state.status === 'up' ? tunnel.state.url : (cfg.publicUrl || '').replace(/\/$/, ''));
const connectorUrl = () => (baseUrl() ? `${baseUrl()}/mcp/${cfg.secret}` : '');
const tunnelView = () => ({
  ...tunnel.state,
  connectorUrl: connectorUrl(),
  available: available(tunnelOpts().relayUrl),
  providers: PROVIDER_IDS.map((id) => ({ id, label: providerLabel(id) })),
  current: cfg.tunnel,
  // Only the relay holds the address across restarts; quick tunnels change it.
  fixed: !!tunnel.state.stable,
  // The permanent address: set up (deployed), live (this app is on it), or waiting
  // for Cloudflare to activate it.
  relay: {
    configured: !!tunnelOpts().relayUrl,
    active: tunnel.state.kind === 'relay' && tunnel.state.status === 'up',
    reachable: relayWatch.reachable,
    checkedAt: relayWatch.checkedAt,
  },
});

// ---- panel server -----------------------------------------------------------
const clients = new Set();
function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}
approvals.events.on('pending', (p) => broadcast('pending', p));
approvals.events.on('settled', (s) => broadcast('settled', s));
approvals.events.on('log', (l) => broadcast('log', l));

const settingsView = () => ({
  roots: cfg.roots, readOnly: cfg.readOnly, allowExec: cfg.allowExec, autoApprove: cfg.autoApprove,
  approvalTimeoutMs: cfg.approvalTimeoutMs, publicPort: cfg.publicPort, panelPort: cfg.panelPort,
  tunnel: cfg.tunnel, configFile: CONFIG_FILE, logFile: LOG_FILE,
});

const panelServer = http.createServer(async (req, res) => {
  // Against DNS rebinding: only requests with this machine's own host name.
  const host = String(req.headers.host || '');
  if (host !== `127.0.0.1:${cfg.panelPort}` && host !== `localhost:${cfg.panelPort}`) { drain(req); res.writeHead(403).end(); return; }
  const url = new URL(req.url, `http://${host}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
      'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    });
    res.end(fs.readFileSync(PANEL_HTML));
    return;
  }

  // The key comes in a header (fetch) or a query parameter (EventSource cannot set headers).
  const key = req.headers['x-panel-key'] || url.searchParams.get('k') || '';
  if (!same(key, cfg.panelKey)) return drain(req), json(res, 401, { ok: false, error: 'missing or wrong panel key' });
  // Reject POSTs from another site (CSRF).
  const origin = req.headers.origin;
  if (req.method === 'POST' && origin && origin !== `http://${host}`) return drain(req), json(res, 403, { ok: false, error: 'origin rejected' });

  try {
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': ready\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      return json(res, 200, {
        ok: true, version: VERSION, settings: settingsView(), tunnel: tunnelView(),
        pending: approvals.list(), log: approvals.log().slice(-200), sessions: sessions.size, lastClient,
        relaySetup: { ...relaySetup.state, configured: !!tunnelOpts().relayUrl },
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/relay/setup') {
      if (!relaySetup.running) setUpRelay();   // runs in the background; progress goes over /events
      return json(res, 202, { ok: true, relaySetup: relaySetup.state });
    }
    if (req.method === 'POST' && url.pathname === '/api/approve') {
      const b = (await readBody(req)) || {};
      return json(res, 200, { ok: approvals.approve(String(b.id || '')) });
    }
    if (req.method === 'POST' && url.pathname === '/api/deny') {
      const b = (await readBody(req)) || {};
      return json(res, 200, { ok: approvals.deny(String(b.id || ''), b.reason ? String(b.reason).slice(0, 200) : undefined) });
    }
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const b = (await readBody(req)) || {};
      cfg = applySettings(cfg, b);
      saveConfig(cfg);
      core = createCore(cfg);
      broadcast('settings', settingsView());
      return json(res, 200, { ok: true, settings: settingsView() });
    }
    if (req.method === 'POST' && url.pathname === '/api/tunnel/restart') {
      drain(req);
      tunnel.stop();
      tunnel = startTunnel(cfg.tunnel, cfg.publicPort, tunnelOpts());
      watchTunnel();
      broadcast('tunnel', tunnelView());
      return json(res, 200, { ok: true, tunnel: tunnelView() });
    }
    if (req.method === 'POST' && url.pathname === '/api/tunnel/install') {
      const r = await installCloudflared();
      if (r.ok) {
        tunnel.stop();
        tunnel = startTunnel(cfg.tunnel, cfg.publicPort, tunnelOpts());
        watchTunnel();
        broadcast('tunnel', tunnelView());
      }
      return json(res, r.ok ? 200 : 502, { ...r, tunnel: tunnelView() });
    }
    if (req.method === 'POST' && url.pathname === '/api/secret/rotate') {
      // A new secret path kills the old connector address;
      // update it in claude.ai.
      cfg = { ...cfg, secret: crypto.randomBytes(32).toString('hex') };
      saveConfig(cfg);
      for (const t of sessions.values()) t.close?.();
      sessions.clear();
      // The relay address comes from the secret, so it has to reconnect under the new one.
      if (tunnel.state.kind === 'relay') {
        tunnel.stop();
        tunnel = startTunnel(cfg.tunnel, cfg.publicPort, tunnelOpts());
        watchTunnel();
      }
      broadcast('tunnel', tunnelView());
      return json(res, 200, { ok: true, tunnel: tunnelView() });
    }
    json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    json(res, 400, { ok: false, error: e.message });
  }
});

// ---- start ------------------------------------------------------------------
const listen = (srv, port) => new Promise((resolve, reject) => {
  srv.once('error', reject);
  srv.listen(port, '127.0.0.1', resolve);
});

// If an idle keep-alive socket closes on Node's default 5 s, a client reusing it
// (the tunnel, a browser) hits ECONNRESET.
for (const srv of [publicServer, panelServer]) { srv.keepAliveTimeout = 65_000; srv.headersTimeout = 66_000; }
await listen(publicServer, cfg.publicPort);
await listen(panelServer, cfg.panelPort);

const panelUrl = `http://127.0.0.1:${cfg.panelPort}/#k=${cfg.panelKey}`;
  console.log(`[cc] Claude On Steroids ${VERSION}`);
console.log(`[cc] MCP (local) -> http://127.0.0.1:${cfg.publicPort}/mcp/<secret>`);
console.log(`[cc] panel       -> ${panelUrl}`);
console.log(`[cc] roots       -> ${cfg.roots.join(', ')}`);
tunnel.ev.on('change', (s) => {
  if (s.status === 'up') console.log(`[cc] tunnel (${s.kind}) is open; connector address is in the panel`);
  if (s.status === 'error') console.log(`[cc] tunnel error: ${s.error}`);
});
if (tunnel.state.status === 'off') console.log(`[cc] no tunnel: ${tunnel.state.error || 'tunnel: none'}; see the panel`);

if (!process.env.CC_NO_OPEN) {
  const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', panelUrl]]
    : process.platform === 'darwin' ? ['open', [panelUrl]] : ['xdg-open', [panelUrl]];
  try { spawn(opener[0], opener[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch { /* the browser did not open */ }
}

const shutdown = () => {
  approvals.close();
  tunnel.stop();
  publicServer.close();
  panelServer.close();
  setTimeout(() => process.exit(0), 300).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
