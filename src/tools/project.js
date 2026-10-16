/**
 * Tool group: project (upstream src/tools/project.ts, 3 tools)
 * 2.x routes (live-verified on 2.0.30):
 *   GET /api/project             200 (list)
 *   GET /api/project/current     NO route on 2.0.30 -> honest stub
 * `opencode_project_init` operates on the local filesystem of the MCP host
 * (creates the directory) and then pings the server — kept for parity.
 */
'use strict';
const fsPromises = require('fs/promises');
const { realpathSync } = require('fs');
const pathUtil = require('path');
const { toolResult, toolJson, toolError, directoryParam } = require('../helpers.js');
const { dir } = require('../util.js');

const FORBIDDEN = [
  '/', '/etc', '/usr', '/bin', '/sbin', '/sys', '/proc', '/dev',
  ...(process.platform === 'win32'
    ? [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)
    : []),
];

function pathKey(value) {
  const normalized = pathUtil.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isForbiddenRoot(p) {
  const key = pathKey(p);
  if (key === pathKey(pathUtil.parse(p).root)) return true;
  return FORBIDDEN.some((root) => {
    const r = pathKey(root);
    return key === r || key.startsWith(r + pathUtil.sep);
  });
}

function formatProject(p) {
  const worktree = (p && p.worktree) || 'unknown';
  const name = (worktree !== 'unknown' ? worktree.split('/').filter(Boolean).pop() : undefined)
    || (p && (p.name ?? p.id)) || 'unknown';
  const lines = [`Name: ${name}`, `Path: ${worktree}`];
  if (p && p.vcs) lines.push(`VCS: ${p.vcs}`);
  if (p && p.id) lines.push(`ID: ${p.id}`);
  return lines.join('\n');
}

function register(registry, ctx) {
  const { client } = ctx;
  const R = (name, desc, schema, fn) => registry.tool(name, desc, { inputSchema: schema, run: fn });

  R('opencode_project_list', 'List all projects known to the opencode server.', {
    type: 'object', properties: { directory: directoryParam },
  }, async (a) => {
    try {
      const raw = await client.get('/api/project', undefined, dir(a));
      const projects = Array.isArray(raw) ? raw : (raw?.data || []);
      if (!projects.length) return toolResult('No projects found.');
      const lines = projects.map((p) => {
        const worktree = p.worktree ?? '?';
        const name = (worktree !== '?' ? worktree.split('/').filter(Boolean).pop() : undefined) ?? p.name ?? p.id ?? '(root)';
        return `- ${name}: ${worktree}${p.vcs ? ` [${p.vcs}]` : ''}`;
      });
      return toolResult(`## Projects (${projects.length})\n${lines.join('\n')}`, false, { data: projects });
    } catch (e) { return toolError(e); }
  });

  R('opencode_project_init', 'Create or open a project directory on the MCP host for an isolated OpenCode session.', {
    type: 'object',
    properties: { path: { type: 'string', description: 'Absolute path to create/open' } },
    required: ['path'],
  }, async (a) => {
    try {
      const p = String(a.path || '');
      if (/[\0\r\n]/.test(p)) throw new Error('path must not contain NUL or CR/LF characters');
      if (!pathUtil.isAbsolute(p)) throw new Error(`path must be an absolute path: ${p}`);
      const resolved = pathUtil.resolve(p);
      if (isForbiddenRoot(resolved)) throw new Error(`System directories are not allowed: ${resolved}`);
      await fsPromises.mkdir(resolved, { recursive: true });
      const real = await fsPromises.realpath(resolved);
      if (isForbiddenRoot(real)) throw new Error(`System directories are not allowed (resolved via symlink to: ${real})`);
      const st = await fsPromises.stat(real);
      if (!st.isDirectory()) throw new Error(`Target exists but is not a directory: ${real}`);
      // Best-effort server ping (route may not exist on some builds).
      try { await client.get('/api/project/current', undefined, real); } catch { /* ignore */ }
      return toolResult(
        `Successfully initialized project directory at: ${real}\n\nUse this path as the \`directory\` parameter in \`opencode_ask\`, \`opencode_run\`, or \`opencode_session_create\`.`,
      );
    } catch (e) { return toolError(e); }
  });

  R('opencode_project_current', 'Get the current active project.', {
    type: 'object', properties: { directory: directoryParam },
  }, async (a) => {
    try {
      const raw = await client.get('/api/project/current', undefined, dir(a));
      return toolResult(formatProject(raw), false, { data: raw });
    } catch (e) {
      return toolResult(
        `opencode_project_current: /api/project/current is not available on this OpenCode server (2.x build). ` +
        `Use \`opencode_project_list\` to see all projects.`,
        true,
      );
    }
  });
}

module.exports = { register };
