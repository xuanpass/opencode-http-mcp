/**
 * MCP Resources — expose OpenCode data as browseable resources.
 * Ported from upstream resources.ts to dependency-free pure JS.
 */

const { normalizeDirectory, redactSecrets } = require('./helpers.js');

/**
 * Creates a resources interface bound to the given OpenCodeClient.
 * @param {import('./http.js').OpenCodeClient} client
 * @returns {{ list: () => Promise<Array<{uri:string,name:string,description:string,mimeType:string}>>, read: (uri:string) => Promise<{contents:Array<{uri:string,mimeType:string,text:string}>>} }}
 */
function createResources(client) {
  // Helper to safely stringify JSON with truncation (simplified version)
  function safeStringify(value, maxLength = 50000) {
    const json = JSON.stringify(value ?? null, null, 2);
    if (json.length <= maxLength) return json;
    // Truncate and add a notice
    const truncated = json.slice(0, maxLength) + '… [truncated]';
    return truncated;
  }

  // Fixed resources: each maps a static URI to an endpoint
  const fixedResources = [
    {
      name: 'project-current',
      uri: 'opencode://project/current',
      description: 'The currently active OpenCode project',
      mimeType: 'application/json',
      endpoint: '/project/current',
    },
    {
      name: 'config',
      uri: 'opencode://config',
      description: 'Current OpenCode configuration',
      mimeType: 'application/json',
      endpoint: '/config',
    },
    {
      name: 'providers',
      uri: 'opencode://providers',
      description: 'All available LLM providers, their models, and connection status',
      mimeType: 'application/json',
      endpoint: '/provider',
    },
    {
      name: 'agents',
      uri: 'opencode://agents',
      description: 'All available agents and their configurations',
      mimeType: 'application/json',
      endpoint: '/agent',
    },
    {
      name: 'commands',
      uri: 'opencode://commands',
      description: 'All available commands (built-in and custom)',
      mimeType: 'application/json',
      endpoint: '/command',
    },
    {
      name: 'health',
      uri: 'opencode://health',
      description: 'OpenCode server health and version',
      mimeType: 'application/json',
      endpoint: '/global/health',
    },
    {
      name: 'vcs',
      uri: 'opencode://vcs',
      description: 'Version control system info for the current project',
      mimeType: 'application/json',
      endpoint: '/vcs',
    },
    {
      name: 'sessions',
      uri: 'opencode://sessions',
      description: 'All sessions',
      mimeType: 'application/json',
      endpoint: '/session',
    },
    {
      name: 'mcp-servers',
      uri: 'opencode://mcp-servers',
      description: 'Status of all configured MCP servers in OpenCode',
      mimeType: 'application/json',
      endpoint: '/mcp',
    },
    {
      name: 'file-status',
      uri: 'opencode://file-status',
      description: 'VCS status of all tracked files',
      mimeType: 'application/json',
      endpoint: '/file/status',
    },
  ];

  // Resource templates: URI patterns with variables
  const resourceTemplates = [
    {
      name: 'project-scoped',
      uriTemplate: 'opencode://projects/{directory}/current',
      description: 'Project-scoped current project; percent-encode the absolute server directory',
      mimeType: 'application/json',
      endpoint: '/project/current',
      vars: ['directory'],
    },
    {
      name: 'sessions-scoped',
      uriTemplate: 'opencode://projects/{directory}/sessions',
      description: 'Project-scoped session list; percent-encode the absolute server directory',
      mimeType: 'application/json',
      endpoint: '/session',
      vars: ['directory'],
    },
    {
      name: 'session-scoped',
      uriTemplate: 'opencode://projects/{directory}/sessions/{sessionId}',
      description: 'Session details in an explicitly scoped project',
      mimeType: 'application/json',
      endpoint: '/session/{sessionId}',
      vars: ['directory', 'sessionId'],
    },
    {
      name: 'session-messages-scoped',
      uriTemplate: 'opencode://projects/{directory}/sessions/{sessionId}/messages',
      description: 'Session messages in an explicitly scoped project',
      mimeType: 'application/json',
      endpoint: '/session/{sessionId}/message',
      vars: ['directory', 'sessionId'],
    },
  ];

  async function listResources() {
    // Return all fixed resources and templates (templates are listed as-is)
    const fixed = fixedResources.map(r => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }));
    const templates = resourceTemplates.map(t => ({
      uri: t.uriTemplate,
      name: t.name,
      description: t.description,
      mimeType: t.mimeType,
    }));
    return [...fixed, ...templates];
  }

  async function readResource(uri) {
    // Try to match a fixed resource
    for (const r of fixedResources) {
      if (r.uri === uri) {
        try {
          const data = await client.get(r.endpoint);
          return {
            contents: [{
              uri: uri,
              mimeType: r.mimeType,
              text: safeStringify(redactSecrets(data)),
            }],
          };
        } catch (err) {
          // If the endpoint returns 404 or error, return a sensible fallback
          return {
            contents: [{
              uri: uri,
              mimeType: 'text/plain',
              text: `No data available for ${r.name}.`,
            }],
          };
        }
      }
    }

    // Try to match a resource template
    for (const t of resourceTemplates) {
      // Convert URI template to a RegExp
      // Example: opencode://projects/{directory}/current -> ^opencode://projects\/(.+)\/current$
      const regexStr = t.uriTemplate
        .replace(/([.*+?^=!:${}()|[\]\/\\])/g, '\\$1')
        .replace(/\{[^}]+\}/g, '(.+)');
      const regex = new RegExp(`^${regexStr}$`);
      const match = uri.match(regex);
      if (match) {
        // Extract values for each variable in order
        const values = {};
        t.vars.forEach((varName, index) => {
          values[varName] = match[index + 1];
        });
        // Normalize directory if present
        if (values.directory !== undefined) {
          values.directory = normalizeDirectory(values.directory);
          if (values.directory === undefined) {
            return {
              contents: [{
                uri: uri,
                mimeType: 'text/plain',
                text: `Invalid directory: ${values.directory}`,
              }],
            };
          }
        }
        // Build the endpoint path
        let endpoint = t.endpoint;
        t.vars.forEach(varName => {
          const encoded = encodeURIComponent(values[varName]);
          endpoint = endpoint.replace(`{${varName}}`, encoded);
        });
        try {
          const data = await client.get(endpoint, undefined, values.directory);
          return {
            contents: [{
              uri: uri,
              mimeType: t.mimeType,
              text: safeStringify(redactSecrets(data)),
            }],
          };
        } catch (err) {
          return {
            contents: [{
              uri: uri,
              mimeType: 'text/plain',
              text: `No data available for ${t.name} with the given parameters.`,
            }],
          };
        }
      }
    }

    // If no match
    return {
      contents: [{
        uri: uri,
        mimeType: 'text/plain',
        text: `Unknown resource: ${uri}`,
      }],
    };
  }

  return { listResources, readResource };
}

module.exports = { createResources };