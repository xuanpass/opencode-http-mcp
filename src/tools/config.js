/**
 * Tool group: config (upstream src/tools/config.ts, 3 tools)
 * 2.x routes:
 *   GET /api/config            200
 *   PATCH /api/config          200
 *   GET /api/config/providers  NO route on 2.0.30 -> honest no-route stub
 */
'use strict';
const { toolResult, toolJson, toolError, redactSecrets, directoryParam } = require('../helpers.js');
const { dir, req } = require('../util.js');

function formatConfig(raw) {
  const c = redactSecrets(raw) || {};
  const lines = [];
  for (const [k, v] of Object.entries(c)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const keys = Object.keys(v);
      if (keys.length <= 5) {
        const inner = Object.entries(v)
          .map(([sk, sv]) => (sv && typeof sv === 'object' ? `${sk}: {..}` : `${sk}: ${sv}`))
          .join(', ');
        lines.push(`${k}: { ${inner} }`);
      } else {
        lines.push(`${k}: {${keys.length} entries}`);
      }
    } else if (Array.isArray(v)) {
      lines.push(`${k}: ${v.length <= 3 ? JSON.stringify(v) : `[${v.length} items]`}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
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
