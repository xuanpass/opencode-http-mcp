/**
 * Tool group: provider (upstream src/tools/provider.ts, 6 tools)
 * 2.x routes (live-verified on 2.0.30):
 *   GET  /api/provider            200
 *   GET  /api/provider/{id}       200
 *   GET  /api/model               200
 *   GET  /api/provider/auth       404 -> honest stub
 *   POST /api/provider/{id}/oauth/*  404 -> honest stubs
 *   PUT  /api/auth/{id}           404 -> honest stub
 */
'use strict';
const { toolResult, toolJson, toolError, isProviderConfigured, directoryParam } = require('../helpers.js');
const { dir } = require('../util.js');

function providersOf(raw) {
  if (raw && typeof raw === 'object' && 'all' in raw) return raw.all;
  return raw;
}

function countModels(p) {
  const m = p && p.models;
  if (Array.isArray(m)) return m.length;
  if (m && typeof m === 'object') return Object.keys(m).length;
  return 0;
}

function register(registry, ctx) {
  const { client } = ctx;
  const R = (name, desc, schema, fn) => registry.tool(name, desc, { inputSchema: schema, run: fn });

  R('opencode_provider_list', 'List all configured providers with connection status.', {
    type: 'object', properties: { directory: directoryParam },
  }, async (a) => {
    try {
      const raw = await client.get('/api/provider', undefined, dir(a));
      const providers = providersOf(raw);
      if (!Array.isArray(providers) || providers.length === 0) return toolResult('No providers configured.');
      const configured = providers.filter(isProviderConfigured);
      const unconfigured = providers.filter((p) => !isProviderConfigured(p));
      const lines = [];
      if (configured.length) {
        lines.push('**Configured:**');
        for (const p of configured) {
          const id = p.id ?? p.name ?? '?';
          const env = Array.isArray(p.env) ? ` (via ${p.env.join(', ')})` : '';
          lines.push(`- ${id}: ${countModels(p)} model${countModels(p) !== 1 ? 's' : ''}${env}`);
        }
      } else {
        lines.push('**No providers configured.** Use `opencode_auth_set` or set environment variables.');
      }
      if (unconfigured.length) {
        lines.push(`\n**Not configured:** ${unconfigured.length} more providers available`);
      }
      return toolResult(`## Providers (${configured.length} configured / ${providers.length} total)\n${lines.join('\n')}\n\nUse \`opencode_provider_models\` with a provider ID to see its models.`);
    } catch (e) { return toolError(e); }
  });

  R('opencode_provider_models', 'List available models for a specific provider.', {
    type: 'object',
    properties: {
      providerId: { type: 'string' },
      limit: { type: 'number', description: 'Max models to show (default 30). 0 = all.' },
      directory: directoryParam,
    },
    required: ['providerId'],
  }, async (a) => {
    try {
      // Prefer the dedicated model listing route, which returns modelIDs directly.
      const models = await client.get('/api/model', undefined, dir(a));
      const arr = Array.isArray(models) ? models : (models?.data || []);
      const forProv = arr.filter((m) => m.providerID === a.providerId || m.provider === a.providerId);
      const pool = forProv.length ? forProv : arr;
      if (!pool.length) {
        return toolResult(`Provider "${a.providerId}" not found. Use \`opencode_provider_list\` to see all providers.`, true);
      }
      const maxItems = a.limit === 0 ? pool.length : (a.limit ?? 30);
      const shown = pool.slice(0, maxItems);
      const lines = shown.map((m) => {
        const id = m.id ?? m.modelID ?? m.name ?? '?';
        const name = m.name && m.name !== id ? ` — ${m.name}` : '';
        return `- ${id}${name}`;
      });
      const trunc = pool.length > maxItems ? `\n\n... and ${pool.length - maxItems} more. Use \`limit: 0\` to see all.` : '';
      return toolResult(`## ${a.providerId} — ${pool.length} model${pool.length !== 1 ? 's' : ''}\n${lines.join('\n')}${trunc}`, false, { data: shown });
    } catch (e) { return toolError(e); }
  });

  R('opencode_provider_auth_methods', 'Get available authentication methods for all providers.', {
    type: 'object', properties: { directory: directoryParam },
  }, async () => toolResult(
    'opencode_provider_auth_methods: this endpoint is not available on this OpenCode server (2.x build lacks /api/provider/auth). Configure providers via API key or environment variables instead.',
    true,
  ));

  R('opencode_provider_oauth_authorize', 'Start OAuth authorization for a provider.', {
    type: 'object',
    properties: {
      providerId: { type: 'string' },
      method: { type: 'number' },
      inputs: { type: 'object' },
    },
    required: ['providerId'],
  }, async () => toolResult(
    'opencode_provider_oauth_authorize: OAuth authorization routes are not available on this OpenCode server (2.x build lacks /api/provider/{id}/oauth/*). Use `opencode_auth_set` or environment variables instead.',
    true,
  ));

  R('opencode_provider_oauth_callback', 'Handle OAuth callback for a provider.', {
    type: 'object',
    properties: {
      providerId: { type: 'string' },
      callbackData: { type: 'object' },
    },
    required: ['providerId'],
  }, async () => toolResult(
    'opencode_provider_oauth_callback: OAuth callback routes are not available on this OpenCode server. Use `opencode_auth_set` or environment variables instead.',
    true,
  ));

  R('opencode_auth_set', 'Set authentication credentials for a provider (API key).', {
    type: 'object',
    properties: {
      providerId: { type: 'string' },
      type: { type: 'string' },
      key: { type: 'string' },
    },
    required: ['providerId', 'type', 'key'],
  }, async (a) => {
    // /api/auth/{id} is not present on 2.0.30; still surface the intent and
    // fall back to /api/provider auth if available, else report unavailable.
    try {
      const res = await client.put(`/api/auth/${encodeURIComponent(a.providerId)}`, { type: a.type, key: a.key });
      return toolResult(`Auth credentials set for ${a.providerId}.`, false, { data: res });
    } catch (e) {
      return toolResult(
        `opencode_auth_set: PUT /api/auth/${a.providerId} unavailable on this OpenCode server (2.x build). ` +
        `Set the provider API key via environment variable and restart opencode instead. Detail: ${e.message}`,
        true,
      );
    }
  });
}

module.exports = { register };
