// MCP server: the tools and their call log. server.mjs creates one McpServer per session.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export const VERSION = '0.1.0';

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const DESTROY = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

const clip = (v, n = 300) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? s.slice(0, n) + '...' : s;
};

export function createMcpServer(core, log) {
  const server = new McpServer({ name: 'claude-on-steroids', version: VERSION }, { capabilities: { tools: {} } });

  async function call(tool, args) {
    const info = core.describe(tool, args);
    const t0 = Date.now();
    const res = await core.run(tool, args);
    log.record({
      t: new Date().toISOString(), tool, ...info,
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
      async (args) => call(name, args || {}));

  const p = (d) => z.string().describe(d);

  tool('machine_info', 'Machine info',
    "Shows which computer this connector runs on, its shell and the home folder that relative paths start from. Call this first.",
    {}, READ);

  tool('list_dir', 'List folder',
    'Lists a folder. Omit path to list the home folder.',
    { path: p('Folder path, absolute or relative to the home folder.').optional() }, READ);

  tool('read_file', 'Read file',
    'Reads a text file. Large files are truncated; use offset/limit (bytes) to page.',
    {
      path: p('Absolute file path.'),
      offset: z.number().int().min(0).optional().describe('Start byte offset.'),
      limit: z.number().int().min(1).optional().describe('Maximum bytes to return.'),
    }, READ);

  tool('search', 'Search files',
    'Searches text in files under a folder (skips node_modules, .git, build outputs). Returns file, line and text.',
    {
      query: p('Text to find (or a regex when isRegex is true).'),
      path: p('Folder to search in. Omit for the home folder.').optional(),
      isRegex: z.boolean().optional().describe('Treat query as a regular expression.'),
      glob: z.string().optional().describe('File name glob, e.g. "*.ts".'),
      maxHits: z.number().int().min(1).max(2000).optional().describe('Maximum hits (default 200).'),
    }, READ);

  tool('write_file', 'Write file',
    'Creates or overwrites a text file. edit_file fits small changes better.',
    { path: p('Absolute file path.'), content: p('Full new file content.') }, WRITE);

  tool('edit_file', 'Edit file',
    'Replaces an exact text snippet in a file (literal match). Read the file first, so find matches exactly.',
    {
      path: p('Absolute file path.'),
      find: p('Exact existing text to replace.'),
      replace: p('Replacement text.'),
      all: z.boolean().optional().describe('Replace every occurrence instead of the first.'),
    }, WRITE);

  tool('delete_file', 'Delete file',
    'Deletes a file or folder. Irreversible.',
    { path: p('Absolute path to delete.') }, DESTROY);

  tool('exec_command', 'Run command',
    'Runs a shell command (cmd.exe on Windows) as your normal user and returns the output.',
    {
      command: p('Command line to run.'),
      cwd: p('Working folder. Omit for the home folder.').optional(),
      timeoutMs: z.number().int().min(1000).max(900000).optional().describe('Timeout in ms (default 120000).'),
    }, DESTROY);

  return server;
}
