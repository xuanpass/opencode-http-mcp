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
const { createResources } = require('./resources.js');
const { createPrompts } = require('./prompts.js');
const { spawn } = require('child_process');
const { URL } = require('url');

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

const CAPABILITIES = { tools: {}, prompts: {}, resources: {}, extensions: { "io.modelcontextprotocol/tasks": {} } };
const CACHE_HINTS = {
  "tools/list": { ttlMs: 60000, cacheScope: "private" },
  "prompts/list": { ttlMs: 60000, cacheScope: "private" },
  "resources/list": { ttlMs: 60000, cacheScope: "private" },
  "resources/templates/list": { ttlMs: 60000, cacheScope: "private" },
  "resources/read": { ttlMs: 0, cacheScope: "private" }
};
const SERVER_INFO = {
  name: 'opencode-http-mcp',
  version: '3.0.0',
};

async function main() {
  const baseUrl = process.env.OPENCODE_BASE_URL || 'http://127.0.0.1:49374';
  const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode';
  const password = process.env.OPENCODE_SERVER_PASSWORD || '';
  const timeoutMs = Number(process.env.OPENCODE_TIMEOUT_MS || 120000);
  const autoServe = process.env.OPENCODE_AUTO_SERVE === 'true';

  let serveProc = null;

  // Function to check if a host is local (localhost, 127.0.0.1, [::1])
  function isLocalHost(host) {
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  }

  // Function to parse the host from the baseUrl
  function getHostFromUrl(urlString) {
    try {
      const url = new URL(urlString);
      return url.hostname;
    } catch (e) {
      return null;
    }
  }

  // Function to check if the OpenCode server is healthy by calling the health endpoint
  async function isServerHealthy(client) {
    try {
      const response = await client.get('/global/health', undefined, undefined, { timeoutMs: 5000 });
      // We consider it healthy if we get a response (even if it's not 200, we assume the server is up)
      // The client will throw on network errors, so if we get here, the server is reachable.
      return true;
    } catch (err) {
      // If it's a network error, the server is not reachable
      return false;
    }
  }

  // Auto-spawn the OpenCode server if needed
  if (autoServe) {
    const host = getHostFromUrl(baseUrl);
    if (host && isLocalHost(host)) {
      process.stderr.write('[opencode-http-mcp] Attempting to auto-spawn OpenCode server...\n');
      try {
        serveProc = spawn('opencode', ['serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
        serveProc.stderr.on('data', (data) => {
          process.stderr.write(`[opencode-serve] ${data}`);
        });
        // Wait for the server to become healthy, with a timeout of 30 seconds
        const startTime = Date.now();
        const timeout = 30000; // 30 seconds
        let healthy = false;
        while (Date.now() - startTime < timeout && !healthy) {
          // Create a temporary client to check health
          const tempClient = new OpenCodeClient({ baseUrl, username, password, timeoutMs: 2000 });
          healthy = await isServerHealthy(tempClient);
          if (!healthy) {
            // Wait 1 second before trying again
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
        process.stderr.write('[opencode-http-mcp] OpenCode server spawned (PID: ' + serveProc.pid + ') and is healthy.\n');
      } catch (err) {
        process.stderr.write('[opencode-http-mcp] Failed to spawn OpenCode server: ' + err.message + '\n');
        serveProc = null;
      }
    } else {
      process.stderr.write('[opencode-http-mcp] OPENCODE_AUTO_SERVE is true but baseUrl is not local; skipping auto-spawn.\n');
    }
  }

  const client = new OpenCodeClient({ baseUrl, username, password, timeoutMs });
  // Resources: bind to the client
  const resources = createResources(client);
  // Prompts: bind to the client
  const prompts = createPrompts(client);
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
          cacheHints: CACHE_HINTS,
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

      case 'resources/list': {
        try {
          const resourceList = await resources.listResources();
          send(id, { resources: resourceList });
        } catch (e) {
          sendError(id, -32603, e instanceof Error ? e.message : String(e));
        }
        break;
      }

      case 'resources/read': {
        try {
          const uri = params?.uri;
          if (typeof uri !== 'string') {
            throw new Error('Invalid URI');
          }
          const result = await resources.readResource(uri);
          send(id, result);
        } catch (e) {
          sendError(id, -32603, e instanceof Error ? e.message : String(e));
        }
        break;
      }

      case 'prompts/list': {
        try {
          const promptList = await prompts.listPrompts();
          send(id, { prompts: promptList });
        } catch (e) {
          sendError(id, -32603, e instanceof Error ? e.message : String(e));
        }
        break;
      }

      case 'prompts/get': {
        try {
          const name = params?.name;
          if (typeof name !== 'string') {
            throw new Error('Invalid prompt name');
          }
          const prompt = await prompts.getPrompt(name);
          send(id, { prompt });
        } catch (e) {
          sendError(id, -32603, e instanceof Error ? e.message : String(e));
        }
        break;
      }

      case 'tasks/get': {
        try {
          const { taskId } = params || {};
          if (typeof taskId !== 'string') {
            throw new Error('Invalid or missing taskId');
          }
          const snapshot = await jobs.get(taskId);
          send(id, { ...snapshot });
        } catch (e) {
          sendError(id, -32603, e instanceof Error ? e.message : String(e));
        }
        break;
      }

      case 'tasks/update': {
        try {
          const { taskId, responses } = params || {};
          if (typeof taskId !== 'string') {
            throw new Error('Invalid or missing taskId');
          }
          if (!Array.isArray(responses)) {
            throw new Error('Invalid or missing responses array');
          }
          const snap = await jobs.update(taskId, responses);
          const lines = [`Job: ${snap.jobId}`, `Session: ${snap.sessionId ?? ''}`, `Status: ${snap.status}`];
          if (snap.error) lines.push(`Error: ${JSON.stringify(snap.error)}`);
          if (snap.text) lines.push(snap.text);
          send(id, {
            content: [{ type: 'text', text: lines.join('\n') }],
            isError: snap.status === 'failed',
            _snapshot: snap,
          });
        } catch (e) {
          sendError(id, -32603, e instanceof Error ? e.message : String(e));
        }
        break;
      }

      case 'tasks/cancel': {
        try {
          const { taskId } = params || {};
          if (typeof taskId !== 'string') {
            throw new Error('Invalid or missing taskId');
          }
          await jobs.cancel(taskId);
          send(id, { status: 'cancelled' });
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
    // Kill the spawned server if it exists
    if (serveProc) {
      process.stderr.write('[opencode-http-mcp] Killing spawned OpenCode server (PID: ' + serveProc.pid + ')\n');
      serveProc.kill();
    }
    process.exit(0);
  });
}

// Run the main function and handle any uncaught exceptions.
// NOTE: main() must be invoked exactly ONCE — it creates a readline interface
// on stdin; a second invocation would double-handle every JSON-RPC request.
main().catch(err => {
  console.error('[opencode-http-mcp] Fatal error in main():', err);
  process.exit(1);
});
