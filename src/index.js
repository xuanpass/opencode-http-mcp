/**
 * opencode-http-mcp — layered MCP stdio bridge to an OpenCode 2.x/3.x server.
 *
 * Architecture (mirrors upstream opencode-mcp 3.x, dependency-free pure JS):
 *   Layer 0   src/http.js      OpenCodeClient — HTTP + SSE + envelope unwrap
 *   Layer 0.5 src/helpers.js   formatting / result envelopes / redaction
 *   Layer 0.5 src/registry.js  tool registry
 *   Layer 0.5 src/util.js      small arg helpers
 *   Layer 1   src/jobs.js     JobService — session-turn dispatch & observation
 *   Layer 2   src/tools/*     grouped tool modules (one per upstream file)
 *
 * This file is the stdio entry point wired into ~/.workbuddy/mcp.json.
 */
'use strict';

const readline = require('readline');
const { OpenCodeClient } = require('./http.js');
const { JobService } = require('./jobs.js');
const { Registry } = require('./registry.js');

// Layer 2 — grouped tool modules, one per upstream file.
const groups = [
  require('./tools/session.js'),
  require('./tools/message.js'),
  require('./tools/file.js'),
  require('./tools/config.js'),
  require('./tools/provider.js'),
  require('./tools/project.js'),
  require('./tools/misc.js'),
  require('./tools/global.js'),
  require('./tools/events.js'),
  require('./tools/input.js'),
  require('./tools/tui.js'),
  require('./tools/workflow.js'),
];

const CAPABILITIES = { tools: {} };
const SERVER_INFO = {
  name: 'opencode-http-mcp',
  version: '3.0.0',
};

function main() {
  const baseUrl = process.env.OPENCODE_BASE_URL || 'http://127.0.0.1:49374';
  const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode';
  const password = process.env.OPENCODE_SERVER_PASSWORD || '';
  const timeoutMs = Number(process.env.OPENCODE_TIMEOUT_MS || 120000);

  const client = new OpenCodeClient({ baseUrl, username, password, timeoutMs });
  // Persistent JobService: storeRoot env → explicit dir; unset → platform
  // state dir (%LOCALAPPDATA%/opencode-mcp/tasks/<scope> on Windows,
  // ~/.local/state/opencode-mcp/tasks/<scope> on POSIX). Pass null for a
  // process-local in-memory store (tests / ephemeral use).
  const storeRootEnv = process.env.OPENCODE_MCP_STORE_ROOT;
  const storeRoot = storeRootEnv === '' ? null : (storeRootEnv || undefined);
  const jobs = new JobService(client, {
    storeRoot,
    scope: process.env.OPENCODE_MCP_SCOPE || 'default',
    ttlMs: Number(process.env.OPENCODE_MCP_TTL_MS) || 24 * 60 * 60 * 1000,
  });
  const registry = new Registry();

  for (const g of groups) {
    g.register(registry, { client, jobs });
  }

  const tools = registry.list();
  process.stderr.write(
    `[opencode-http-mcp] ${tools.length} tools registered -> ${baseUrl}\n`,
  );

  function send(id, result) {
    if (id === undefined || id === null) return; // notification — no response
    const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
    process.stdout.write(msg + '\n');
  }

  function sendError(id, code, message) {
    const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
    process.stdout.write(msg + '\n');
  }

  async function dispatch(name, args) {
    const tool = registry.get(name);
    if (!tool) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
    return tool.run(args || {}, { client, jobs });
  }

  async function handle(request) {
    const { id, method, params } = request;
    switch (method) {
      case 'initialize':
        send(id, {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: CAPABILITIES,
          serverInfo: SERVER_INFO,
          instructions: 'Bridge to an OpenCode 2.x server. Routes pinned to /api/... with honest no-route fallbacks.',
        });
        break;

      case 'tools/list':
        send(id, { tools });
        break;

      case 'tools/call': {
        try {
          const result = await dispatch(params?.name, params?.arguments);
          send(id, result);
        } catch (e) {
          sendError(id, -32603, e instanceof Error ? e.message : String(e));
        }
        break;
      }

      case 'ping':
        send(id, {});
        break;

      case 'notifications/initialized':
      case 'notifications/cancelled':
        // No response for notifications.
        break;

      default:
        // Unknown method — reply with a null result rather than an error so
        // well-behaved clients keep the session alive.
        send(id, null);
        break;
    }
  }

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  let queue = Promise.resolve();
  rl.on('line', (line) => {
    const s = line.trim();
    if (!s) return;
    let req;
    try { req = JSON.parse(s); } catch { return; }
    queue = queue.then(() => handle(req)).catch((e) => {
      process.stderr.write(`[opencode-http-mcp] dispatch error: ${e && e.message}\n`);
    });
  });
  rl.on('close', () => {
    process.stdout.write('[opencode-http-mcp] stdin closed, exiting\n');
    process.exit(0);
  });
}

main();
