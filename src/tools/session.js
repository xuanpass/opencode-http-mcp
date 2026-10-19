/**
 * Tool group: session (upstream src/tools/session.ts, 20 tools)
 * All routes pinned to the live-verified 2.0.31 /api/... table.
 *
 * Shape notes (2.0.31): /api/session answers a BARE ARRAY of rows whose
 * `outcome` field ("succeeded" | "interrupted" | "failed") is absent while a
 * run is in flight — that is what opencode_session_status reports, since
 * /api/session/status itself is unusable (GET 400, POST 404).
 */
'use strict';
const { toolResult, toolError, formatSessionList, formatDiffResponse, directoryParam } = require('../helpers.js');
const { dir, req } = require('../util.js');

function formatSession(raw) {
  const s = raw;
  if (!s || typeof s !== 'object') return JSON.stringify(raw);
  const lines = [];
  if (s.id) lines.push(`ID: ${s.id}`);
  if (s.title) lines.push(`Title: ${s.title}`);
  if (s.parentID) lines.push(`Parent: ${s.parentID}`);
  const t = s.time || {};
  if (t.created) lines.push(`Created: ${new Date(t.created).toISOString()}`);
  else if (s.createdAt) lines.push(`Created: ${s.createdAt}`);
  if (t.updated) lines.push(`Updated: ${new Date(t.updated).toISOString()}`);
  else if (s.updatedAt) lines.push(`Updated: ${s.updatedAt}`);
  if (s.status) lines.push(`Status: ${s.status}`);
  if (s.location && s.location.directory) lines.push(`Directory: ${s.location.directory}`);
  if (s.shareUrl) lines.push(`Share URL: ${s.shareUrl}`);
  if (lines.length === 0) return JSON.stringify(raw);
  return lines.join('\n');
}

function register(registry, ctx) {
  const { client } = ctx;
  const R = (name, desc, schema, fn) => registry.tool(name, desc, { inputSchema: schema, run: fn });

  R('opencode_session_list', 'List all sessions.', {
    type: 'object', properties: { directory: directoryParam },
  }, async (a) => {
    try {
      const sessions = await client.get('/api/session', undefined, dir(a));
      return toolResult(formatSessionList(Array.isArray(sessions) ? sessions : []), false, { data: sessions });
    } catch (e) { return toolError(e); }
  });

  R('opencode_session_create', 'Create a new session. Optionally parentID and title.', {
    type: 'object',
    properties: {
      parentID: { type: 'string', description: 'Parent session ID' },
      title: { type: 'string', description: 'Session title' },
      directory: directoryParam,
    },
  }, async (a) => {
    try {
      const body = {};
      if (a.parentID) body.parentID = a.parentID;
      if (a.title) body.title = a.title;
      const session = await client.post('/api/session', { ...body, location: a.directory || null }, req(a));
      if (typeof session?.id !== 'string') throw new Error('OpenCode returned a session without an ID');
      return toolResult(`Session created.\n\n${formatSession(session)}`, false, { sessionId: session.id, session });
    } catch (e) { return toolError(e); }
  });

  R('opencode_session_get', 'Get details of a specific session by ID.', {
    type: 'object', properties: { id: { type: 'string' }, directory: directoryParam }, required: ['id'],
  }, async (a) => {
    try {
      const s = await client.get(`/api/session/${encodeURIComponent(a.id)}`, undefined, dir(a));
      return toolResult(formatSession(s), false, { data: s });
    } catch (e) { return toolError(e); }
  });

  R('opencode_session_delete', 'Delete a session and all its data.', {
    type: 'object', properties: { id: { type: 'string' }, directory: directoryParam }, required: ['id'],
  }, async (a) => {
    try {
      await client.delete(`/api/session/${encodeURIComponent(a.id)}`, undefined, req(a));
      return toolResult(`Session ${a.id} deleted.`);
    } catch (e) { return toolError(e); }
  });

  R('opencode_session_update', 'Update session properties (e.g. title).', {
    type: 'object',
    properties: { id: { type: 'string' }, title: { type: 'string' }, directory: directoryParam },
    required: ['id'],
  }, async (a) => {
    try {
      const body = {};
      if (a.title !== undefined) body.title = a.title;
      const updated = await client.patch(`/api/session/${encodeURIComponent(a.id)}`, body, req(a));
      return toolResult(formatSession(updated));
    } catch (e) { return toolError(e); }
  });

  R('opencode_session_children', 'Get child sessions of a session.', {
    type: 'object', properties: { id: { type: 'string' }, directory: directoryParam }, required: ['id'],
  }, async (a) => {
    try {
      const children = await client.get(`/api/session/${encodeURIComponent(a.id)}/children`, undefined, dir(a));
      const arr = Array.isArray(children) ? children : (children?.data || []);
      if (!arr.length) return toolResult('No child sessions found.');
      return toolResult(formatSessionList(arr));
    } catch (e) { return toolError(e); }
  });

  R('opencode_session_status', 'Get status for all sessions (running, idle, etc.).', {
    type: 'object', properties: { directory: directoryParam },
  }, async (a) => {
    try {
      // 2.x removed /api/session/status (GET 400 InvalidRequestError, POST 404).
      // The same information is on each /api/session row as `outcome`
      // ("succeeded" | "interrupted" | "failed"); it is absent while a run
      // is in flight or when the session never started one.
      const raw = await client.get('/api/session', undefined, dir(a));
      const arr = Array.isArray(raw) ? raw : (raw?.data || []);
      if (!arr.length) return toolResult('No sessions found.');
      const running = arr.filter((s) => !s.outcome);
      const done = arr.filter((s) => s.outcome);
      const lines = [];
      if (running.length) {
        lines.push(`**No recorded outcome (${running.length}) — running or never started:**`);
        for (const s of running) lines.push(`- ${s.id}: ${s.time?.idle ? 'idle' : 'unknown'}`);
      }
      if (done.length) {
        lines.push(`\n**Finished (${done.length}):**`);
        for (const s of done.slice(0, 50)) lines.push(`- ${s.id}: ${s.outcome}`);
      }
      return toolResult(`## Session Status (${arr.length} total)\n${lines.join('\n')}`, false, { data: { running: running.length, total: arr.length } });
    } catch (e) { return toolError(e); }
  });

  R('opencode_session_todo', 'Get the todo list for a session.', {
    type: 'object', properties: { id: { type: 'string' }, directory: directoryParam }, required: ['id'],
  }, async (a) => {
    try {
      const raw = await client.get(`/api/session/${encodeURIComponent(a.id)}/todo`, undefined, dir(a));
      const todos = Array.isArray(raw) ? raw : (raw?.data || []);
      if (!todos.length) return toolResult('No todos for this session.');
      const lines = todos.map((t) => {
        const done = t.status === 'completed' || t.done === true || t.completed === true;
        const check = done ? '[x]' : '[ ]';
        const content = t.content ?? t.title ?? t.text ?? t.description ?? '?';
        return `- ${check} ${content}${t.priority ? ` (${t.priority})` : ''}`;
      });
      const completed = todos.filter((t) => t.status === 'completed' || t.done === true || t.completed === true).length;
      return toolResult(`## Todos (${completed}/${todos.length} done)\n${lines.join('\n')}`);
    } catch (e) { return toolError(e); }
  });

  R('opencode_session_init', 'Analyze the app and create AGENTS.md for a session. Long-running (30-60s+).', {
    type: 'object',
    properties: {
      id: { type: 'string' }, messageID: { type: 'string' },
      providerID: { type: 'string' }, modelID: { type: 'string' },
      variant: { type: 'string' }, directory: directoryParam,
    },
    required: ['id', 'messageID', 'providerID', 'modelID'],
  }, async (a) => {
    try {
      await client.post(`/api/session/${encodeURIComponent(a.id)}/init`,
        { messageID: a.messageID, providerID: a.providerID, modelID: a.modelID, variant: a.variant }, req(a));
      return toolResult('AGENTS.md initialization started.');
    } catch (e) { return toolError(e); }
  });

  R('opencode_session_abort', 'Abort a running session.', {
    type: 'object', properties: { id: { type: 'string' }, directory: directoryParam }, required: ['id'],
  }, async (a) => {
    try {
      await client.post(`/api/session/${encodeURIComponent(a.id)}/abort`, {}, req(a));
      return toolResult(`Session ${a.id} aborted.`);
    } catch (e) { return toolError(e); }
  });

  R('opencode_session_fork', 'Fork an existing session, optionally at a specific message.', {
    type: 'object',
    properties: { id: { type: 'string' }, messageID: { type: 'string' }, directory: directoryParam },
    required: ['id'],
  }, async (a) => {
    try {
      const body = {};
      if (a.messageID) body.messageID = a.messageID;
      const forked = await client.post(`/api/session/${encodeURIComponent(a.id)}/fork`, body, req(a));
      return toolResult(`Session forked.\n\n${formatSession(forked)}`);
    } catch (e) { return toolError(e); }
  });

  R('opencode_session_share', 'Share a session publicly.', {
    type: 'object', properties: { id: { type: 'string' }, directory: directoryParam }, required: ['id'],
  }, async (a) => {
    try {
      const result = await client.post(`/api/session/${encodeURIComponent(a.id)}/share`, {}, req(a));
      const r = result || {};
      const shareUrl = r.shareUrl ?? r.share?.url ?? null;
      const header = shareUrl ? `Session shared.\nURL: ${shareUrl}` : 'Session shared.';
      return toolResult(`${header}\n\n${formatSession(result)}`);
    } catch (e) { return toolError(e); }
  });

  R('opencode_session_unshare', 'Unshare a previously shared session.', {
    type: 'object', properties: { id: { type: 'string' }, directory: directoryParam }, required: ['id'],
  }, async (a) => {
    try {
      await client.delete(`/api/session/${encodeURIComponent(a.id)}/share`, undefined, req(a));
      return toolResult(`Session ${a.id} unshared.`);
    } catch (e) { return toolError(e); }
  });

  R('opencode_session_diff', 'Get the diff for a session, optionally for a specific message.', {
    type: 'object',
    properties: { id: { type: 'string' }, messageID: { type: 'string' }, directory: directoryParam },
    required: ['id'],
  }, async (a) => {
    try {
      const query = {};
      if (a.messageID) query.messageID = a.messageID;
      const diffs = await client.get(`/api/session/${encodeURIComponent(a.id)}/diff`, query, dir(a));
      return toolResult(formatDiffResponse(Array.isArray(diffs) ? diffs : (diffs?.data || [])));
    } catch (e) { return toolError(e); }
  });

  R('opencode_session_summarize', 'Summarize a session using a model. Long-running (30-60s+).', {
    type: 'object',
    properties: {
      id: { type: 'string' }, providerID: { type: 'string' }, modelID: { type: 'string' },
      variant: { type: 'string' }, directory: directoryParam,
    },
    required: ['id', 'providerID', 'modelID'],
  }, async (a) => {
    try {
      await client.post(`/api/session/${encodeURIComponent(a.id)}/summarize`,
        { providerID: a.providerID, modelID: a.modelID, variant: a.variant }, req(a));
      return toolResult('Session summarization started.');
    } catch (e) { return toolError(e); }
  });

  R('opencode_session_revert', 'Revert a message in a session.', {
    type: 'object',
    properties: { id: { type: 'string' }, messageID: { type: 'string' }, partID: { type: 'string' }, directory: directoryParam },
    required: ['id', 'messageID'],
  }, async (a) => {
    try {
      const body = { messageID: a.messageID };
      if (a.partID) body.partID = a.partID;
      await client.post(`/api/session/${encodeURIComponent(a.id)}/revert`, body, req(a));
      return toolResult(`Message ${a.messageID} reverted.`);
    } catch (e) { return toolError(e); }
  });

  R('opencode_session_unrevert', 'Restore all reverted messages in a session.', {
    type: 'object', properties: { id: { type: 'string' }, directory: directoryParam }, required: ['id'],
  }, async (a) => {
    try {
      await client.post(`/api/session/${encodeURIComponent(a.id)}/unrevert`, {}, req(a));
      return toolResult('All reverted messages restored.');
    } catch (e) { return toolError(e); }
  });

  R('opencode_permission_list', 'List pending permission requests across all sessions. Respond with opencode_session_permission.', {
    type: 'object', properties: { directory: directoryParam },
  }, async (a) => {
    try {
      const requests = await client.get('/api/permission', undefined, dir(a));
      const arr = Array.isArray(requests) ? requests : (requests?.data || []);
      if (!arr.length) return toolResult('No pending permission requests.');
      const lines = arr.map((r) => {
        const id = r.id ?? '?';
        const session = r.sessionID ?? '?';
        const perm = r.permission ?? '?';
        const patterns = Array.isArray(r.patterns) ? r.patterns.join(', ') : '';
        let line = `- **${perm}** [${id}] (session: ${session})`;
        if (patterns) line += `\n  Patterns: ${patterns}`;
        return line;
      });
      return toolResult(
        `## Pending Permission Requests (${arr.length})\n\n${lines.join('\n\n')}\n\n` +
        `Respond with: opencode_session_permission({id, permissionID, reply: "once"|"always"|"reject"})`,
      );
    } catch (e) {
      // /api/permission may be absent on some 2.x servers — report cleanly
      return toolError(new Error(`Could not list permissions: ${e.message}`));
    }
  });

  R('opencode_session_permission', "Respond to a permission request: reply 'once'|'always'|'reject'.", {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Session ID' },
      permissionID: { type: 'string' },
      reply: { type: 'string', enum: ['once', 'always', 'reject'] },
      directory: directoryParam,
    },
    required: ['id', 'permissionID', 'reply'],
  }, async (a) => {
    try {
      try {
        await client.post(`/api/permission/${encodeURIComponent(a.permissionID)}/reply`, { reply: a.reply }, req(a));
        return toolResult(`Permission ${a.reply === 'reject' ? 'rejected' : 'approved'} (${a.reply}).`);
      } catch {
        await client.post(`/api/session/${encodeURIComponent(a.id)}/permissions/${encodeURIComponent(a.permissionID)}`,
          { response: a.reply }, req(a));
        return toolResult(`Permission ${a.reply === 'reject' ? 'rejected' : 'approved'} (${a.reply}).`);
      }
    } catch (e) { return toolError(e); }
  });

  R('opencode_session_search', 'Search sessions by keyword in title.', {
    type: 'object', properties: { query: { type: 'string' }, directory: directoryParam }, required: ['query'],
  }, async (a) => {
    try {
      const sessions = await client.get('/api/session', undefined, dir(a));
      const arr = Array.isArray(sessions) ? sessions : (sessions?.data || []);
      if (!arr.length) return toolResult('No sessions found.', false, { data: [] });
      const q = String(a.query).toLowerCase();
      const matches = arr.filter((s) =>
        String(s.title || '').toLowerCase().includes(q) || String(s.id || '').toLowerCase().includes(q));
      if (!matches.length) {
        return toolResult(`No sessions matching: "${a.query}"\n\nTotal: ${arr.length}.`, false, { data: [] });
      }
      return toolResult(`## Sessions matching "${a.query}" (${matches.length}/${arr.length})\n${formatSessionList(matches)}`, false, { data: matches });
    } catch (e) { return toolError(e); }
  });
}

module.exports = { register };
