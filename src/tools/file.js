/**
 * Tool group: file (upstream src/tools/file.ts, 6 tools)
 *
 * Route pinning (live-verified on OpenCode 2.0.30 @ 192.168.123.101):
 *   - /api/fs/list     200 (dir listing; pass ?path= to target a subdir)
 *   - /api/fs/read/*   200 (file content; path is appended as a path segment)
 *   - /api/fs/find     NO route on 2.0.30 -> find_* are honest no-route stubs
 * The old 1.x routes (/find, /find/file, /find/symbol, /file, /file/content,
 * /file/status) are all 404 on 2.0.30, so text/symbol search is not available
 * through the server on this build; we return a clear message instead of 404s.
 */
'use strict';
const { toolResult, toolError } = require('../helpers.js');
const { dir } = require('../util.js');

function dataOr(r) {
  if (Array.isArray(r)) return r;
  if (r && typeof r === 'object' && 'data' in r) return r.data || [];
  return [];
}

function noRoute(name, hint) {
  return toolResult(
    `${name}: this endpoint is not available on this OpenCode server (2.x build lacks the /api/fs/find route). ${hint || 'Try opencode_session tools or a live provider instead.'}`,
    true,
  );
}

function register(registry, ctx) {
  const { client } = ctx;
  const R = (name, desc, schema, fn) => registry.tool(name, desc, { inputSchema: schema, run: fn });

  R('opencode_find_text', 'Search text patterns in project files. NOTE: 2.x server has no /api/fs/find route, so this reports unavailable.', {
    type: 'object', properties: { pattern: { type: 'string' }, directory: { type: 'string' } }, required: ['pattern'],
  }, async () => noRoute('opencode_find_text'));

  R('opencode_find_file', 'Find files/directories by name. NOTE: 2.x server has no /api/fs/find route, so this reports unavailable.', {
    type: 'object',
    properties: {
      query: { type: 'string' }, type: { type: 'string', enum: ['file', 'directory'] },
      searchDirectory: { type: 'string' }, limit: { type: 'number' }, directory: { type: 'string' },
    },
    required: ['query'],
  }, async () => noRoute('opencode_find_file'));

  R('opencode_find_symbol', 'Find workspace symbols by name. NOTE: 2.x server has no /api/fs/find route, so this reports unavailable.', {
    type: 'object', properties: { query: { type: 'string' }, directory: { type: 'string' } }, required: ['query'],
  }, async () => noRoute('opencode_find_symbol'));

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
