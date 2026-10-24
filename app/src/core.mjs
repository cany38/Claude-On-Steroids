// Tool core: the file and command tools. A relative path resolves against the
// home folder, and so does a call that names no folder.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'target']);

const bad = (msg) => ({ ok: false, error: msg });

export function createCore(cfg = {}) {
  const HOME = os.homedir();
  const MAX_OUT = cfg.maxOutputBytes || 200_000;
  const EXEC_TIMEOUT = cfg.execTimeoutMs || 120_000;

  const resolve = (p) => (typeof p === 'string' && p.trim() ? path.resolve(HOME, p) : HOME);

  async function walk(dir, out, depth = 0) {
    if (depth > 12 || out.length > 20000) return;
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (SKIP.has(e.name) || e.isSymbolicLink()) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, out, depth + 1);
      else out.push(p);
    }
  }

  const tools = {
    async machine_info() {
      return {
        ok: true,
        machine: os.hostname(),
        platform: `${process.platform}/${process.arch}`,
        shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
        home: HOME,
      };
    },

    async list_dir({ path: p }) {
      const abs = resolve(p);
      let ents;
      try { ents = await fsp.readdir(abs, { withFileTypes: true }); } catch (e) { return bad(`unreadable: ${e.code || e.message}`); }
      const rows = [];
      for (const e of ents.slice(0, 1000)) {
        let size = null;
        try { size = e.isFile() ? (await fsp.stat(path.join(abs, e.name))).size : null; } catch {}
        rows.push({ name: e.name, dir: e.isDirectory(), size });
      }
      return { ok: true, dir: abs, entries: rows, truncated: ents.length > 1000 };
    },

    async read_file({ path: p, offset = 0, limit = 0 }) {
      if (!p) return bad('path is empty');
      const abs = resolve(p);
      let st;
      try { st = await fsp.stat(abs); } catch (e) { return bad(`unreadable: ${e.code || e.message}`); }
      if (st.isDirectory()) return bad('this is a folder; use list_dir');
      const fh = await fsp.open(abs, 'r');
      try {
        const start = Math.max(0, Number(offset) || 0);
        const want = Math.min(limit > 0 ? Number(limit) : MAX_OUT, Math.max(0, st.size - start), MAX_OUT);
        const buf = Buffer.alloc(want);
        if (want > 0) await fh.read(buf, 0, want, start);
        return { ok: true, path: abs, size: st.size, start, truncated: start + want < st.size, content: buf.toString('utf8') };
      } finally { await fh.close(); }
    },

    async search({ path: p, query = '', isRegex = false, glob = '', maxHits = 200 }) {
      const root = resolve(p);
      if (!query) return bad('query is empty');
      let re = null;
      if (isRegex) {
        try { re = new RegExp(query, 'i'); } catch (e) { return bad(`regex: ${e.message}`); }
      }
      const files = [];
      await walk(root, files);
      const reName = glob
        ? new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
        : null;
      const max = Math.min(Number(maxHits) || 200, 2000);
      const hits = [];
      for (const f of files) {
        if (hits.length >= max) break;
        if (reName && !reName.test(path.basename(f))) continue;
        let st;
        try { st = await fsp.stat(f); } catch { continue; }
        if (st.size > 4 * 1024 * 1024) continue;
        let txt;
        try { txt = await fsp.readFile(f, 'utf8'); } catch { continue; }
        if (txt.includes('\u0000')) continue;
        const lines = txt.split(/\r?\n/);
        for (let i = 0; i < lines.length && hits.length < max; i++) {
          if (re ? re.test(lines[i]) : lines[i].includes(query)) hits.push({ file: f, line: i + 1, text: lines[i].slice(0, 400) });
        }
      }
      return { ok: true, root, hits, truncated: hits.length >= max };
    },

    async write_file({ path: p, content = '' }) {
      if (!p) return bad('path is empty');
      const abs = resolve(p);
      const existed = fs.existsSync(abs);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, content, 'utf8');
      return { ok: true, path: abs, bytes: Buffer.byteLength(content), overwritten: existed };
    },

    async edit_file({ path: p, find = '', replace = '', all = false }) {
      if (!p) return bad('path is empty');
      const abs = resolve(p);
      if (!find) return bad('find is empty');
      let src;
      try { src = await fsp.readFile(abs, 'utf8'); } catch (e) { return bad(`unreadable: ${e.code || e.message}`); }
      const idx = src.indexOf(find);
      if (idx < 0) return bad(`not found: ${JSON.stringify(find.slice(0, 80))}`);
      const count = all ? src.split(find).length - 1 : 1;
      const out = all ? src.split(find).join(replace) : src.slice(0, idx) + replace + src.slice(idx + find.length);
      await fsp.writeFile(abs, out, 'utf8');
      return { ok: true, path: abs, replacements: count, bytes: Buffer.byteLength(out) };
    },

    async delete_file({ path: p }) {
      if (!p) return bad('path is empty');
      const abs = resolve(p);
      if (!fs.existsSync(abs)) return bad('file does not exist');
      await fsp.rm(abs, { recursive: true, force: true });
      return { ok: true, deleted: abs };
    },

    async exec_command({ command = '', cwd = '', timeoutMs = 0 }) {
      if (!command.trim()) return bad('command is empty');
      const dir = resolve(cwd);
      const isWin = process.platform === 'win32';
      const t = Math.min(Number(timeoutMs) || EXEC_TIMEOUT, 900_000);
      return await new Promise((resolve) => {
        const sh = spawn(isWin ? 'cmd.exe' : '/bin/sh', isWin ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command], {
          cwd: dir, env: process.env, windowsHide: true, windowsVerbatimArguments: isWin,
        });
        let out = '';
        const cap = (b) => { if (out.length < MAX_OUT) out += b.toString('utf8'); };
        sh.stdout.on('data', cap);
        sh.stderr.on('data', cap);
        const killer = setTimeout(() => { try { sh.kill('SIGKILL'); } catch {} }, t);
        sh.on('error', (e) => { clearTimeout(killer); resolve(bad(e.message)); });
        sh.on('close', (code) => {
          clearTimeout(killer);
          resolve({ ok: code === 0, exit: code, cwd: dir, output: out.length >= MAX_OUT ? out + '\n[output truncated]' : out });
        });
      });
    },
  };

  const KIND = { write_file: 'write', edit_file: 'write', delete_file: 'delete', exec_command: 'exec' };

  // Log fields for the panel's activity board: the kind, the target (absolute
  // path or command), the search text, and whether the file is new.
  function describe(tool, a = {}) {
    const abs = tool === 'machine_info' ? '' : resolve(a.path);
    const exec = tool === 'exec_command';
    return {
      kind: KIND[tool] || 'read',
      target: exec ? String(a.command || '') : abs,
      query: a.query ? String(a.query).slice(0, 120) : '',
      cwd: exec ? resolve(a.cwd) : '',
      isNew: tool === 'write_file' ? !fs.existsSync(abs) : undefined,
    };
  }

  async function run(tool, args) {
    const fn = tools[tool];
    if (!fn) return bad(`unknown tool: ${tool}`);
    try { return await fn(args || {}); } catch (e) { return bad(`${tool} failed: ${e.message}`); }
  }

  return { HOME, tools, describe, run };
}
