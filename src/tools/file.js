/**
 * Tool group: file (upstream src/tools/file.ts, 6 tools)
 *
 * Route pinning (live-verified on OpenCode 2.0.31 @ 192.168.123.101:49374):
 *   - /api/fs/list     200 (dir listing; pass ?path= to target a subdir)
 *   - /api/fs/read/*   200 (file content; path is appended as a path segment)
 *   - /api/fs/find     200 — params: query (required), type=file|directory,
 *                       limit. `offset`, `directory` and `searchDirectory` are
 *                       ignored by the server (returns the whole root search).
 *                       Empty query -> {"data":[]}.
 * The old 1.x routes (/find, /find/file, /find/symbol, /file, /file/content,
 * /file/status) are all 404 on 2.x.
 */
'use strict';
const { toolResult, toolError } = require('../helpers.js');
const { dir } = require('../util.js');

function dataOr(r) {
  if (Array.isArray(r)) return r;
  if (r && typeof r === 'object' && 'data' in r) return r.data || [];
  return [];
}

function register(registry, ctx) {
  const { client } = ctx;
  const R = (name, desc, schema, fn) => registry.tool(name, desc, { inputSchema: schema, run: fn });

  /**
   * Shared implementation of the three find_* tools. `kind` maps to the
   * server's `type` filter (file | directory); it is omitted when the caller
   * wants both, and `query` doubles as a filename/substring match.
   */
  async function find(a, kind) {
    try {
      const q = a.query ?? a.pattern;
      if (!q || !String(q).trim()) {
        return toolResult('Provide a non-empty `query` (or `pattern`).', true);
      }
      const params = { query: String(q) };
      if (kind) params.type = kind;
      if (a.limit !== undefined) params.limit = a.limit;
      const raw = await client.get('/api/fs/find', params, dir(a));
      const nodes = dataOr(raw);
      if (!nodes.length) return toolResult(`No matches for "${q}".`);
      const maxItems = a.limit === 0 ? nodes.length : (a.limit ?? 30);
      const shown = nodes.slice(0, maxItems);
      const lines = shown.map((n) => {
        const path = n.path ?? n.name ?? JSON.stringify(n);
        return `- ${n.type === 'directory' ? '[DIR] ' : ''}${path}`;
      });
      const trunc = nodes.length > maxItems ? `\n\n... and ${nodes.length - maxItems} more. Use \`limit: 0\` to see all.` : '';
      return toolResult(
        `## ${nodes.length} match${nodes.length !== 1 ? 'es' : ''} for "${q}"\n${lines.join('\n')}${trunc}`,
        false, { data: shown });
    } catch (e) { return toolError(e); }
  }

  R('opencode_find_text', 'Search text patterns in project files (via /api/fs/find).', {
    type: 'object', properties: { pattern: { type: 'string' }, limit: { type: 'number' }, directory: { type: 'string' } }, required: ['pattern'],
  }, (a) => find(a, null));

  R('opencode_find_file', 'Find files/directories by name (via /api/fs/find).', {
    type: 'object',
    properties: {
      query: { type: 'string' }, type: { type: 'string', enum: ['file', 'directory'] },
      searchDirectory: { type: 'string', description: 'Ignored by the 2.x server: the search always covers the whole project root.' },
      limit: { type: 'number' }, directory: { type: 'string' },
    },
    required: ['query'],
  }, (a) => find(a, a.type));

  R('opencode_find_symbol', 'Find workspace symbols by name (via /api/fs/find, filename match).', {
    type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' }, directory: { type: 'string' } }, required: ['query'],
  }, (a) => find(a, null));

  R('opencode_file_list', 'List files and directories at a path (via /api/fs/list).', {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path to list (defaults to project root)' }, directory: { type: 'string' } },
  }, async (a) => {
    try {
      const query = a.path ? { path: a.path } : {};
      const raw = await client.get('/api/fs/list', query, dir(a));
      const nodes = dataOr(raw);
      if (!nodes.length) return toolResult('Empty directory.');
      const formatted = nodes.map((n) => {
        const type = n.type === 'directory' ? '[DIR]' : '     ';
        return `${type} ${n.name ?? n.path ?? '?'}`;
      }).join('\n');
      return toolResult(formatted, false, { data: nodes });
    } catch (e) { return toolError(e); }
  });

  R('opencode_file_read', 'Read the content of a file (via /api/fs/read/{path}).', {
    type: 'object',
    properties: { path: { type: 'string', description: 'File path to read' }, directory: { type: 'string' } },
    required: ['path'],
  }, async (a) => {
    try {
      const p = String(a.path || '').replace(/^\/+/, '');
      const raw = await client.get(`/api/fs/read/${p}`, undefined, dir(a));
      const content = typeof raw === 'string' ? raw : (raw?.content != null ? String(raw.content) : JSON.stringify(raw, null, 2));
      return toolResult(`File: ${a.path}\n\n${content}`, false, { data: raw });
    } catch (e) { return toolError(e); }
  });

  R('opencode_file_status', 'Get VCS status for tracked files (via /api/vcs/status).', {
    type: 'object', properties: { directory: { type: 'string' } },
  }, async (a) => {
    try {
      const raw = await client.get('/api/vcs/status', undefined, dir(a));
      const files = dataOr(raw);
      if (!files.length) return toolResult('No tracked file changes.');
      const formatted = files.map((f) => `[${f.status ?? f.type ?? '?'}] ${f.path ?? f.file ?? '?'}`).join('\n');
      return toolResult(formatted, false, { data: files });
    } catch (e) { return toolError(e); }
  });
}

module.exports = { register };
