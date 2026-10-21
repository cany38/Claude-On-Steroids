// "Get a permanent address": puts the relay Worker (../relay) on the user's own free
// Cloudflare account, so their connector URL never changes and only they can see
// the traffic. The user's whole part is one browser sign-in and one "Allow" click;
// everything else runs here through wrangler (fetched with npx on first use).
import { spawn } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RELAY_DIR = path.join(HERE, '..', 'relay');
const WRANGLER = 'npx --yes wrangler@4.151.2';
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

// One wrangler command. The command line is a fixed literal (no user input), so the
// shell is safe here; it is needed because npx is a .cmd script on Windows.
function wrangler(args, { timeoutMs = 180_000, env = {}, onOutput } = {}) {
  return new Promise((resolve) => {
    const child = spawn(`${WRANGLER} ${args}`, {
      cwd: RELAY_DIR, shell: true, windowsHide: true,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const take = (b) => { const s = b.toString('utf8').replace(ANSI, ''); out += s; onOutput?.(s, out); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: out + e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

const accountIds = (text) => [...new Set(String(text).match(/\b[0-9a-f]{32}\b/g) || [])];
const workersUrl = (text) => (String(text).match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i) || [])[0] || '';
const needsSubdomain = (text) => /workers\.dev subdomain|register a workers\.dev|no workers\.dev subdomain/i.test(text);
const lastLine = (text) => String(text).trim().split('\n').filter(Boolean).pop()?.slice(0, 200) || '';

// A new account has no workers.dev name yet; wrangler would ask for one in a terminal.
// Register a random one through the API with the token wrangler already holds.
async function registerSubdomain(accountId) {
  const t = await wrangler('auth token', { timeoutMs: 60_000 });
  const token = (t.out.match(/[A-Za-z0-9_-]{30,}(?:\.[A-Za-z0-9_-]+)*/g) || []).pop();
  if (!token) return { ok: false, error: 'could not read the Cloudflare sign-in token' };
  for (let i = 0; i < 3; i++) {
    const name = `cos-${crypto.randomBytes(4).toString('hex')}`;
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ subdomain: name }),
    }).then((x) => x.json()).catch((e) => ({ success: false, errors: [{ message: e.message }] }));
    if (r.success) return { ok: true, name };
    const msg = r.errors?.[0]?.message || 'unknown error';
    if (!/taken|unavailable|exists/i.test(msg)) return { ok: false, error: msg };
  }
  return { ok: false, error: 'no free workers.dev name found' };
}

// state.step: idle | checking | login | deploying | done | error
export function createRelaySetup() {
  const ev = new EventEmitter();
  const state = { step: 'idle', message: '', loginUrl: '', url: '', error: '' };
  const set = (patch) => { Object.assign(state, patch); ev.emit('change', { ...state }); };
  let running = false;

  async function run() {
    if (running) return;
    running = true;
    try {
      set({ step: 'checking', message: 'Checking for a Cloudflare sign-in (the first run downloads the Cloudflare tool, about a minute)...', loginUrl: '', url: '', error: '' });
      let who = await wrangler('whoami', { timeoutMs: 240_000 });
      if (/not authenticated|wrangler login/i.test(who.out) || !accountIds(who.out).length) {
        set({ step: 'login', message: 'A Cloudflare page opened in your browser. Sign in (or create a free account) and click Allow.' });
        const login = await wrangler('login', {
          timeoutMs: 600_000,
          onOutput: (_s, all) => {
            const u = (all.match(/https:\/\/dash\.cloudflare\.com\/oauth2\/auth\S+/) || [])[0];
            if (u && !state.loginUrl) set({ loginUrl: u });
          },
        });
        if (!/successfully logged in/i.test(login.out)) {
          throw new Error(/denied|cancel/i.test(login.out) ? 'Sign-in was cancelled.' : 'Sign-in did not finish within 10 minutes. Press the button to try again.');
        }
        who = await wrangler('whoami', { timeoutMs: 60_000 });
      }
      const accounts = accountIds(who.out);
      if (!accounts.length) throw new Error(`Signed in, but no Cloudflare account was found. ${lastLine(who.out)}`);
      // With several accounts wrangler would ask which one; use the first.
      const env = { CLOUDFLARE_ACCOUNT_ID: accounts[0] };

      set({ step: 'deploying', message: 'Setting up your relay on Cloudflare...', loginUrl: '' });
      let dep = await wrangler('deploy', { env });
      if (!workersUrl(dep.out) && needsSubdomain(dep.out)) {
        set({ message: 'Choosing a workers.dev name for your account...' });
        const sub = await registerSubdomain(accounts[0]);
        if (!sub.ok) throw new Error(`Could not set up a workers.dev name: ${sub.error}`);
        dep = await wrangler('deploy', { env });
      }
      const url = workersUrl(dep.out);
      if (!url) throw new Error(`Cloudflare did not return an address. ${lastLine(dep.out)}`);
      set({ step: 'done', url, message: 'Your permanent address is ready.' });
      return url;
    } catch (e) {
      set({ step: 'error', error: e.message, message: '' });
      return null;
    } finally {
      running = false;
    }
  }

  return { ev, state, run, get running() { return running; } };
}
