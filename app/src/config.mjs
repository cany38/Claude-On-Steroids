// Settings live in ~/.claude-on-steroids/config.json. The first run generates the
// secret MCP path and the panel key, both 32 random bytes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA = process.env.CC_DATA || path.join(os.homedir(), '.claude-on-steroids');
export const CONFIG_FILE = path.join(DATA, 'config.json');
export const LOG_FILE = path.join(DATA, 'calls.jsonl');
// Address of your deployed relay Worker (see relay/wrangler.toml), such as
// https://cos-relay.<subdomain>.workers.dev. While this is empty the app keeps using
// the other tunnel providers. config.json's relayUrl or CC_RELAY_URL can override it.
export const DEFAULT_RELAY_URL = '';

const DEFAULTS = {
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

// Folder and permission settings of older versions, dropped from config.json on load.
const RETIRED = ['roots', 'readOnly', 'allowExec', 'autoApprove', 'approvalTimeoutMs'];

export function loadConfig() {
  fs.mkdirSync(DATA, { recursive: true });
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* first run */ }
  const merged = { ...DEFAULTS, ...cfg };
  for (const k of RETIRED) delete merged[k];
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
