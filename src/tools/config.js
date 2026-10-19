/**
 * Tool group: config (upstream src/tools/config.ts, 3 tools)
 * 2.x routes:
 *   GET /api/config            200 — a BARE ARRAY of {type,path,info} rows
 *   PATCH /api/config          200
 *   GET /api/config/providers  NO route on 2.x -> honest no-route stub
 */
'use strict';
const { toolResult, toolJson, toolError, redactSecrets, directoryParam } = require('../helpers.js');
const { dir, req } = require('../util.js');

function formatConfigEntry(key, v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const keys = Object.keys(v);
    if (keys.length <= 5) {
      const inner = Object.entries(v)
        .map(([sk, sv]) => (sv && typeof sv === 'object' ? `${sk}: {..}` : `${sk}: ${sv}`))
        .join(', ');
      return `${key}: { ${inner} }`;
    }
    return `${key}: {${keys.length} entries}`;
  }
  if (Array.isArray(v)) {
    return `${key}: ${v.length <= 3 ? JSON.stringify(v) : `[${v.length} items]`}`;
  }
  return `${key}: ${v}`;
}

function formatConfig(raw) {
  // 2.x /api/config returns a BARE ARRAY of {type,path,info} rows (no
  // {data} envelope); 1.x returned a single config object. Render both.
  const c = redactSecrets(raw);
  const lines = [];
  if (Array.isArray(c)) {
    for (const entry of c) {
      if (!entry || typeof entry !== 'object') { lines.push(`- ${entry}`); continue; }
      const type = entry.type ?? 'entry';
      const path = entry.path ?? entry.id ?? '?';
      const info = entry.info;
      if (info && typeof info === 'object') {
        const keys = Object.keys(info);
        lines.push(`- [${type}] ${path}${keys.length ? ` — ${keys.length} key${keys.length === 1 ? '' : 's'}: ${keys.slice(0, 6).join(', ')}${keys.length > 6 ? ', …' : ''}` : ''}`);
      } else {
        lines.push(`- [${type}] ${path}`);
      }
    }
    return `## OpenCode Config (${c.length} source${c.length === 1 ? '' : 's'})\n${lines.join('\n')}\n\nUse \`opencode_config_update\` to modify specific settings.`;
  }
  const obj = c || {};
  for (const [k, v] of Object.entries(obj)) lines.push(formatConfigEntry(k, v));
  return `## OpenCode Config\n${lines.join('\n')}\n\nUse \`opencode_config_update\` to modify specific settings.`;
}

function register(registry, ctx) {
  const { client } = ctx;
  const R = (name, desc, schema, fn) => registry.tool(name, desc, { inputSchema: schema, run: fn });

  R('opencode_config_get', 'Get the current opencode configuration.', {
    type: 'object', properties: { directory: directoryParam },
  }, async (a) => {
    try {
      const config = await client.get('/api/config', undefined, dir(a));
      return toolResult(formatConfig(config));
    } catch (e) { return toolError(e); }
  });

  R('opencode_config_update', 'Update the opencode configuration. Pass a partial config object.', {
    type: 'object',
    properties: {
      config: { type: 'object', description: 'Partial config object with fields to update' },
      directory: directoryParam,
    },
    required: ['config'],
  }, async (a) => {
    try {
      const updated = await client.patch('/api/config', a.config, req(a));
      return toolJson(redactSecrets(updated));
    } catch (e) { return toolError(e); }
  });

  R('opencode_config_providers', 'List configured providers and their default models.', {
    type: 'object', properties: { directory: directoryParam },
  }, async () => toolResult(
    'opencode_config_providers: this endpoint is not available on this OpenCode server (2.x build lacks /api/config/providers). Use `opencode_provider_list` instead.',
    true,
  ));
}

module.exports = { register };
