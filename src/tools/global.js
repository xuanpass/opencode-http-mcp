/**
 * Tool group: global (upstream src/tools/global.ts, 1 tool)
 * 2.x route: /global/health (verified 200; /api/health is 404).
 */
'use strict';
const { toolResult, toolError, directoryParam } = require('../helpers.js');
const { dir } = require('../util.js');

function register(registry, ctx) {
  const { client } = ctx;
  registry.tool('opencode_health', 'Check server health and version.', {
    inputSchema: { type: 'object', properties: { directory: directoryParam } },
    run: async (a) => {
      try {
        const raw = await client.get('/global/health', undefined, dir(a));
        // 2.x may return JSON { healthy, version } or an SPA HTML fallback
        // (200 but not parseable). Treat a 200 response as "reachable".
        const status = (raw && typeof raw === 'object' && raw.healthy === false) ? 'unhealthy' : 'reachable';
        const version = (raw && raw.version) ? String(raw.version) : 'unknown';
        return toolResult(`Status: ${status}\nVersion: ${version}`, false, { data: raw });
      } catch (e) { return toolError(e); }
    },
  });
}

module.exports = { register };
