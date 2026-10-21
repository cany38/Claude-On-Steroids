// Starts the server as a separate process (temporary data folder and root, no
// tunnel), connects with the official MCP SDK client, and approves from the panel API.
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
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-root-'));
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-outside-'));
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

async function waitPending(tool) {
  for (let i = 0; i < 100; i++) {
    const s = await panel('/api/state');
    const p = s.body.pending.find((x) => x.tool === tool);
    if (p) return p;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no pending approval for ${tool}`);
}

const text = (r) => r.content.map((c) => c.text).join('\n');

before(async () => {
  fs.writeFileSync(path.join(ROOT, 'hello.txt'), 'hello world\nsecond line\n');
  fs.writeFileSync(path.join(OUTSIDE, 'secret.txt'), 'outside root secret');
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({
    roots: [ROOT], secret: SECRET, panelKey: KEY, publicPort: PUB, panelPort: PANEL,
    tunnel: 'none', approvalTimeoutMs: 4000,
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
  for (const d of [DATA, ROOT, OUTSIDE]) fs.rmSync(d, { recursive: true, force: true });
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

test('reading works without approval, inside the root', async () => {
  const info = JSON.parse(text(await client.callTool({ name: 'machine_info', arguments: {} })));
  assert.deepEqual(info.roots, [ROOT]);
  const list = JSON.parse(text(await client.callTool({ name: 'list_dir', arguments: {} })));
  assert.ok(list.entries.some((e) => e.name === 'hello.txt'));
  const read = await client.callTool({ name: 'read_file', arguments: { path: path.join(ROOT, 'hello.txt') } });
  assert.match(text(read), /hello world/);
  const hits = JSON.parse(text(await client.callTool({ name: 'search', arguments: { query: 'second' } })));
  assert.equal(hits.hits[0].line, 2);
  assert.equal((await panel('/api/state')).body.pending.length, 0);
});

test('reading outside the root is refused', async () => {
  const r = await client.callTool({ name: 'read_file', arguments: { path: path.join(OUTSIDE, 'secret.txt') } });
  assert.equal(r.isError, true);
  assert.match(text(r), /outside approved roots/);
  assert.doesNotMatch(text(r), /outside root secret/);
});

test('a junction inside the root cannot escape it', async () => {
  const link = path.join(ROOT, 'escape');
  const mk = process.platform === 'win32'
    ? spawnSync('cmd', ['/c', 'mklink', '/J', link, OUTSIDE])
    : spawnSync('ln', ['-s', OUTSIDE, link]);
  assert.equal(mk.status, 0, 'could not create the link');
  const r = await client.callTool({ name: 'read_file', arguments: { path: path.join(link, 'secret.txt') } });
  assert.equal(r.isError, true);
  assert.doesNotMatch(text(r), /outside root secret/);
  fs.rmSync(link, { recursive: true, force: true });
});

test('a write waits in the panel and lands on disk once approved', async () => {
  const target = path.join(ROOT, 'new', 'note.txt');
  const call = client.callTool({ name: 'write_file', arguments: { path: target, content: 'approved content' } });
  const p = await waitPending('write_file');
  assert.match(p.info.summary, /new file/);
  assert.equal(p.info.detail, 'approved content');
  assert.equal(fs.existsSync(target), false, 'nothing should be written before approval');
  assert.equal((await panel('/api/approve', { id: p.id })).body.ok, true);
  const r = await call;
  assert.notEqual(r.isError, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'approved content');
});

test('a denied write leaves the disk alone and tells the model why', async () => {
  const target = path.join(ROOT, 'denied.txt');
  const call = client.callTool({ name: 'write_file', arguments: { path: target, content: 'x' } });
  const p = await waitPending('write_file');
  await panel('/api/deny', { id: p.id });
  const r = await call;
  assert.equal(r.isError, true);
  assert.match(text(r), /did not approve/);
  assert.equal(fs.existsSync(target), false);
});

test('an unanswered approval is denied when it times out', async () => {
  const target = path.join(ROOT, 'timeout.txt');
  const r = await client.callTool({ name: 'write_file', arguments: { path: target, content: 'x' } });
  assert.equal(r.isError, true);
  assert.match(text(r), /timed out/);
  assert.equal(fs.existsSync(target), false);
});

test('a command runs once approved and returns its output', async () => {
  const call = client.callTool({ name: 'exec_command', arguments: { command: 'echo hello-cmd' } });
  const p = await waitPending('exec_command');
  await panel('/api/approve', { id: p.id });
  const out = JSON.parse(text(await call));
  assert.equal(out.ok, true);
  assert.match(out.output, /hello-cmd/);
});

test('deletes and destructive commands ask even with auto-approve on', async () => {
  await panel('/api/settings', { autoApprove: { write: true, exec: true } });
  const edit = await client.callTool({ name: 'edit_file', arguments: { path: path.join(ROOT, 'hello.txt'), find: 'hello', replace: 'hi' } });
  assert.notEqual(edit.isError, true, 'edits should be auto-approved');
  assert.match(fs.readFileSync(path.join(ROOT, 'hello.txt'), 'utf8'), /hi world/);

  const del = client.callTool({ name: 'delete_file', arguments: { path: path.join(ROOT, 'hello.txt') } });
  const p = await waitPending('delete_file');
  assert.equal(p.info.destructive, true);
  await panel('/api/deny', { id: p.id });
  assert.equal((await del).isError, true);
  assert.equal(fs.existsSync(path.join(ROOT, 'hello.txt')), true);

  const rm = client.callTool({ name: 'exec_command', arguments: { command: 'del /q hello.txt' } });
  const q = await waitPending('exec_command');
  assert.equal(q.info.destructive, true);
  await panel('/api/deny', { id: q.id });
  await rm;
  assert.equal(fs.existsSync(path.join(ROOT, 'hello.txt')), true);
  await panel('/api/settings', { autoApprove: { write: false, exec: false } });
});

test('auto-approve for deletes lets a delete through without asking', async () => {
  fs.writeFileSync(path.join(ROOT, 'gone.txt'), 'x');
  await panel('/api/settings', { autoApprove: { write: true, exec: true, destroy: true } });
  const del = await client.callTool({ name: 'delete_file', arguments: { path: path.join(ROOT, 'gone.txt') } });
  assert.notEqual(del.isError, true, 'deletes should be auto-approved');
  assert.equal(fs.existsSync(path.join(ROOT, 'gone.txt')), false);
  assert.equal((await panel('/api/state')).body.pending.length, 0);
  await panel('/api/settings', { autoApprove: { write: false, exec: false, destroy: false } });
});

test('read-only mode refuses a write without asking', async () => {
  await panel('/api/settings', { readOnly: true });
  const r = await client.callTool({ name: 'write_file', arguments: { path: path.join(ROOT, 'ro.txt'), content: 'x' } });
  assert.equal(r.isError, true);
  assert.match(text(r), /read-only mode/);
  assert.equal((await panel('/api/state')).body.pending.length, 0);
  await panel('/api/settings', { readOnly: false });
});

test('panel guards: no key gives 401, foreign Host and Origin give 403', async () => {
  const noKey = await fetch(`http://127.0.0.1:${PANEL}/api/state`);
  assert.equal(noKey.status, 401);
  const badHost = spawnSync(process.execPath, ['-e', `
    const http = require('http');
    const r = http.request({ host: '127.0.0.1', port: ${PANEL}, path: '/api/state', headers: { Host: 'evil.example:${PANEL}', 'X-Panel-Key': '${KEY}' } }, (res) => { console.log(res.statusCode); res.resume(); process.exit(0); });
    r.end();`], { encoding: 'utf8' });
  assert.equal(badHost.stdout.trim(), '403');
  const csrf = await panel('/api/settings', { readOnly: true }, { Origin: 'https://evil.example' });
  assert.equal(csrf.status, 403);
  assert.equal((await panel('/api/state')).body.settings.readOnly, false);
});

test('records are kept in the panel and on disk', async () => {
  const s = await panel('/api/state');
  assert.ok(s.body.log.some((e) => e.tool === 'write_file' && e.decision === 'approved'));
  assert.ok(s.body.log.some((e) => e.decision === 'denied'));
  const lines = fs.readFileSync(path.join(DATA, 'calls.jsonl'), 'utf8').trim().split('\n');
  assert.ok(lines.length >= 8);
});
