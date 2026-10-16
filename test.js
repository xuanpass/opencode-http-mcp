#!/usr/bin/env node
/*
 * Smoke test for opencode-http-mcp.
 *
 * Spawns the MCP server as a child process (exactly how an MCP client would),
 * speaks the stdio JSON-RPC protocol to it, and verifies:
 *   1. `initialize` responds with serverInfo.
 *   2. `tools/list` returns a non-empty tool list containing the core tools.
 *   3. A read-only tool (`opencode_health`) can be called without a protocol
 *      error. This requires a reachable OpenCode server (via env vars).
 *
 * Usage:
 *   OPENCODE_BASE_URL=http://host:port \
 *   OPENCODE_SERVER_USERNAME=opencode \
 *   OPENCODE_SERVER_PASSWORD=*** \
 *   node test.js
 *
 * If OPENCODE_BASE_URL is unset, the test still validates the protocol layer
 * (initialize + tools/list) but skips the live tool call.
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const HERE = __dirname;
const SERVER = path.join(HERE, 'src', 'index.js');

const children = new Map(); // id -> { resolve, timer }
let proc;

function rpc(id, method, params) {
  return new Promise((resolve, reject) => {
    children.set(id, { resolve, reject, timer: setTimeout(() => {
      children.delete(id);
      reject(new Error(`timeout waiting for ${method} (id ${id})`));
    }, 8000), method });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
  });
}

function onData(chunk) {
  for (const line of String(chunk).split('\n')) {
    const l = line.trim();
    if (!l) continue;
    let msg;
    try { msg = JSON.parse(l); } catch { continue; }
    if (msg.id != null && children.has(msg.id)) {
      const { resolve, reject, timer, method } = children.get(msg.id);
      clearTimeout(timer);
      children.delete(msg.id);
      if (msg.error) { reject(new Error(`${method}: ${JSON.stringify(msg.error)}`)); }
      else { resolve(msg.result); }
    }
  }
}

async function main() {
  const haveServer = !!process.env.OPENCODE_BASE_URL;
  proc = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stdout.on('data', onData);
  let err = '';
  proc.stderr.on('data', (d) => (err += String(d)));
  proc.on('exit', (code) => {
    console.log(`[server exit] code=${code} stderr:\n${err}`);
  });

  // 1. initialize
  const init = await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke-test', version: '1.0.0' } });
  console.log('[ok] initialize ->', init.serverInfo.name, init.serverInfo.version);

  // 2. tools/list
  const list = await rpc(2, 'tools/list');
  const names = (list.tools || []).map((t) => t.name);
  console.log(`[ok] tools/list -> ${names.length} tools`);
  const required = ['opencode_health', 'opencode_ask', 'opencode_session_list',
    'opencode_message_list', 'opencode_provider_list', 'opencode_agent_list',
    'opencode_vcs_info', 'opencode_mcp_status', 'opencode_events_poll',
    'opencode_context', 'opencode_review_changes', 'opencode_setup'];
  const missing = required.filter((n) => !names.includes(n));
  if (missing.length) {
    console.error(`[FAIL] missing expected tools: ${missing.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  console.log('[ok] core tools present');

  // 3. live tool call (only if a server is configured)
  if (haveServer) {
    try {
      const res = await rpc(3, 'tools/call', { name: 'opencode_health', arguments: {} });
      const text = res && res.content && res.content[0] ? res.content[0].text : '';
      console.log('[ok] opencode_health ->', text.replace(/\n/g, ' ').slice(0, 80));
    } catch (e) {
      console.error('[warn] opencode_health call failed:', e.message);
      process.exitCode = 1;
    }
  } else {
    console.log('[skip] no OPENCODE_BASE_URL set — protocol checks passed, live tool call skipped.');
  }

  proc.kill();
  console.log(process.exitCode ? '\nRESULT: FAIL' : '\nRESULT: PASS');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
  if (proc) proc.kill();
});
