// Relay for Claude On Steroids, a Cloudflare Worker plus one Durable Object per install.
//
//   claude.ai  --HTTPS-->  /<id>/mcp/<secret>  --WebSocket-->  the app on the user's PC
//
// The app opens an outbound WebSocket to /_connect/<id> and keeps it open. <id> is
// derived from the install's secret, so the public address never changes, and the
// user needs no account, token or domain.
//
// Wire format, JSON text frames:
//   relay -> app   req {id,method,path,headers} | body {id,d} | reqend {id} | cancel {id}
//   app -> relay   head {id,status,headers} | data {id,d} | end {id} | error {id,message}
//   d is base64. Text "ping" from the app is answered with "pong" by the runtime
//   without waking the object (WebSocket hibernation keeps idle connections free).
//
// Trust note: whoever runs this Worker can see and send every request that passes
// through it. Run it yourself and keep the approval prompts on.
import { DurableObject } from 'cloudflare:workers';

const ID_RE = /^[0-9a-f]{24}$/;
const SECRET_RE = /^[0-9a-f]{64}$/;
const MAX_BODY = 8 * 1024 * 1024;
const HEAD_TIMEOUT_MS = 95_000;
const NO_BODY = new Set([101, 204, 205, 304]);
const SKIP_REQ = /^(host|connection|keep-alive|te|transfer-encoding|upgrade|cdn-loop|x-real-ip)$|^(cf-|x-forwarded-|x-relay-)/i;

function toB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b) {
  const s = atob(b);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request, env) {
    const parts = new URL(request.url).pathname.split('/').filter(Boolean);
    const stub = (id) => env.RELAY.get(env.RELAY.idFromName(id));
    if (parts.length === 2 && parts[0] === '_connect' && ID_RE.test(parts[1])) {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected a websocket', { status: 426 });
      return stub(parts[1]).fetch(request);
    }
    if (parts.length === 3 && ID_RE.test(parts[0]) && parts[1] === 'mcp' && SECRET_RE.test(parts[2])) {
      return stub(parts[0]).fetch(request);
    }
    return new Response(null, { status: 404 });
  },
};

export class Relay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.pending = new Map();   // request id -> { ws, writer, resolve, reject, timer, gotHead }
    this.seq = 0;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    return request.headers.get('Upgrade') === 'websocket' ? this.connect(request) : this.proxy(request);
  }

  // The first connection for an id stores a hash of its auth value; later ones must match it,
  // so nobody else can take over an id that is already in use.
  async connect(request) {
    const auth = request.headers.get('x-relay-auth') || '';
    if (!/^[0-9a-f]{64}$/.test(auth)) return new Response(null, { status: 403 });
    const hash = await sha256(auth);
    const stored = await this.ctx.storage.get('auth');
    if (stored && stored !== hash) return new Response(null, { status: 403 });
    if (!stored) await this.ctx.storage.put('auth', hash);
    for (const old of this.ctx.getWebSockets()) { try { old.close(4000, 'replaced'); } catch {} }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  finish(id) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
  }

  async proxy(request) {
    const ws = this.ctx.getWebSockets().filter((s) => s.readyState === 1).pop();
    if (!ws) return new Response('connector offline', { status: 503, headers: { 'retry-after': '5', 'cache-control': 'no-store' } });
    if (Number(request.headers.get('content-length') || 0) > MAX_BODY) return new Response(null, { status: 413 });

    const id = String(++this.seq);
    const url = new URL(request.url);
    const headers = {};
    for (const [k, v] of request.headers) if (!SKIP_REQ.test(k)) headers[k] = v;

    const ts = new TransformStream();
    const writer = ts.writable.getWriter();
    const head = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), HEAD_TIMEOUT_MS);
      this.pending.set(id, { ws, writer, resolve, reject, timer, gotHead: false });
    });
    head.catch(() => {});   // it may reject while the body is still being sent
    const send = (o) => ws.send(JSON.stringify(o));

    try {
      // The app sees /mcp/<secret>; the id prefix is only for routing here.
      const path = '/' + url.pathname.split('/').filter(Boolean).slice(1).join('/') + url.search;
      send({ t: 'req', id, method: request.method, path, headers });
      if (request.body) {
        const reader = request.body.getReader();
        let total = 0;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > MAX_BODY) throw new Error('body too large');
          send({ t: 'body', id, d: toB64(value) });
        }
      }
      send({ t: 'reqend', id });
      const h = await head;
      const rh = new Headers();
      for (const [k, v] of Object.entries(h.headers || {})) for (const x of [].concat(v)) rh.append(k, String(x));
      request.signal?.addEventListener('abort', () => {
        try { send({ t: 'cancel', id }); } catch {}
        this.finish(id);
        writer.abort().catch(() => {});
      });
      return new Response(NO_BODY.has(h.status) ? null : ts.readable, { status: h.status, headers: rh });
    } catch (e) {
      this.finish(id);
      writer.abort().catch(() => {});
      const timeout = e.message === 'timeout';
      return new Response(timeout ? 'connector timed out' : 'connector error', { status: timeout ? 504 : 502 });
    }
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string') return;
    let m;
    try { m = JSON.parse(message); } catch { return; }
    const p = this.pending.get(m.id);
    if (!p || p.ws !== ws) return;
    // No await before the write: the writes must start in the order the frames arrived.
    if (m.t === 'head') {
      clearTimeout(p.timer);
      p.gotHead = true;
      p.resolve({ status: Number(m.status) || 502, headers: m.headers });
    } else if (m.t === 'data') {
      p.writer.write(fromB64(String(m.d))).catch(() => {
        try { ws.send(JSON.stringify({ t: 'cancel', id: m.id })); } catch {}
        this.finish(m.id);
      });
    } else if (m.t === 'end') {
      p.writer.close().catch(() => {});
      this.finish(m.id);
    } else if (m.t === 'error') {
      if (p.gotHead) p.writer.abort().catch(() => {});
      else p.reject(new Error(String(m.message || 'error')));
      this.finish(m.id);
    }
  }

  failAll(ws) {
    for (const [id, p] of [...this.pending]) {
      if (p.ws !== ws) continue;
      if (p.gotHead) p.writer.abort().catch(() => {});
      else p.reject(new Error('connector disconnected'));
      this.finish(id);
    }
  }

  async webSocketClose(ws, code) {
    this.failAll(ws);
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch {}
  }

  async webSocketError(ws) {
    this.failAll(ws);
  }
}
