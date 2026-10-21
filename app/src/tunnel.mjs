// Public HTTPS address for the MCP endpoint. cloudflared "quick tunnel" needs
// no account. Some networks reset TLS handshakes whose SNI ends in
// trycloudflare.com; the tunnel dies before it opens. localhost.run rides on ssh,
// needs no account either, and steps in silently as the last fallback. The
// permanent address is the relay (../relay) on the user's own Cloudflare account.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { DATA } from './config.mjs';
import { connectRelay } from './relay.mjs';

function findBin(name) {
  const local = path.join(DATA, 'bin', process.platform === 'win32' ? `${name}.exe` : name);
  if (fs.existsSync(local)) return local;
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true });
  if (r.status === 0) return r.stdout.split(/\r?\n/).find(Boolean)?.trim() || null;
  return null;
}

export function available(relayUrl) {
  // Provider id -> path of its executable, or null when it is not installed.
  const out = {};
  // The relay is built in: no executable, only an address to reach it at.
  for (const id of PROVIDER_IDS) out[id] = id === 'relay' ? (relayUrl ? 'built-in' : null) : findBin(PROVIDERS[id].bin);
  return out;
}

// Each provider: the binary, its arguments, and the pattern that spots the public
// address. Read it only from a real "tunnel is up" line;
// cloudflared prints "https://api.trycloudflare.com" in error output too.
const firstUrl = (re, skip = /failed|error|warn/i) => (text) => {
  for (const line of String(text).split('\n')) {
    if (skip.test(line)) continue;
    const m = line.match(re);
    if (m) return m;
  }
  return null;
};

const PROVIDERS = {
  // Our own relay (../relay): a fixed address per install, no account for the user.
  relay: { label: 'Relay', bin: null },
  cloudflared: {
    label: 'Cloudflare',
    bin: 'cloudflared',
    args: (port) => ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`],
    // The group captures the full address, not just the subdomain. api. is not a tunnel.
    url: firstUrl(/(https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com)/i),
  },
  // localhost.run: over ssh, no account; prints "<id>.lhr.life tunneled with tls termination, https://<id>.lhr.life"
  localhostrun: {
    label: 'localhost.run',
    bin: 'ssh',
    args: (port) => ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=30',
      '-o', 'ExitOnForwardFailure=yes', '-T', '-R', `80:127.0.0.1:${port}`, 'nokey@localhost.run'],
    url: firstUrl(/tunneled with tls termination, (https:\/\/[a-z0-9.-]+)/i),
  },
};


export const PROVIDER_IDS = Object.keys(PROVIDERS);
export const providerLabel = (id) => PROVIDERS[id]?.label || id;

// cloudflared comes from Cloudflare's official GitHub release, into the app's
// own folder, on the panel's Install button. On macOS the release
// is a .tgz, so the panel points at brew instead.
const ASSET = {
  'win32/x64': 'cloudflared-windows-amd64.exe',
  'win32/arm64': 'cloudflared-windows-amd64.exe',   // arm64 Windows runs the amd64 build under emulation
  'linux/x64': 'cloudflared-linux-amd64',
  'linux/arm64': 'cloudflared-linux-arm64',
};

export async function installCloudflared() {
  const asset = ASSET[`${process.platform}/${process.arch}`];
  if (!asset) return { ok: false, error: 'no automatic install for this platform; macOS: brew install cloudflared' };
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) return { ok: false, error: `download failed: HTTP ${res.status}` };
  const buf = Buffer.from(await res.arrayBuffer());
  // Is this really an executable: "MZ" on Windows, the ELF header on Linux.
  const magic = process.platform === 'win32' ? buf.subarray(0, 2).toString('latin1') === 'MZ' : buf.subarray(1, 4).toString('latin1') === 'ELF';
  if (!magic || buf.length < 1_000_000) return { ok: false, error: 'the downloaded file is not a runnable executable' };
  const dir = path.join(DATA, 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  fs.writeFileSync(dest, buf, { mode: 0o755 });
  return { ok: true, path: dest, bytes: buf.length, from: url };
}

// Raw cloudflared/ssh output, cut to one sentence for the panel. The full
// text stays in "detail".
function explain(kind, tail, code) {
  const t = String(tail || '').toLowerCase();
  const label = providerLabel(kind);
  if (/wsarecv|forcibly closed|connection was reset|recv failure|econnreset|read tcp|connection reset/.test(t)) {
    return `The network closed the connection to ${label}. It looks like this network blocks it.`;
  }
  if (/no such host|lookup .*no such|nodename nor servname|dns/.test(t)) {
    return `DNS could not resolve ${label}. Check the connection.`;
  }
  if (/rate limit|too many requests|429|quota exceeded/.test(t)) {
    return `${label} is rate-limiting this network. Wait a minute and restart the tunnel.`;
  }
  if (/permission denied \((publickey|password|keyboard)/.test(t)) {
    return `${label} now requires an account (SSH key).`;
  }
  if (/permission denied|access is denied/.test(t)) {
    return `${label} was not allowed to run. Check the firewall.`;
  }
  if (/address already in use/.test(t)) {
    return `The local port is already in use.`;
  }
  if (/timed out|timeout/.test(t)) {
    return `${label} timed out. The connection is too slow or filtered.`;
  }
  const first = String(tail || '').trim().split('\n').filter(Boolean).pop() || '';
  return first ? `${label} stopped (code ${code}). ${first.slice(0, 160)}` : `${label} stopped (code ${code}).`;
}

// state: { kind, status: 'off'|'starting'|'up'|'error', url, error, detail, tried }
export function startTunnel(mode, port, opts = {}) {
  const ev = new EventEmitter();
  const state = { kind: null, status: 'off', url: '', error: '', detail: '', tried: [] };
  const set = (patch) => { Object.assign(state, patch); ev.emit('change', { ...state }); };
  let child = null;

  const bins = available(opts?.relayUrl);
  // Order: the relay when it is set up (permanent address), then Cloudflare's quick
  // tunnel, then localhost.run as a quiet last resort. A failure moves on to the next.
  // Any other saved mode (an older config may say "ngrok") counts as auto.
  const auto = ['relay', 'cloudflared', 'localhostrun']
    .filter((k) => (k === 'relay' ? !!(opts?.relayUrl && opts?.secret) : !!bins[k]));
  const list = mode === 'none' ? [] : (PROVIDERS[mode] && mode !== 'auto') ? [mode] : auto;

  if (!list.length) {
    set({ status: 'off', error: mode === 'none' ? '' : 'no tunnel provider is available on this machine' });
    return { ev, state, stop() {} };
  }

  let lastError = '';
  let lastDetail = '';
  let stopped = false;          // a process exiting after stop() must not start a new provider
  const reconnects = {};        // an open tunnel reconnects to the same provider at most 3 times

  const launch = (i) => {
    if (stopped) return;
    if (i >= list.length) {
      set({ status: 'error', error: lastError || 'the tunnel could not be opened', detail: lastDetail });
      return;
    }
    const kind = list[i];
    const p = PROVIDERS[kind];
    const bin = bins[kind];
    if (!bin) return launch(i + 1);

    // Drop the old address: during startup the panel must not offer a dead one to copy.
    set({ kind, status: 'starting', url: '', error: '', detail: '', hint: '', tried: list.slice(0, i + 1) });
    if (kind === 'relay') return launchRelay(i);
    child = spawn(bin, p.args(port, opts), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    let tail = '';
    let searchBuf = '';
    // No address inside 30 s: the provider counts as stuck,
    // an ssh session waiting for a password, say.
    const startTimer = setTimeout(() => {
      if (state.status !== 'starting' || state.kind !== kind) return;
      const c = child;
      try { c.kill(); } catch {}
      const why = explain(kind, tail, 'timeout');
      giveUpOrNext(/stopped \(code timeout\)/.test(why) ? `${p.label} did not return an address within ${Math.round((p.startTimeoutMs || 30_000) / 1000)} s.` : why);
    }, p.startTimeoutMs || 30_000);
    // One provider failed: try the next, or show the error when none is left.
    const giveUpOrNext = (msg) => {
      lastError = msg;
      lastDetail = tail.slice(-800);
      if (i + 1 < list.length) launch(i + 1);
      else set({ status: 'error', error: lastError, detail: lastDetail });
    };

    const onData = (buf) => {
      // Strip color codes first. localhost.run prints a big QR code right after
      // the address, so trim the buffer once the address search ran.
      const text = buf.toString('utf8').replace(/\x1b\[[0-9;]*m/g, '');
      const seen = searchBuf + text;
      searchBuf = seen.slice(-2000);
      tail = (tail + text).slice(-4000);
      if (state.status !== 'starting') return;
      // The address line can split across chunks, so search the tail of the
      // previous chunk together with the new one.
      const m = p.url(seen);
      if (m) {
        clearTimeout(startTimer);
        set({ hint: '', status: 'up', url: (m[1] || m[0]).replace(/\/$/, ''), stable: false });
        return;
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => giveUpOrNext(`${p.label} could not start: ${e.message}`));
    child.on('exit', (code) => {
      clearTimeout(startTimer);
      // A process killed on timeout, or one already moved past, does not count.
      if (stopped || state.status === 'error' || state.kind !== kind) return;
      // A dropped tunnel reopens on the same provider first (the address
      // can change); past three drops in a row, move on to the next provider.
      if (state.status === 'up' && (reconnects[i] || 0) < 3) {
        reconnects[i] = (reconnects[i] || 0) + 1;
        set({ status: 'starting', url: '', hint: `${p.label} dropped; reconnecting (${reconnects[i]}/3)...` });
        setTimeout(() => launch(i), 2000);
        return;
      }
      const msg = state.status === 'up' ? `${p.label} kept dropping (code ${code}).` : explain(kind, tail, code);
      giveUpOrNext(msg);
    });
  };

  // The relay is a WebSocket inside this process, not a child process. Its address is
  // fixed, so once it has been up a drop reconnects by itself and never moves on to
  // another provider; only a first connection that fails does.
  const launchRelay = (i) => {
    let opened = false;
    let r = null;
    const next = (msg) => {
      if (stopped) return;
      lastError = msg;
      lastDetail = '';
      if (i + 1 < list.length) launch(i + 1);
      else set({ status: 'error', error: msg, detail: '' });
    };
    const timer = setTimeout(() => {
      if (opened) return;
      r?.stop();
      next('The relay did not answer within 15 s.');
    }, 15_000);
    r = connectRelay({
      relayUrl: opts.relayUrl, secret: opts.secret, port,
      onUp: (url) => {
        if (stopped) return;
        opened = true;
        clearTimeout(timer);
        set({ status: 'up', url, error: '', hint: '', stable: true });
      },
      onDown: (why, gaveUp) => {
        if (stopped) return;
        if (gaveUp) { clearTimeout(timer); r?.stop(); next(`Relay: ${why}`); return; }
        set({ status: 'starting', url: '', hint: `Relay reconnecting (${why})...` });
      },
    });
    child = { kill() { clearTimeout(timer); r?.stop(); } };
  };

  launch(0);

  return {
    ev,
    state,
    stop() { stopped = true; try { child && child.kill(); } catch {} },
  };
}
