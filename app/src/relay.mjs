// Client for the relay Worker in ../relay. It keeps one outbound WebSocket open and
// answers each request the relay forwards by calling the local MCP server.
// The public address is <relayUrl>/<id>, where <id> comes from the install's secret,
// so it stays the same across restarts.
import http from 'node:http';
import crypto from 'node:crypto';
import WebSocket from 'ws';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const relayId = (secret) => sha(`cos-relay-id:${secret}`).slice(0, 24);
const relayAuth = (secret) => sha(`cos-relay-auth:${secret}`);

const SKIP_RES = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'upgrade', 'proxy-connection']);

// onUp(publicUrl): the socket is open. onDown(why, gaveUp): it closed; with gaveUp the
// client has stopped for good (never connected, or the relay refused it), otherwise it
// reconnects by itself with a growing delay.
export function connectRelay({ relayUrl, secret, port, onUp, onDown }) {
  const base = String(relayUrl).replace(/\/+$/, '');
  const id = relayId(secret);
  const publicUrl = `${base}/${id}`;
  const wsUrl = `${base.replace(/^http/i, 'ws')}/_connect/${id}`;
  const reqs = new Map();   // request id -> http.ClientRequest to the local server
  let ws = null;
  let pingTimer = null;
  let retryTimer = null;
  let attempt = 0;
  let everUp = false;
  let stopped = false;

  const send = (o) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };
  const dropReqs = () => { for (const r of reqs.values()) r.destroy(); reqs.clear(); };

  const onReq = (m) => {
    // Only the MCP path goes to the local server.
    if (!/^\/mcp\/[0-9a-f]{64}\/?(\?|$)/.test(String(m.path))) {
      send({ t: 'head', id: m.id, status: 404, headers: {} });
      send({ t: 'end', id: m.id });
      return;
    }
    const req = http.request({
      host: '127.0.0.1', port, method: m.method, path: m.path,
      headers: { ...m.headers, host: `127.0.0.1:${port}` },
    }, (res) => {
      const headers = {};
      for (const [k, v] of Object.entries(res.headers)) if (!SKIP_RES.has(k)) headers[k] = v;
      send({ t: 'head', id: m.id, status: res.statusCode, headers });
      res.on('data', (d) => send({ t: 'data', id: m.id, d: d.toString('base64') }));
      res.on('end', () => { send({ t: 'end', id: m.id }); reqs.delete(m.id); });
      res.on('error', (e) => { send({ t: 'error', id: m.id, message: e.message }); reqs.delete(m.id); });
    });
    req.on('error', (e) => { send({ t: 'error', id: m.id, message: e.message }); reqs.delete(m.id); });
    reqs.set(m.id, req);
  };

  const open = () => {
    if (stopped) return;
    const sock = new WebSocket(wsUrl, { headers: { 'x-relay-auth': relayAuth(secret) }, handshakeTimeout: 10_000 });
    ws = sock;
    let lastErr = '';
    let lastHeard = Date.now();

    sock.on('open', () => {
      everUp = true;
      attempt = 0;
      lastHeard = Date.now();
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        // No pong for a minute: the connection is half open (the relay still
        // routes requests here but nothing arrives). Drop it and reconnect.
        if (Date.now() - lastHeard > 60_000) { lastErr = 'no answer from the relay'; try { sock.terminate(); } catch {} return; }
        try { sock.send('ping'); } catch {}
      }, 25_000);
      onUp(publicUrl);
    });

    sock.on('message', (data, isBinary) => {
      lastHeard = Date.now();
      if (isBinary) return;
      const s = data.toString();
      if (s === 'pong') return;
      let m;
      try { m = JSON.parse(s); } catch { return; }
      if (m.t === 'req') onReq(m);
      else if (m.t === 'body') reqs.get(m.id)?.write(Buffer.from(String(m.d), 'base64'));
      else if (m.t === 'reqend') reqs.get(m.id)?.end();
      else if (m.t === 'cancel') { reqs.get(m.id)?.destroy(); reqs.delete(m.id); }
    });

    sock.on('error', (e) => { lastErr = e.message; });

    sock.on('close', (code) => {
      clearInterval(pingTimer);
      dropReqs();
      if (stopped || ws !== sock) return;
      const refused = /Unexpected server response: (401|403|404)/.test(lastErr);
      const why = code === 4000 ? 'another instance took this address' : (lastErr || `closed (${code})`);
      if (!everUp || refused || code === 4000) { stopped = true; onDown(why, true); return; }
      onDown(why, false);
      retryTimer = setTimeout(open, Math.min(30_000, 1000 * 2 ** attempt++));
    });
  };

  open();

  return {
    publicUrl,
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(pingTimer);
      dropReqs();
      try { ws?.terminate(); } catch {}
    },
  };
}
