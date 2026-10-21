// Settings live in ~/.claude-on-steroids/config.json. The first run generates the
// secret MCP path and the panel key, both 32 random bytes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

// The user's real Desktop. On Windows, OneDrive often moves it to
// ...\OneDrive\Desktop, so ask Explorer's own record first, then try the usual places.
function desktopDir() {
  const home = os.homedir();
  const tries = [];
  if (process.platform === 'win32') {
    const r = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Desktop'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const m = String(r.stdout || '').match(/Desktop\s+REG_(?:EXPAND_)?SZ\s+(.+)/);
    if (m) tries.push(m[1].trim().replace(/%([^%]+)%/g, (_, v) => process.env[v] ?? `%${v}%`));
    if (process.env.OneDrive) tries.push(path.join(process.env.OneDrive, 'Desktop'));
  }
  tries.push(path.join(home, 'Desktop'));
  return tries.find((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } }) || home;
}

export const DATA = process.env.CC_DATA || path.join(os.homedir(), '.claude-on-steroids');
export const CONFIG_FILE = path.join(DATA, 'config.json');
export const LOG_FILE = path.join(DATA, 'calls.jsonl');
// Address of your deployed relay Worker (see relay/wrangler.toml), such as
// https://cos-relay.<subdomain>.workers.dev. While this is empty the app keeps using
// the other tunnel providers. config.json's relayUrl or CC_RELAY_URL can override it.
export const DEFAULT_RELAY_URL = '';

const DEFAULTS = {
  // A remote connector should not get the whole disk: start with the Desktop
  // and narrow it to one project folder in the panel.
  roots: [desktopDir()],
  readOnly: false,
  allowExec: true,
  // Writes and safe commands can skip the panel, off by default.
  // Deletes and destructive commands have their own switch;
  // only "No restrictions" turns that one on.
  autoApprove: { write: false, exec: false, destroy: false },
  approvalTimeoutMs: 110_000,
  maxOutputBytes: 200_000,
  execTimeoutMs: 120_000,
  publicPort: 8867,
  panelPort: 8868,
  // auto: the relay if it is set up, else Cloudflare's quick tunnel; none means
  // no tunnel, so set publicUrl by hand.
  tunnel: 'auto',
  publicUrl: '',
  // The user's own relay, written by the panel's "Get a permanent address".
  relayUrl: '',
};

const secret = () => crypto.randomBytes(32).toString('hex');

export function loadConfig() {
  fs.mkdirSync(DATA, { recursive: true });
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* first run */ }
  const merged = { ...DEFAULTS, ...cfg, autoApprove: { ...DEFAULTS.autoApprove, ...(cfg.autoApprove || {}) } };
  if (!merged.secret) merged.secret = secret();
  if (!merged.panelKey) merged.panelKey = secret();
  if (process.env.CC_PUBLIC_PORT) merged.publicPort = Number(process.env.CC_PUBLIC_PORT);
  if (process.env.CC_PANEL_PORT) merged.panelPort = Number(process.env.CC_PANEL_PORT);
  if (process.env.CC_TUNNEL) merged.tunnel = process.env.CC_TUNNEL;
  saveConfig(merged);
  return merged;
}

export function saveConfig(cfg) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

// Fields the panel may change. secret, panelKey and ports stay fixed.
export function applySettings(cfg, patch) {
  const next = { ...cfg, autoApprove: { ...cfg.autoApprove } };
  if (Array.isArray(patch.roots)) {
    next.roots = patch.roots.map((r) => String(r).trim()).filter(Boolean).map((r) => path.resolve(r));
  }
  if (typeof patch.readOnly === 'boolean') next.readOnly = patch.readOnly;
  if (typeof patch.allowExec === 'boolean') next.allowExec = patch.allowExec;
  if (patch.autoApprove && typeof patch.autoApprove === 'object') {
    for (const k of ['write', 'exec', 'destroy']) {
      if (typeof patch.autoApprove[k] === 'boolean') next.autoApprove[k] = patch.autoApprove[k];
    }
  }
  return next;
}
