// Tool core: the root gate plus the file and command tools. approvals.mjs
// decides what needs approval.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'target']);

// Destructive commands always wait for the panel, never ride on auto-approve.
// The pattern stays broad: a false positive costs one approval.
export const DESTRUCTIVE =
  /\b(rm\s+-[a-z]*[rf]|rmdir|rd\s*\/s|erase|del\s*\/[qsf]|del\s|remove-item|clear-content|format-volume|format\s+[a-z]:|diskpart|takeown|icacls\s*\/[gr]|reg\s+delete|stop-computer|restart-computer|shutdown|cipher\s*\/w|shred|wipefs|mkfs|dd\s+if=|git\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+(-f|--force))|curl[^|]*\|\s*(ba)?sh|wget[^|]*\|\s*(ba)?sh|iwr[^|]*\|\s*iex|invoke-expression)/i;

const bad = (msg) => ({ ok: false, error: msg });

export function createCore(cfg) {
  const ROOTS = (cfg.roots || []).map((r) => path.resolve(r));
  const MAX_OUT = cfg.maxOutputBytes || 200_000;
  const EXEC_TIMEOUT = cfg.execTimeoutMs || 120_000;

  const norm = (r) => (r.length > 3 ? r.replace(/[\\/]+$/, '') : r);
  const inside = (p, r) => {
    const a = p.toLowerCase();
    const root = norm(r).toLowerCase();
    const edge = root.endsWith(path.sep) ? root : root + path.sep;
    return a === root || a.startsWith(edge);
  };

  // Root gate. Check the written path and the real path (links and junctions
  // resolved). For a path that does not exist yet, use the real path
  // of its nearest existing parent.
  function gate(p) {
    if (typeof p !== 'string' || !p.trim()) return null;
    const abs = path.resolve(p);
    for (const r of ROOTS) {
      if (!inside(abs, r)) continue;
      let probe = abs;
      while (!fs.existsSync(probe)) {
        const up = path.dirname(probe);
        if (up === probe) break;
        probe = up;
      }
      let real;
      try { real = fs.realpathSync.native(probe); } catch { real = probe; }
      let realRoot;
      try { realRoot = fs.realpathSync.native(r); } catch { realRoot = r; }
      if (inside(real, realRoot)) return abs;
    }
    return null;
  }
  const outside = (p) => bad(`path outside approved roots: ${p} (approved roots: ${ROOTS.join(', ') || '(none)'})`);

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
        roots: ROOTS,
        readOnly: !!cfg.readOnly,
        allowExec: cfg.allowExec !== false,
      };
    },

    async list_dir({ path: p }) {
      const abs = p ? gate(p) : ROOTS[0];
      if (!abs) return p ? outside(p) : bad('no approved folder is configured');
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
      const abs = gate(p);
      if (!abs) return outside(p);
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
      const root = p ? gate(p) : ROOTS[0];
      if (!root) return p ? outside(p) : bad('no approved folder is configured');
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
      if (cfg.readOnly) return bad('read-only mode is on');
      const abs = gate(p);
      if (!abs) return outside(p);
      const existed = fs.existsSync(abs);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, content, 'utf8');
      return { ok: true, path: abs, bytes: Buffer.byteLength(content), overwritten: existed };
    },

    async edit_file({ path: p, find = '', replace = '', all = false }) {
      if (cfg.readOnly) return bad('read-only mode is on');
      const abs = gate(p);
      if (!abs) return outside(p);
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
      if (cfg.readOnly) return bad('read-only mode is on');
      const abs = gate(p);
      if (!abs) return outside(p);
      if (ROOTS.some((r) => norm(r).toLowerCase() === abs.toLowerCase())) return bad('an approved root cannot be deleted');
      if (!fs.existsSync(abs)) return bad('file does not exist');
      await fsp.rm(abs, { recursive: true, force: true });
      return { ok: true, deleted: abs };
    },

    async exec_command({ command = '', cwd = '', timeoutMs = 0 }) {
      if (cfg.allowExec === false) return bad('command execution is switched off in settings');
      if (cfg.readOnly) return bad('read-only mode is on');
      if (!command.trim()) return bad('command is empty');
      const dir = cwd ? gate(cwd) : ROOTS[0];
      if (!dir) return cwd ? outside(cwd) : bad('no approved folder is configured');
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

  // What the panel shows for this action: the kind and a short summary.
  function describeText(tool, a) {
    switch (tool) {
      case 'write_file': {
        const abs = gate(a.path);
        const exists = abs && fs.existsSync(abs);
        return {
          kind: 'write', destructive: false,
          summary: `${exists ? 'overwrite' : 'new file'}: ${abs || a.path}`,
          detail: String(a.content ?? '').slice(0, 4000),
          extra: exists ? `current size ${fs.statSync(abs).size} bytes -> new ${Buffer.byteLength(String(a.content ?? ''))} bytes` : `${Buffer.byteLength(String(a.content ?? ''))} bytes`,
        };
      }
      case 'edit_file':
        return {
          kind: 'write', destructive: false,
          summary: `edit: ${gate(a.path) || a.path}${a.all ? ' (all matches)' : ''}`,
          detail: `- ${String(a.find ?? '').slice(0, 2000)}\n+ ${String(a.replace ?? '').slice(0, 2000)}`,
        };
      case 'delete_file':
        return { kind: 'delete', destructive: true, summary: `DELETE: ${gate(a.path) || a.path}`, detail: 'No undo.' };
      case 'exec_command': {
        const destructive = DESTRUCTIVE.test(String(a.command || ''));
        return {
          kind: 'exec', destructive,
          summary: `command${destructive ? ' (may be DESTRUCTIVE)' : ''}: ${String(a.command || '').slice(0, 300)}`,
          detail: `folder: ${(a.cwd && gate(a.cwd)) || a.cwd || ROOTS[0] || '?'}\n${String(a.command || '')}`,
        };
      }
      default:
        return { kind: 'read', destructive: false, summary: [a.query && `"${String(a.query).slice(0, 80)}"`, a.path].filter(Boolean).join(' | '), detail: '' };
    }
  }

  // Panel fields: the target (absolute path or command), the search
  // text, and whether the file is new. The panel shortens long paths against the roots.
  function describe(tool, a = {}) {
    const info = describeText(tool, a);
    const abs = a.path ? gate(a.path) || a.path : '';
    const target = tool === 'exec_command' ? String(a.command || '')
      : abs || (tool === 'list_dir' || tool === 'search' ? ROOTS[0] || '' : '');
    return {
      ...info,
      target,
      query: a.query ? String(a.query).slice(0, 120) : '',
      cwd: tool === 'exec_command' ? (a.cwd && gate(a.cwd)) || a.cwd || ROOTS[0] || '' : '',
      isNew: tool === 'write_file' ? !(abs && fs.existsSync(abs)) : undefined,
      before: tool === 'edit_file' ? String(a.find ?? '').slice(0, 3000) : undefined,
      after: tool === 'edit_file' ? String(a.replace ?? '').slice(0, 3000) : undefined,
    };
  }

  async function run(tool, args) {
    const fn = tools[tool];
    if (!fn) return bad(`unknown tool: ${tool}`);
    try { return await fn(args || {}); } catch (e) { return bad(`${tool} failed: ${e.message}`); }
  }

  return { ROOTS, gate, tools, describe, run };
}
