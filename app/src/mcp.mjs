// MCP server: tools and the approval policy. server.mjs creates one McpServer per
// session. ctx() reads policy and core live, so a panel change applies to the next call.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export const VERSION = '0.1.0';

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const DESTROY = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

// Which calls wait for the panel. Deletes and destructive commands keep waiting
// while writes and commands are auto-approved; autoApprove.destroy
// is what lifts that.
export function needsApproval(info, cfg) {
  if (info.kind === 'read') return false;
  if (info.kind === 'delete' || info.destructive) return !cfg.autoApprove?.destroy;
  if (info.kind === 'write') return !cfg.autoApprove?.write;
  if (info.kind === 'exec') return !cfg.autoApprove?.exec;
  return true;
}

const clip = (v, n = 300) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? s.slice(0, n) + '...' : s;
};

// Log fields; the panel reads its badges and snippets from these.
const fields = (info) => ({
  summary: info.summary, kind: info.kind, target: info.target, query: info.query,
  cwd: info.cwd || undefined, isNew: info.isNew, destructive: !!info.destructive,
});

export function createMcpServer(ctx, approvals) {
  const server = new McpServer({ name: 'claude-on-steroids', version: VERSION }, { capabilities: { tools: {} } });

  async function guarded(tool, args) {
    const { core, cfg } = ctx();
    const info = core.describe(tool, args);
    const t0 = Date.now();
    let decision = 'auto';
    // In read-only mode the core refuses a write tool, no panel involved.
    if (!cfg.readOnly && needsApproval(info, cfg)) {
      const r = await approvals.request(tool, args, info);
      if (!r.approved) {
        approvals.record({ t: new Date().toISOString(), tool, ...fields(info), decision: 'denied', reason: r.reason, ok: false, ms: Date.now() - t0 });
        return {
          content: [{ type: 'text', text: `The user did not approve this action: ${r.reason}. Do not retry the same call; ask the user what they want done instead.` }],
          isError: true,
        };
      }
      decision = 'approved';
    }
    const res = await core.run(tool, args);
    approvals.record({
      t: new Date().toISOString(), tool, ...fields(info), decision,
      ok: !!res.ok, ms: Date.now() - t0, result: clip(res.ok ? (res.output ?? res.path ?? res.dir ?? res.deleted ?? 'ok') : res.error),
    });
    // read_file returns its content as plain text, so the model never has to read
    // escaped text inside JSON.
    if (tool === 'read_file' && res.ok) {
      const head = `${res.path} (${res.size} bytes${res.truncated ? `, truncated from byte ${res.start}` : ''})`;
      return { content: [{ type: 'text', text: `${head}\n\n${res.content}` }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }], isError: !res.ok };
  }

  const tool = (name, title, description, inputSchema, annotations) =>
    server.registerTool(name, { title, description, inputSchema, annotations: { title, ...annotations } },
      async (args) => guarded(name, args || {}));

  const p = (d) => z.string().describe(d);

  tool('machine_info', 'Machine info',
    "Shows which computer this connector runs on, the approved root folders, and whether writing and shell commands are enabled. Call this first.",
    {}, READ);

  tool('list_dir', 'List folder',
    'Lists a folder inside the approved roots. Omit path to list the first approved root.',
    { path: p('Absolute folder path inside an approved root.').optional() }, READ);

  tool('read_file', 'Read file',
    'Reads a text file inside the approved roots. Large files are truncated; use offset/limit (bytes) to page.',
    {
      path: p('Absolute file path.'),
      offset: z.number().int().min(0).optional().describe('Start byte offset.'),
      limit: z.number().int().min(1).optional().describe('Maximum bytes to return.'),
    }, READ);

  tool('search', 'Search files',
    'Searches text in files under a folder (skips node_modules, .git, build outputs). Returns file, line and text.',
    {
      query: p('Text to find (or a regex when isRegex is true).'),
      path: p('Folder to search in. Omit for the first approved root.').optional(),
      isRegex: z.boolean().optional().describe('Treat query as a regular expression.'),
      glob: z.string().optional().describe('File name glob, e.g. "*.ts".'),
      maxHits: z.number().int().min(1).max(2000).optional().describe('Maximum hits (default 200).'),
    }, READ);

  tool('write_file', 'Write file',
    'Creates or overwrites a text file. Each write waits in the local panel unless auto-approve is on; edit_file fits small changes better.',
    { path: p('Absolute file path.'), content: p('Full new file content.') }, WRITE);

  tool('edit_file', 'Edit file',
    'Replaces an exact text snippet in a file (literal match). Waits in the local panel unless auto-approve is on. Read the file first, so find matches exactly.',
    {
      path: p('Absolute file path.'),
      find: p('Exact existing text to replace.'),
      replace: p('Replacement text.'),
      all: z.boolean().optional().describe('Replace every occurrence instead of the first.'),
    }, WRITE);

  tool('delete_file', 'Delete file',
    'Deletes a file or folder. Irreversible; asks in the local panel unless auto-approve covers deletes.',
    { path: p('Absolute path to delete.') }, DESTROY);

  tool('exec_command', 'Run command',
    'Runs a shell command (cmd.exe on Windows) in an approved folder, as your normal user, and returns the output. It waits in the local panel; deletes and destructive commands keep asking, unless auto-approve covers those too.',
    {
      command: p('Command line to run.'),
      cwd: p('Working folder inside an approved root. Omit for the first approved root.').optional(),
      timeoutMs: z.number().int().min(1000).max(900000).optional().describe('Timeout in ms (default 120000).'),
    }, DESTROY);

  return server;
}
