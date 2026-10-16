/**
 * Tool group: message (upstream src/tools/message.ts, 6 tools)
 * Routes pinned to 2.x /api/... . Note: 2.x uses /prompt (not /message) for
 * the synchronous "send and wait" call; prompt_async is fire-and-forget.
 */
'use strict';
const { toolResult, toolError, formatMessageResponse, formatMessageList, analyzeMessageResponse, directoryParam } = require('../helpers.js');
const { dir, req, modelOpts } = require('../util.js');
const { createMessageId } = require('../jobs.js');

function modelFromBody(a) {
  const o = modelOpts(a);
  return o;
}

function register(registry, ctx) {
  const { client } = ctx;
  const R = (name, desc, schema, fn) => registry.tool(name, desc, { inputSchema: schema, run: fn });

  R('opencode_message_list', 'List all messages in a session with formatted roles and content.', {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      limit: { type: 'number', description: 'Max messages to return' },
      directory: directoryParam,
    },
    required: ['sessionId'],
  }, async (a) => {
    try {
      const query = {};
      if (a.limit !== undefined) query.limit = String(a.limit);
      const messages = await client.get(
        `/api/session/${encodeURIComponent(a.sessionId)}/message`, query, dir(a),
      );
      const arr = Array.isArray(messages) ? messages : (messages?.data || []);
      return toolResult(formatMessageList(arr, a.limit), false, { data: arr });
    } catch (e) { return toolError(e); }
  });

  R('opencode_message_get', 'Get details of a specific message in a session.', {
    type: 'object',
    properties: { sessionId: { type: 'string' }, messageId: { type: 'string' }, directory: directoryParam },
    required: ['sessionId', 'messageId'],
  }, async (a) => {
    try {
      const msg = await client.get(
        `/api/session/${encodeURIComponent(a.sessionId)}/message/${encodeURIComponent(a.messageId)}`, undefined, dir(a),
      );
      return toolResult(formatMessageResponse(msg), false, { data: msg });
    } catch (e) { return toolError(e); }
  });

  R('opencode_message_send', 'Send a prompt to a session and wait for the AI response.', {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      text: { type: 'string' },
      providerID: { type: 'string' },
      modelID: { type: 'string' },
      variant: { type: 'string' },
      agent: { type: 'string' },
      noReply: { type: 'boolean' },
      system: { type: 'string' },
      format: { type: 'string' },
      directory: directoryParam,
    },
    required: ['sessionId', 'text'],
  }, async (a) => {
    try {
      const body = { parts: [{ type: 'text', text: a.text }] };
      Object.assign(body, modelFromBody(a));
      if (a.noReply !== undefined) body.noReply = a.noReply;
      if (a.system) body.system = a.system;
      const response = await client.post(
        `/api/session/${encodeURIComponent(a.sessionId)}/prompt`, body, req(a),
      );
      const analysis = analyzeMessageResponse(response);
      const formatted = formatMessageResponse(response);
      const parts = [];
      if (formatted) parts.push(formatted);
      if (analysis.warning) parts.push(`\n--- WARNING ---\n${analysis.warning}`);
      return toolResult(parts.join('\n\n') || 'Empty response.', analysis.hasError, { data: response });
    } catch (e) { return toolError(e); }
  });

  R('opencode_message_send_async', 'Send a prompt asynchronously and return its messageId for opencode_wait. NOTE: 2.0.30 lacks /prompt_async; this falls back to a synchronous /prompt call which may block until the model replies.', {
    type: 'object',
    properties: {
      sessionId: { type: 'string' }, text: { type: 'string' },
      providerID: { type: 'string' }, modelID: { type: 'string' },
      variant: { type: 'string' }, agent: { type: 'string' },
      format: { type: 'string' }, directory: directoryParam,
    },
    required: ['sessionId', 'text'],
  }, async (a) => {
    const messageId = createMessageId();
    try {
      const body = { messageID: messageId, parts: [{ type: 'text', text: a.text }] };
      Object.assign(body, modelFromBody(a));
      let sent = false;
      try {
        await client.post(`/api/session/${encodeURIComponent(a.sessionId)}/prompt_async`, body, req(a));
        sent = true;
      } catch {
        // Fall back to sync prompt when /prompt_async is not available.
        await client.post(`/api/session/${encodeURIComponent(a.sessionId)}/prompt`, body, req(a));
      }
      return toolResult(
        `Message sent. ${sent ? 'Asynchronous via /prompt_async.' : 'Used synchronous /prompt (this build lacks /prompt_async).'} Use opencode_wait({sessionId: "${a.sessionId}", messageId: "${messageId}"}) to observe.`,
        false,
        { data: { sessionId: a.sessionId, messageId, status: 'submitted', async: sent } },
      );
    } catch (e) {
      return { ...toolError(e), structuredContent: { data: { sessionId: a.sessionId, messageId } } };
    }
  });

  R('opencode_command_execute', 'Execute a slash command in a session (e.g. /init, /undo).', {
    type: 'object',
    properties: {
      sessionId: { type: 'string' }, command: { type: 'string' },
      arguments: { type: 'string' }, agent: { type: 'string' },
      providerID: { type: 'string' }, modelID: { type: 'string' }, variant: { type: 'string' },
      directory: directoryParam,
    },
    required: ['sessionId', 'command'],
  }, async (a) => {
    try {
      const body = { command: a.command, arguments: a.arguments ?? '' };
      if (a.agent) body.agent = a.agent;
      const model = modelOpts(a);
      if (model.model && (model.model.providerID || model.model.modelID)) {
        body.model = `${model.model.providerID || ''}/${model.model.modelID || ''}`;
      }
      if (model.variant) body.variant = model.variant;
      const result = await client.post(`/api/session/${encodeURIComponent(a.sessionId)}/command`, body, req(a));
      return toolResult(formatMessageResponse(result), false, { data: result });
    } catch (e) { return toolError(e); }
  });

  R('opencode_shell_execute', 'Run a shell command through the opencode session.', {
    type: 'object',
    properties: {
      sessionId: { type: 'string' }, command: { type: 'string' }, agent: { type: 'string' },
      providerID: { type: 'string' }, modelID: { type: 'string' }, directory: directoryParam,
    },
    required: ['sessionId', 'command'],
  }, async (a) => {
    try {
      const body = { command: a.command, agent: a.agent };
      const model = modelOpts(a);
      if (model.model) body.model = model.model;
      const result = await client.post(`/api/session/${encodeURIComponent(a.sessionId)}/shell`, body, req(a));
      return toolResult(formatMessageResponse(result), false, { data: result });
    } catch (e) { return toolError(e); }
  });
}

module.exports = { register };
