/**
 * Tool group: misc (upstream src/tools/misc.ts, 12 tools)
 * 2.x routes (live-verified on 2.0.31):
 *   GET /api/vcs            200 — `{"data":{"branch":{}}}` outside a worktree
 *   GET /api/vcs/status     200 — `{"data":[]}`
 *   GET /api/agent          200 — rows carry both id and name
 *   GET /api/command        200
 *   GET /api/mcp            200 — rows carry a NESTED status object
 *   GET /api/skill          200
 *   POST /api/mcp           add (best-effort)
 *   /api/path, /api/lsp, /api/formatter, /api/experimental/tool,
 *   /api/log, /api/instance/dispose  -> NO route on 2.x (404)
 */
'use strict';
const { toolResult, toolJson, toolError, displayScalar, directoryParam } = require('../helpers.js');
const { dir, req } = require('../util.js');

function dataOr(r) {
  if (Array.isArray(r)) return r;
  if (r && typeof r === 'object' && 'data' in r) return r.data || [];
  return [];
}

function register(registry, ctx) {
  const { client } = ctx;
  const R = (name, desc, schema, fn) => registry.tool(name, desc, { inputSchema: schema, run: fn });

  R('opencode_vcs_info', 'Get VCS (version control) info for the current project.', {
    type: 'object', properties: { directory: directoryParam },
  }, async (a) => {
    try {
      const v = await client.get('/api/vcs', undefined, dir(a));
      if (!v || typeof v !== 'object') return toolResult('No VCS info available.');
      const lines = [];
      for (const k of ['branch', 'remote', 'sha', 'type']) {
        const val = displayScalar(v[k]);
        if (val) lines.push(`${k === 'sha' ? 'HEAD' : k[0].toUpperCase() + k.slice(1)}: ${val}`);
      }
      if (v.dirty !== undefined) lines.push(`Dirty: ${v.dirty}`);
      if (v.ahead !== undefined) lines.push(`Ahead: ${v.ahead}`);
      if (v.behind !== undefined) lines.push(`Behind: ${v.behind}`);
      if (!lines.length) {
        // 2.x returns {"branch":{}} for a non-worktree directory — surface
        // that honestly instead of an empty "## VCS Info" header.
        if (v.branch && typeof v.branch === 'object') {
          lines.push('No git worktree at this directory (branch is empty).');
        }
        for (const [k, val] of Object.entries(v)) {
          if (k === 'branch') continue;
          const d = displayScalar(val);
          if (d) lines.push(`${k}: ${d}`);
        }
      }
      return toolResult(`## VCS Info\n${lines.join('\n')}`, false, { data: v });
    } catch (e) { return toolError(e); }
  });

  R('opencode_agent_list', 'List all available agents with names, descriptions, and modes.', {
    type: 'object', properties: { directory: directoryParam },
  }, async (a) => {
    try {
      const agents = dataOr(await client.get('/api/agent', undefined, dir(a)));
      if (!agents.length) return toolResult('No agents found.');
      const formatted = agents.map((ag) => {
        // 2.x carries BOTH id ("build") and name ("Build"); the id is what
        // every other tool takes as a parameter, so lead with it.
        const name = ag.id ?? ag.name ?? '?';
        const label = ag.name && ag.name !== name ? ` (${ag.name})` : '';
        const hidden = ag.hidden === true ? ' [hidden]' : '';
        return `- ${name}${label}${hidden} [${ag.mode ?? '?'}]: ${ag.description ?? '(no description)'}`;
      }).join('\n');
      return toolResult(formatted, false, { data: agents });
    } catch (e) { return toolError(e); }
  });

  R('opencode_command_list', 'List all available slash commands.', {
    type: 'object', properties: { directory: directoryParam },
  }, async (a) => {
    try {
      const commands = dataOr(await client.get('/api/command', undefined, dir(a)));
      if (!commands.length) return toolResult('No commands available.');
      const lines = commands.map((c) => {
        const name = c.name ?? c.id ?? '?';
        const desc = String(c.description ?? c.desc ?? '').split('\n')[0].slice(0, 120);
        return `- /${name}${desc ? `: ${desc}` : ''}`;
      });
      return toolResult(`## Commands (${commands.length})\n${lines.join('\n')}`, false, { data: commands });
    } catch (e) { return toolError(e); }
  });

  R('opencode_mcp_status', 'Get the status of all MCP servers configured in opencode.', {
    type: 'object', properties: { directory: directoryParam },
  }, async (a) => {
    try {
      const raw = await client.get('/api/mcp', undefined, dir(a));
      const servers = dataOr(raw);
      if (!servers.length) return toolResult('No MCP servers configured.');
      // 2.x nests the state: {"name":"mx-ds-mcp","status":{"status":"connected"}}
      const lines = servers.map((s) => {
        const name = s.name ?? s.id ?? '?';
        // s.status is itself an object whose own `status` field holds the
        // human-readable state; unwrap both layers before rendering.
        const st = s.status && typeof s.status === 'object' ? s.status.status : s.status;
        const state = displayScalar(st) ?? displayScalar(s.state) ?? 'unknown';
        return `- ${name}: ${state}`;
      });
      return toolResult(`## MCP Servers (${servers.length})\n${lines.join('\n')}`, false, { data: servers });
    } catch (e) { return toolError(e); }
  });

  R('opencode_mcp_add', 'Add an MCP server dynamically to opencode.', {
    type: 'object',
    properties: {
      name: { type: 'string' },
      config: { type: 'object' },
      directory: directoryParam,
    },
    required: ['name', 'config'],
  }, async (a) => {
    try {
      const res = await client.post('/api/mcp', { name: a.name, config: a.config }, req(a));
      return toolJson(res);
    } catch (e) { return toolError(e); }
  });

  R('opencode_skill_list', 'List available skills registered with opencode.', {
    type: 'object', properties: { directory: directoryParam },
  }, async (a) => {
    try {
      const skills = dataOr(await client.get('/api/skill', undefined, dir(a)));
      if (!skills.length) return toolResult('No skills found.');
      const lines = skills.map((s) => `- ${s.id ?? s.name ?? '?'}: ${s.description ?? ''}`.trim());
      return toolResult(`## Skills (${skills.length})\n${lines.join('\n')}`, false, { data: skills });
    } catch (e) { return toolError(e); }
  });

  R('opencode_integration_list', 'List registered integrations (plugins) on the server.', {
    type: 'object', properties: { directory: directoryParam },
  }, async (a) => {
    try {
      const items = dataOr(await client.get('/api/integration', undefined, dir(a)));
      if (!items.length) return toolResult('No integrations found.');
      const lines = items.map((x) => {
        const name = x.name ?? x.id ?? '?';
        // 2.x: {"id":"302ai","methods":[{"type":"key"},{"type":"env","names":["302AI_API_KEY"]}]}
        const methods = Array.isArray(x.methods) ? x.methods.map(displayScalar).filter(Boolean).join(', ') : '';
        const connections = Array.isArray(x.connections) ? x.connections.length : 0;
        const extra = [methods ? `methods: ${methods}` : '', connections ? `${connections} connection${connections === 1 ? '' : 's'}` : '']
          .filter(Boolean).join(' · ');
        return `- ${name}${extra ? ` (${extra})` : ''}`;
      });
      return toolResult(`## Integrations (${items.length})\n${lines.join('\n')}`, false, { data: items });
    } catch (e) { return toolError(e); }
  });

  R('opencode_reference_list', 'List reference files/resources available to opencode.', {
    type: 'object', properties: { directory: directoryParam },
  }, async (a) => {
    try {
      const items = dataOr(await client.get('/api/reference', undefined, dir(a)));
      if (!items.length) return toolResult('No references found.');
      const lines = items.map((x) => `- ${x.name ?? x.id ?? x.path ?? '?'}`);
      return toolResult(`## References (${items.length})\n${lines.join('\n')}`, false, { data: items });
    } catch (e) { return toolError(e); }
  });

  R('opencode_pty_list', 'List open pseudo-terminals managed by opencode.', {
    type: 'object', properties: { directory: directoryParam },
  }, async (a) => {
    try {
      const items = dataOr(await client.get('/api/pty', undefined, dir(a)));
      if (!items.length) return toolResult('No open PTYs.');
      const lines = items.map((x) => `- ${x.name ?? x.title ?? x.id ?? '?'}${x.status ? `: ${x.status}` : ''}`);
      return toolResult(`## PTYs (${items.length})\n${lines.join('\n')}`, false, { data: items });
    } catch (e) { return toolError(e); }
  });

  // --- LSP / Formatter / experimental tools (upstream misc.ts) ---
  // 2.0.31 has no /api/lsp, /api/formatter, /api/experimental/tool* routes;
  // register honest no-route fallbacks so the tool surface matches upstream.

  R('opencode_lsp_status', 'Get the status of LSP (Language Server Protocol) servers.', {
    type: 'object', properties: { directory: directoryParam },
  }, async () => toolResult(
    'opencode_lsp_status: /api/lsp is not available on this OpenCode server (2.x build).',
    true,
  ));

  R('opencode_formatter_status', 'Get the status of configured formatters.', {
    type: 'object', properties: { directory: directoryParam },
  }, async () => toolResult(
    'opencode_formatter_status: /api/formatter is not available on this OpenCode server (2.x build).',
    true,
  ));

  R('opencode_tool_ids', 'List all available tool IDs that the LLM can use (experimental).', {
    type: 'object', properties: { directory: directoryParam },
  }, async () => toolResult(
    'opencode_tool_ids: /api/experimental/tool/ids is not available on this OpenCode server (2.x build).',
    true,
  ));

  R('opencode_tool_list', 'List tools with JSON schemas for a given provider and model (experimental).', {
    type: 'object',
    properties: {
      provider: { type: 'string', description: 'Provider ID' },
      model: { type: 'string', description: 'Model ID' },
      directory: directoryParam,
    },
    required: ['provider', 'model'],
  }, async () => toolResult(
    'opencode_tool_list: /api/experimental/tool is not available on this OpenCode server (2.x build).',
    true,
  ));

  R('opencode_path_get', 'Get the current working path of the opencode server.', {
    type: 'object', properties: { directory: directoryParam },
  }, async () => toolResult(
    'opencode_path_get: /api/path is not available on this OpenCode server (2.x build). Use `opencode_project_list` or `opencode_project_current` for project paths.',
    true,
  ));

  R('opencode_instance_dispose', 'Dispose the current opencode instance (shuts it down).', {
    type: 'object', properties: { directory: directoryParam },
  }, async () => toolResult(
    'opencode_instance_dispose: /api/instance/dispose is not available on this OpenCode server (2.x build).',
    true,
  ));

  R('opencode_log', 'Write a log entry to the opencode server.', {
    type: 'object',
    properties: {
      service: { type: 'string' },
      level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] },
      message: { type: 'string' },
      extra: { type: 'object' },
      directory: directoryParam,
    },
    required: ['service', 'level', 'message'],
  }, async () => toolResult(
    'opencode_log: /api/log is not available on this OpenCode server (2.x build).',
    true,
  ));
}

module.exports = { register };
