#!/usr/bin/env node
/*
 * opencode-http-mcp — 干净的 OpenCode 2.x MCP 桥
 * 手写 MCP stdio(JSON-RPC) + 直连 opencode serve 的 2.x /api/... HTTP API。
 * 不依赖 @modelcontextprotocol/sdk(避开其 2.0 大版本破坏性变更), 零外部依赖。
 *
 * 环境变量(与旧 opencode-mcp 兼容):
 *   OPENCODE_BASE_URL   例如 http://192.168.123.101:49374
 *   OPENCODE_SERVER_USERNAME  默认 opencode
 *   OPENCODE_SERVER_PASSWORD  Basic Auth 密码
 *   OPENCODE_AUTO_SERVE   默认 false
 */
'use strict';

const http = require('http');
const { URL } = require('url');

const BASE_URL = (process.env.OPENCODE_BASE_URL || 'http://127.0.0.1:49374').replace(/\/+$/, '');
const USER = process.env.OPENCODE_SERVER_USERNAME || 'opencode';
const PASS = process.env.OPENCODE_SERVER_PASSWORD || '';
const AUTH_HEADER = 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64');

// ---- 低层 HTTP 调用，返回解析结果 ----
function api(method, path, body) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(BASE_URL + path); } catch (e) {
      resolve({ ok: false, status: 0, json: null, raw: String(e) });
      return;
    }
    const data = body != null ? JSON.stringify(body) : null;
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'Authorization': AUTH_HEADER,
        'Accept': 'application/json',
      },
    };
    if (data) {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request(opts, (res) => {
      let chunks = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        let parsed;
        try { 
          parsed = { 
            ok: res.statusCode >= 200 && res.statusCode < 300, 
            status: res.statusCode, 
            json: JSON.parse(chunks), 
            raw: chunks 
          };
        } catch (e) {
          parsed = { 
            ok: false, 
            status: res.statusCode, 
            json: null, 
            raw: chunks,
            err: e.message 
          };
        }
        resolve(parsed);
      });
    });
    req.on('error', (e) => {
      resolve({ ok: false, status: 0, json: null, raw: String(e) });
    });
    req.setTimeout(15000, () => {
      req.destroy();
      resolve({ ok: false, status: 0, json: null, raw: 'Request timeout after 15000ms' });
    });
    if (data) req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtMsg(m) {
  if (m == null) return '';
  if (typeof m === 'string') return m;
  if (m.text != null) return m.text;
  if (m.payload && m.payload.text != null) return m.payload.text;
  if (Array.isArray(m.parts)) {
    return m.parts.map((p) => (p && p.text != null ? p.text : (p && p.type === 'text' ? p.text : ''))).join('');
  }
  if (m.content != null) return typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
  return JSON.stringify(m);
}

// ---- 业务动作 ----
async function sessionCreate(title) {
  const r = await api('POST', '/api/session', { title: title || 'wb-session', location: null });
  if (!r.ok) return `创建会话失败 (${r.status}): ${r.raw || ''}`;
  return JSON.stringify(r.json.data, null, 2);
}

async function sessionList() {
  const r = await api('GET', '/api/session');
  if (!r.ok) return `列出会话失败 (${r.status}): ${r.raw || ''}`;
  const arr = (r.json.data || []).map((s) => ({
    id: s.id,
    title: s.title,
    project: s.projectID,
    location: (s.location && s.location.directory) || '',
    updated: (s.time && s.time.updated) || '',
  }));
  return JSON.stringify(arr, null, 2);
}

async function messageList(sessionID) {
  if (!sessionID) return '缺少 sessionID';
  const r = await api('GET', `/api/session/${encodeURIComponent(sessionID)}/message`);
  if (!r.ok) return `读取消息失败 (${r.status}): ${r.raw || ''}`;
  return JSON.stringify(r.json.data || [], null, 2);
}

async function fileRead(path) {
  if (!path) return '缺少 path';
  const r = await api('GET', `/api/fs/read/${encodeURIComponent(path)}`);
  if (!r.ok) return `读取文件失败 (${r.status}): ${r.raw || ''}`;
  return r.raw;
}

async function agentList() {
  const r = await api('GET', '/api/agent');
  if (!r.ok) return `列出 agent 失败 (${r.status}): ${r.raw || ''}`;
  const arr = (r.json.data || []).map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    mode: a.mode,
  }));
  return JSON.stringify(arr, null, 2);
}

async function providerList() {
  const r = await api('GET', '/api/provider');
  if (!r.ok) return `列出 provider 失败 (${r.status}): ${r.raw || ''}`;
  const arr = (r.json.data || []).map((p) => ({
    id: p.id,
    name: p.name,
    activation: p.activation,
    package: p.package,
  }));
  return JSON.stringify(arr, null, 2);
}

async function configGet() {
  const r = await api('GET', '/api/config');
  if (!r.ok) return `读取配置失败 (${r.status}): ${r.raw || ''}`;
  return JSON.stringify(r.json, null, 2);
}

async function health() {
  const r = await api('GET', '/api/provider');
  if (!r.ok) return `Status: unhealthy (${r.status})`;
  const n = (r.json.data || []).length;
  return `Status: healthy\nProviders: ${n}\nBase: ${BASE_URL}`;
}

async function ask(sessionID, text) {
  if (!text) return '缺少 text';
  if (!sessionID) {
    const c = await api('POST', '/api/session', { title: 'wb-ask', location: null });
    if (!c.ok) return `创建会话失败 (${c.status}): ${c.raw || ''}`;
    sessionID = c.json.data.id;
  }
  const p = await api('POST', `/api/session/${encodeURIComponent(sessionID)}/prompt`, { text });
  if (!p.ok) return `发送 prompt 失败 (${p.status}): ${p.raw || ''}`;

  // prompt 是异步的: 轮询消息 + 检查 session 是否还在 active, 直到助手回复出现或超时
  const deadline = Date.now() + 150000;
  let lastAssistant = '';
  let sawAssistant = false;
  while (Date.now() < deadline) {
    await sleep(1500);
    const m = await api('GET', `/api/session/${encodeURIComponent(sessionID)}/message`);
    if (m.ok) {
      const msgs = m.json.data || [];
      const assistant = msgs.filter((x) => x.type === 'assistant' || (x.type && x.type !== 'user'));
      if (assistant.length) { lastAssistant = assistant.map(fmtMsg).join('\n---\n'); sawAssistant = true; }
    }
    const act = await api('GET', '/api/session/active');
    let active = false;
    if (act.ok && Array.isArray(act.json.data)) active = act.json.data.some((s) => s.id === sessionID);
    if (!active && sawAssistant) break;
    if (!active) break; // 没在跑且没助手消息, 等下一轮也可能不会再动
  }
  if (!lastAssistant) return `(session ${sessionID}) 未捕获到助手回复(可能仍在运行或 provider 未就绪)。可用 opencode_message_list 查看。`;
  return `session: ${sessionID}\n\n${lastAssistant}`;
}

// ---- 工作流工具（基于现有 API 编排） ----
async function opencode_setup() {
  // Setup 在本实现中为无操作，直接返回成功
  return JSON.stringify({ status: 'success', message: 'Setup completed (no-op)' }, null, 2);
}

async function opencode_run(args) {
  // run 同 ask，需要 text 参数
  if (!args.text) return '缺少 text';
  return await ask(args.sessionID, args.text);
}

async function opencode_fire(args) {
  // fire 同 ask
  if (!args.text) return '缺少 text';
  return await ask(args.sessionID, args.text);
}

async function opencode_job_list() {
  // 当前服务器未提供 job API
  return JSON.stringify([], null, 2);
}

async function opencode_job_get(args) {
  if (!args.jobID) return '缺少 jobID';
  return JSON.stringify({ error: 'Job API not available on this server' }, null, 2);
}

async function opencode_job_cancel(args) {
  if (!args.jobID) return '缺少 jobID';
  return JSON.stringify({ error: 'Job API not available on this server' }, null, 2);
}

async function opencode_job_input(args) {
  if (!args.jobID || !args.input) return '缺少 jobID 或 input';
  return JSON.stringify({ error: 'Job API not available on this server' }, null, 2);
}

// 新增工作流工具：opencode_wait
async function opencode_wait(args) {
  // 简化实现：等待会话或作业完成，这里仅轮询会话状态直到超时或出现助手回复
  const { sessionId, jobId, timeoutSeconds = 120, pollIntervalMs = 2000, directory } = args;
  if (!sessionId && !jobId) return '必须提供 sessionId 或 jobId';
  const deadline = Date.now() + (timeoutSeconds * 1000);
  let lastStatus = 'unknown';
  while (Date.now() < deadline) {
    let statusInfo;
    if (jobId) {
      // 暂无真正 job API，返回占位
      statusInfo = { status: 'unknown', note: 'Job API not available' };
    } else {
      // 检查会话是否还有活动消息（简单轮询消息数量变化）
      const msgResp = await api('GET', `/api/session/${encodeURIComponent(sessionId)}/message`, undefined, directory);
      if (!msgResp.ok) return `读取消息失败 (${msgResp.status}): ${msgResp.raw || ''}`;
      const msgs = msgResp.json.data || [];
      // 若有助手消息则认为完成
      const hasAssistant = msgs.some(m => m.type === 'assistant' || (m.type && m.type !== 'user'));
      if (hasAssistant) {
        return JSON.stringify({ sessionId, status: 'completed', messages: msgs }, null, 2);
      }
      // 检查会话是否仍然 active
      const actResp = await api('GET', '/api/session/active', undefined, directory);
      if (!actResp.ok) return `检查会话活跃状态失败 (${actResp.status})`;
      const active = Array.isArray(actResp.json) && actResp.json.some(s => s.id === sessionId);
      if (!active) {
        return JSON.stringify({ sessionId, status: 'completed', note: 'Session no longer active' }, null, 2);
      }
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
  return JSON.stringify({ sessionId, status: 'timeout', note: '等待超时' }, null, 2);
}

// 新增工作流工具：opencode_check
async function opencode_check(args) {
  // 简化实现：返回会话的基本元数据（消息数量、是否有助手回复等）
  const { sessionId, jobId, detailed = false, directory } = args;
  if (!sessionId && !jobId) return '必须提供 sessionId 或 jobId';
  let info = {};
  if (jobId) {
    info = { jobId, note: 'Job API not available, returning placeholder' };
  } else {
    const msgResp = await api('GET', `/api/session/${encodeURIComponent(sessionId)}/message`, undefined, directory);
    if (!msgResp.ok) return `读取消息失败 (${msgResp.status}): ${msgResp.raw || ''}`;
    const msgs = msgResp.json.data || [];
    const userCount = msgs.filter(m => m.type === 'user').length;
    const assistantCount = msgs.filter(m => m.type === 'assistant' || (m.type && m.type !== 'user')).length;
    info = { sessionId, messageCount: msgs.length, userMessageCount: userCount, assistantMessageCount: assistantCount };
    if (detailed && msgs.length) {
      // 返回最近一条消息的内容（仅文本）
      const last = msgs[msgs.length - 1];
      info.lastMessage = last.text ?? (last.payload && last.payload.text) ?? '';
    }
  }
  return JSON.stringify(info, null, 2);
}

// ---- MCP 协议层(手写) ----
const TOOLS = [
  { name: 'opencode_health', description: '检查 opencode serve 健康状态与 provider 数量', inputSchema: { type: 'object', properties: {} } },
  { name: 'opencode_session_list', description: '列出所有 opencode 会话', inputSchema: { type: 'object', properties: {} } },
  { name: 'opencode_session_create', description: '创建一个新 opencode 会话(location 默认 null=服务端默认项目)', inputSchema: { type: 'object', properties: { title: { type: 'string', description: '会话标题' } } } },
  { name: 'opencode_message_list', description: '读取某会话的全部消息', inputSchema: { type: 'object', properties: { sessionID: { type: 'string', description: '会话 ID' } }, required: ['sessionID'] } },
  { name: 'opencode_file_read', description: '读取服务器上的文件内容(走 /api/fs/read)', inputSchema: { type: 'object', properties: { path: { type: 'string', description: '服务器绝对路径' } }, required: ['path'] } },
  { name: 'opencode_agent_list', description: '列出可用 agent', inputSchema: { type: 'object', properties: {} } },
  { name: 'opencode_provider_list', description: '列出配置的 LLM provider', inputSchema: { type: 'object', properties: {} } },
  { name: 'opencode_config', description: '读取 opencode 服务端配置', inputSchema: { type: 'object', properties: {} } },
  { name: 'opencode_ask', description: '在会话中发送 prompt 并轮询等待助手回复(不传 sessionID 会自动建会话)', inputSchema: { type: 'object', properties: { sessionID: { type: 'string', description: '可选, 不传则新建' }, text: { type: 'string', description: '提示词' } }, required: ['text'] } },
  // 工作流工具
  { name: 'opencode_setup', description: '初始化 opencode 环境（当前为无操作）', inputSchema: { type: 'object', properties: {} } },
  { name: 'opencode_run', description: '运行提示（等同于 opencode_ask）', inputSchema: { type: 'object', properties: { sessionID: { type: 'string' }, text: { type: 'string' } }, required: ['text'] } },
  { name: 'opencode_fire', description: '触发提示（等同于 opencode_ask）', inputSchema: { type: 'object', properties: { sessionID: { type: 'string' }, text: { type: 'string' } }, required: ['text'] } },
  { name: 'opencode_job_list', description: '列出所有作业（当前服务器暂无 job API）', inputSchema: { type: 'object', properties: {} } },
  { name: 'opencode_job_get', description: '获取单个作业详情', inputSchema: { type: 'object', properties: { jobID: { type: 'string' } }, required: ['jobID'] } },
  { name: 'opencode_job_cancel', description: '取消作业', inputSchema: { type: 'object', properties: { jobID: { type: 'string' } }, required: ['jobID'] } },
  { name: 'opencode_job_input', description: '向作业输入数据', inputSchema: { type: 'object', properties: { jobID: { type: 'string' }, input: { type: 'string' } }, required: ['jobID', 'input'] } },
  { name: 'opencode_wait', description: '等待会话或作业完成（简化实现）', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, jobId: { type: 'string' }, timeoutSeconds: { type: 'number', optional: true }, pollIntervalMs: { type: 'number', optional: true }, directory: { type: 'string' } } } },
  { name: 'opencode_check', description: '检查会话或作业的基本状态（简化实现）', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, jobId: { type: 'string' }, detailed: { type: 'boolean', optional: true }, directory: { type: 'string' } } } }
];

const rl = require('readline').createInterface({ input: process.stdin, terminal: false });

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  handle(msg);
});

async function handle(msg) {
  const { id, method } = msg;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: (msg.params && msg.params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'opencode-http-mcp', version: '1.0.0' },
    } });
  } else if (method === 'notifications/initialized' || method === 'initialized') {
    // 无需回应
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  } else if (method === 'tools/call') {
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    let out;
    try {
      switch (name) {
        case 'opencode_health': out = await health(); break;
        case 'opencode_session_list': out = await sessionList(); break;
        case 'opencode_session_create': out = await sessionCreate(args.title); break;
        case 'opencode_message_list': out = await messageList(args.sessionID); break;
        case 'opencode_file_read': out = await fileRead(args.path); break;
        case 'opencode_agent_list': out = await agentList(); break;
        case 'opencode_provider_list': out = await providerList(); break;
        case 'opencode_config': out = await configGet(); break;
        case 'opencode_ask': out = await ask(args.sessionID, args.text); break;
        // 工作流工具
        case 'opencode_setup': out = await opencode_setup(); break;
        case 'opencode_run': out = await opencode_run(args); break;
        case 'opencode_fire': out = await opencode_fire(args); break;
        case 'opencode_job_list': out = await opencode_job_list(); break;
        case 'opencode_job_get': out = await opencode_job_get(args); break;
        case 'opencode_job_cancel': out = await opencode_job_cancel(args); break;
        case 'opencode_job_input': out = await opencode_job_input(args); break;
        case 'opencode_wait': out = await opencode_wait(args); break;
        case 'opencode_check': out = await opencode_check(args); break;
        default: out = `未知工具: ${name}`;
      }
    } catch (e) { out = `工具执行异常: ${String(e)}`; }
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(out) }] } });
  } else if (method && method.endsWith('/list')) {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  } else {
    if (id != null) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

// 启动信号
process.stderr.write('opencode-http-mcp started (target ' + BASE_URL + ')\n');