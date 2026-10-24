// Starts the server as a separate process (temporary data folder, no tunnel) and
// connects with the official MCP SDK client.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUB = 18857, PANEL = 18858;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-data-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-work-'));
const SECRET = crypto.randomBytes(32).toString('hex');
const KEY = crypto.randomBytes(32).toString('hex');
const MCP_URL = `http://127.0.0.1:${PUB}/mcp/${SECRET}`;

let proc, client;

const panel = async (p, body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${PANEL}${p}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Panel-Key': KEY, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const text = (r) => r.content.map((c) => c.text).join('\n');

before(async () => {
  fs.writeFileSync(path.join(WORK, 'hello.txt'), 'hello world\nsecond line\n');
  // Settings an older version wrote; the server drops them on load.
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({
    roots: [os.tmpdir()], readOnly: true, allowExec: false, autoApprove: { write: false }, approvalTimeoutMs: 4000,
    secret: SECRET, panelKey: KEY, publicPort: PUB, panelPort: PANEL, tunnel: 'none',
  }));
  proc = spawn(process.execPath, [path.join(HERE, '..', 'src', 'server.mjs')], {
    env: { ...process.env, CC_DATA: DATA, CC_NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error('the server did not start: ' + out)), 10000);
    const on = (b) => { out += b; if (out.includes('panel')) { clearTimeout(t); resolve(); } };
    proc.stdout.on('data', on); proc.stderr.on('data', on);
  });
  client = new Client({ name: 'cc-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
});

after(async () => {
  try { await client?.close(); } catch {}
  proc?.kill();
  for (const d of [DATA, WORK]) fs.rmSync(d, { recursive: true, force: true });
});

test('a wrong secret path returns 404 with an empty body', async () => {
  const wrong = await fetch(`http://127.0.0.1:${PUB}/mcp/${'0'.repeat(64)}`, { method: 'POST', body: '{}' });
  assert.equal(wrong.status, 404);
  assert.equal(await wrong.text(), '');
  assert.equal((await fetch(`http://127.0.0.1:${PUB}/`)).status, 404);
});

test('tools and their annotations are listed', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['delete_file', 'edit_file', 'exec_command', 'list_dir', 'machine_info', 'read_file', 'search', 'write_file']);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(byName.read_file.annotations.readOnlyHint, true);
  assert.equal(byName.delete_file.annotations.destructiveHint, true);
  assert.equal(byName.write_file.annotations.readOnlyHint, false);
});

test('the panel sees this client connect', async () => {
  const s = await panel('/api/state');
  assert.equal(s.body.lastClient.name, 'cc-test');
});

test('old folder and permission settings are dropped from config.json', async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8'));
  for (const k of ['roots', 'readOnly', 'allowExec', 'autoApprove', 'approvalTimeoutMs']) assert.equal(k in cfg, false, k);
  assert.equal(cfg.secret, SECRET);
});

test('machine_info reports the home folder', async () => {
  const info = JSON.parse(text(await client.callTool({ name: 'machine_info', arguments: {} })));
  assert.equal(info.home, os.homedir());
  assert.equal('roots' in info, false);
});

test('reading works on any path', async () => {
  const list = JSON.parse(text(await client.callTool({ name: 'list_dir', arguments: { path: WORK } })));
  assert.ok(list.entries.some((e) => e.name === 'hello.txt'));
  const read = await client.callTool({ name: 'read_file', arguments: { path: path.join(WORK, 'hello.txt') } });
  assert.match(text(read), /hello world/);
  const hits = JSON.parse(text(await client.callTool({ name: 'search', arguments: { path: WORK, query: 'second' } })));
  assert.equal(hits.hits[0].line, 2);
});

test('list_dir with no path lists the home folder', async () => {
  const list = JSON.parse(text(await client.callTool({ name: 'list_dir', arguments: {} })));
  assert.equal(list.dir, os.homedir());
});

test('writes and edits land on disk right away', async () => {
  const target = path.join(WORK, 'new', 'note.txt');
  const w = await client.callTool({ name: 'write_file', arguments: { path: target, content: 'first' } });
  assert.notEqual(w.isError, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'first');
  const e = await client.callTool({ name: 'edit_file', arguments: { path: target, find: 'first', replace: 'second' } });
  assert.notEqual(e.isError, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'second');
});

test('a command runs right away and returns its output', async () => {
  const out = JSON.parse(text(await client.callTool({ name: 'exec_command', arguments: { command: 'echo hello-cmd', cwd: WORK } })));
  assert.equal(out.ok, true);
  assert.equal(out.cwd, WORK);
  assert.match(out.output, /hello-cmd/);
});

test('a delete runs right away', async () => {
  fs.writeFileSync(path.join(WORK, 'gone.txt'), 'x');
  const del = await client.callTool({ name: 'delete_file', arguments: { path: path.join(WORK, 'gone.txt') } });
  assert.notEqual(del.isError, true);
  assert.equal(fs.existsSync(path.join(WORK, 'gone.txt')), false);
});

test('the approval and settings endpoints are gone', async () => {
  for (const p of ['/api/approve', '/api/deny', '/api/settings']) {
    assert.equal((await panel(p, { id: 'x' })).status, 404, p);
  }
  const s = await panel('/api/state');
  assert.equal('pending' in s.body, false);
});

test('panel guards: no key gives 401, foreign Host and Origin give 403', async () => {
  const noKey = await fetch(`http://127.0.0.1:${PANEL}/api/state`);
  assert.equal(noKey.status, 401);
  const badHost = spawnSync(process.execPath, ['-e', `
    const http = require('http');
    const r = http.request({ host: '127.0.0.1', port: ${PANEL}, path: '/api/state', headers: { Host: 'evil.example:${PANEL}', 'X-Panel-Key': '${KEY}' } }, (res) => { console.log(res.statusCode); res.resume(); process.exit(0); });
    r.end();`], { encoding: 'utf8' });
  assert.equal(badHost.stdout.trim(), '403');
  const csrf = await panel('/api/tunnel/restart', {}, { Origin: 'https://evil.example' });
  assert.equal(csrf.status, 403);
});

test('records are kept in the panel and on disk', async () => {
  const s = await panel('/api/state');
  assert.ok(s.body.log.some((e) => e.tool === 'write_file' && e.ok && e.kind === 'write'));
  assert.ok(s.body.log.every((e) => !('decision' in e)));
  const lines = fs.readFileSync(path.join(DATA, 'calls.jsonl'), 'utf8').trim().split('\n');
  assert.ok(lines.length >= 8);
});
