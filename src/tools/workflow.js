/**
 * Tool group: workflow (upstream src/tools/workflow.ts)
 * High-level composite operations. Routes pinned to live-verified 2.0.30.
 * Sub-routes that DO NOT exist on 2.0.30 (abort, todo, status, share,
 * summarize, revert, unrevert, children, permissions) are NOT called;
 * the session-turn JobService model observes /message + /active only.
 */
'use strict';
const {
  toolResult, toolError, formatMessageResponse, formatMessageList,
  formatSessionList, analyzeMessageResponse, formatDiffResponse,
  resolveSessionStatus, isProviderConfigured, applyModelDefaults,
  redactSecrets, directoryParam,
} = require('../helpers.js');
const { dir, req, modelOpts } = require('../util.js');

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function register(registry, ctx) {
  const { client, jobs } = ctx;
  const R = (name, desc, schema, fn) => registry.tool(name, desc, { inputSchema: schema, run: fn });

  // ─── Setup / onboarding ─────────────────────────────────────────────
  R('opencode_setup', 'Check OpenCode status, provider configuration, and project. Use as the first step when starting work.', {
    type: 'object', properties: { directory: directoryParam },
  }, async (a) => {
    const sections = [];
    let healthy = false;
    try {
      const health = await client.get('/global/health', undefined, dir(a));
      healthy = true;
      sections.push(`## Server\nStatus: healthy\nVersion: ${(health && health.version) ?? 'unknown'}`);
    } catch (e) {
      sections.push(`## Server\nStatus: UNREACHABLE\nError: ${e.message}`);
      return toolResult(sections.join('\n\n'));
    }
    try {
      const raw = await client.get('/api/provider', undefined, dir(a));
      const providers = providersOf(raw);
      if (Array.isArray(providers) && providers.length > 0) {
        const ready = providers.filter(isProviderConfigured);
        const lines = [];
        if (ready.length) {
          lines.push('**Ready to use:**');
          for (const p of ready) lines.push(`- ${p.id}: ${countModels(p)} models`);
        } else {
          lines.push('**No providers configured yet.** Set an API key via env var and restart opencode.');
        }
        sections.push(`## Providers (${providers.length} available)\n${lines.join('\n')}`);
      } else {
        sections.push('## Providers\nNo providers found.');
      }
    } catch {
      sections.push('## Providers\nCould not fetch provider list.');
    }
    sections.push('## Next Steps\n- `opencode_ask` to start a conversation\n- `opencode_context` for full project context');
    return toolResult(sections.join('\n\n'));
  });

  // ─── One-shot ask ───────────────────────────────────────────────────
  R('opencode_ask', 'Ask OpenCode in one step: create a session, send a prompt, return the AI response.', {
    type: 'object',
    properties: {
      prompt: { type: 'string' }, title: { type: 'string' },
      providerID: { type: 'string' }, modelID: { type: 'string' },
      variant: { type: 'string' }, agent: { type: 'string' },
      system: { type: 'string' }, format: { type: 'string' },
      directory: directoryParam,
    },
    required: ['prompt'],
  }, async (a) => {
    let sessionId;
    try {
      const session = await client.post('/api/session', { title: a.title ?? String(a.prompt).slice(0, 80), location: a.directory || null }, req(a));
      sessionId = session?.id;
      if (!sessionId) throw new Error('OpenCode returned a session without an ID');
      const body = { parts: [{ type: 'text', text: a.prompt }] };
      Object.assign(body, modelOpts(a));
      if (a.system) body.system = a.system;
      const response = await client.post(`/api/session/${encodeURIComponent(sessionId)}/prompt`, body, req(a));
      const analysis = analyzeMessageResponse(response);
      const formatted = formatMessageResponse(response);
      const parts = [`Session: ${sessionId}`];
      if (formatted) parts.push(formatted);
      if (analysis.warning) parts.push(`\n--- WARNING ---\n${analysis.warning}`);
      return toolResult(parts.join('\n\n'), analysis.hasError, { sessionId, data: response });
    } catch (e) {
      return { ...toolError(e), structuredContent: { sessionId, directory: a.directory } };
    }
  });

  // ─── Continue a conversation ───────────────────────────────────────
  R('opencode_reply', 'Send a follow-up message to an existing session.', {
    type: 'object',
    properties: {
      sessionId: { type: 'string' }, prompt: { type: 'string' },
      providerID: { type: 'string' }, modelID: { type: 'string' },
      variant: { type: 'string' }, agent: { type: 'string' }, format: { type: 'string' },
      directory: directoryParam,
    },
    required: ['sessionId', 'prompt'],
  }, async (a) => {
    try {
      const body = { parts: [{ type: 'text', text: a.prompt }] };
      Object.assign(body, modelOpts(a));
      const response = await client.post(`/api/session/${encodeURIComponent(a.sessionId)}/prompt`, body, req(a));
      const analysis = analyzeMessageResponse(response);
      const formatted = formatMessageResponse(response);
      const parts = [];
      if (formatted) parts.push(formatted);
      if (analysis.warning) parts.push(`\n--- WARNING ---\n${analysis.warning}`);
      return toolResult(parts.join('\n\n') || 'Empty response.', analysis.hasError, { sessionId: a.sessionId, data: response });
    } catch (e) { return { ...toolError(e), structuredContent: { sessionId: a.sessionId, directory: a.directory } }; }
  });

  // ─── Conversation history ──────────────────────────────────────────
  R('opencode_conversation', 'Get the full conversation history of a session, formatted for reading.', {
    type: 'object',
    properties: { sessionId: { type: 'string' }, limit: { type: 'number' }, directory: directoryParam },
    required: ['sessionId'],
  }, async (a) => {
    try {
      const query = {};
      if (a.limit !== undefined) query.limit = String(a.limit);
      const messages = await client.get(`/api/session/${encodeURIComponent(a.sessionId)}/message`, query, dir(a));
      const arr = Array.isArray(messages) ? messages : (messages?.data || []);
      return toolResult(formatMessageList(arr, a.limit), false, { sessionId: a.sessionId, data: arr });
    } catch (e) { return toolError(e); }
  });

  // ─── Quick session overview ────────────────────────────────────────
  R('opencode_sessions_overview', 'Get a quick overview of all sessions with titles and status.', {
    type: 'object', properties: { directory: directoryParam },
  }, async (a) => {
    try {
      const sessions = await client.get('/api/session', undefined, dir(a));
      const arr = Array.isArray(sessions) ? sessions : (sessions?.data || []);
      if (!arr.length) return toolResult('No sessions found.');
      const lines = arr.map((s) => {
        const id = s.id ?? '?';
        const title = s.title ?? '(untitled)';
        const parentTag = s.parentID ? ` (child of ${s.parentID})` : '';
        return `- [${s.status ?? 'unknown'}] ${title} [${id}]${parentTag}`;
      });
      return toolResult(`## Sessions (${arr.length})\n${lines.join('\n')}`, false, { data: arr });
    } catch (e) { return toolError(e); }
  });

  // ─── Project context ───────────────────────────────────────────────
  R('opencode_context', 'Get project context in one call: project, path, VCS, config, agents.', {
    type: 'object', properties: { directory: directoryParam },
  }, async (a) => {
    try {
      const d = dir(a);
      const [vcs, config, agents] = await Promise.all([
        client.get('/api/vcs', undefined, d).catch(() => null),
        client.get('/api/config', undefined, d).catch(() => null),
        client.get('/api/agent', undefined, d).catch(() => null),
      ]);
      const sections = [];
      if (vcs) {
        const lines = [];
        if (vcs.branch) lines.push(`Branch: ${vcs.branch}`);
        if (vcs.remote) lines.push(`Remote: ${vcs.remote}`);
        if (vcs.sha) lines.push(`HEAD: ${vcs.sha}`);
        if (vcs.dirty !== undefined) lines.push(`Dirty: ${vcs.dirty}`);
        sections.push(`## VCS (Git)\n${lines.length ? lines.join('\n') : 'No VCS info.'}`);
      }
      if (config) {
        const c = redactSecrets(config) || {};
        const top = [];
        for (const [k, v] of Object.entries(c)) {
          if (v && typeof v === 'object' && !Array.isArray(v)) top.push(`${k}: {${Object.keys(v).length} entries}`);
          else if (Array.isArray(v)) top.push(`${k}: [${v.length} items]`);
          else top.push(`${k}: ${v}`);
        }
        sections.push(`## Config\n${top.join('\n')}`);
      }
      if (agents && Array.isArray(agents)) {
        sections.push(`## Agents (${agents.length})\n${agents.map((ag) => `- ${ag.name ?? ag.id ?? '?'}: ${ag.description ?? ''} [${ag.mode ?? '?'}]`).join('\n')}`);
      }
      return toolResult(sections.join('\n\n') || 'No context available.');
    } catch (e) { return toolError(e); }
  });

  // ─── Wait for a session turn ───────────────────────────────────────
  R('opencode_wait', 'Wait for a session turn to complete by observing /message + /active.', {
    type: 'object',
    properties: {
      sessionId: { type: 'string' }, messageId: { type: 'string' },
      timeoutSeconds: { type: 'number', maximum: 86400 },
      pollIntervalMs: { type: 'number', minimum: 10, maximum: 60000 },
      directory: directoryParam,
    },
    required: ['sessionId'],
  }, async (a) => {
    try {
      const deadline = (a.timeoutSeconds ?? 120) * 1000;
      const pollMs = a.pollIntervalMs ?? 2000;
      const start = Date.now();
      let lastAssistant = '';
      let sawAssistant = false;
      while (Date.now() - start < deadline) {
        await sleep(pollMs);
        let arr = [];
        try {
          const msgs = await client.get(`/api/session/${encodeURIComponent(a.sessionId)}/message`, undefined, dir(a));
          arr = Array.isArray(msgs) ? msgs : (msgs?.data || []);
        } catch { /* keep polling */ }
        const assistant = arr.filter((m) => m && m.type === 'assistant');
        if (assistant.length) {
          lastAssistant = assistant.map((m) => formatMessageResponse(m)).join('\n---\n');
          sawAssistant = true;
        }
        if (a.messageId) {
          const matched = arr.find((m) => m && m.id === a.messageId && m.type === 'assistant');
          if (matched) return toolResult(`Status: completed\n\n${formatMessageResponse(matched)}`, false, { sessionId: a.sessionId, messageId: a.messageId, status: 'completed' });
        }
        if (sawAssistant && !arr.some((m) => m && m.type === 'user')) break;
      }
      return toolResult(
        sawAssistant ? `Status: completed\n\n${lastAssistant}` : `Status: timeout\n\nNo assistant reply captured within ${a.timeoutSeconds ?? 120}s.`,
        !sawAssistant,
        { sessionId: a.sessionId, messageId: a.messageId, status: sawAssistant ? 'completed' : 'timeout' },
      );
    } catch (e) {
      return { ...toolError(e), structuredContent: { sessionId: a.sessionId, status: 'unknown' } };
    }
  });

  // ─── Review changes ────────────────────────────────────────────────
  R('opencode_review_changes', 'Get a formatted summary of all file changes made in a session.', {
    type: 'object',
    properties: {
      sessionId: { type: 'string' }, messageID: { type: 'string' }, directory: directoryParam,
    },
    required: ['sessionId'],
  }, async (a) => {
    try {
      const query = {};
      if (a.messageID) query.messageID = a.messageID;
      const diffs = await client.get(`/api/session/${encodeURIComponent(a.sessionId)}/diff`, query, dir(a));
      const arr = Array.isArray(diffs) ? diffs : (diffs?.data || []);
      return toolResult(formatDiffResponse(arr), false, { data: arr });
    } catch (e) { return toolError(e); }
  });

  // ─── Provider test ─────────────────────────────────────────────────
  R('opencode_provider_test', 'Quick-test whether a provider is working. Creates a temp session, sends a trivial prompt, cleans up.', {
    type: 'object',
    properties: {
      providerId: { type: 'string' }, modelID: { type: 'string' },
      variant: { type: 'string' }, format: { type: 'string' }, directory: directoryParam,
    },
    required: ['providerId'],
  }, async (a) => {
    let sessionId = null;
    try {
      let modelID = a.modelID;
      if (!modelID) {
        const raw = await client.get('/api/provider', undefined, dir(a));
        const providers = providersOf(raw);
        const prov = Array.isArray(providers) ? providers.find((p) => p.id === a.providerId) : null;
        modelID = prov && prov.models
          ? (Array.isArray(prov.models) ? prov.models[0]?.id : Object.keys(prov.models)[0])
          : null;
        if (!modelID) throw new Error(`No model discovered for provider "${a.providerId}". Specify modelID.`);
      }
      const session = await client.post('/api/session', { title: `[test] ${a.providerId}`, location: a.directory || null }, req(a));
      sessionId = session?.id;
      const body = { parts: [{ type: 'text', text: 'Say hello in one word.' }] };
      body.model = { providerID: a.providerId, modelID };
      if (a.variant) body.variant = a.variant;
      if (a.format) body.format = a.format;
      const response = await client.post(`/api/session/${encodeURIComponent(sessionId)}/prompt`, body, req(a));
      const analysis = analyzeMessageResponse(response);
      const formatted = formatMessageResponse(response);
      try { await client.delete(`/api/session/${encodeURIComponent(sessionId)}`, undefined, req(a)); } catch { /* best-effort */ }
      if (analysis.hasError || analysis.isEmpty) {
        return toolResult(`Provider "${a.providerId}" FAILED.\n\n${analysis.warning ?? 'No response received.'}`, true, { sessionId, data: response });
      }
      const preview = formatted.length > 200 ? formatted.slice(0, 200) + '...' : formatted;
      return toolResult(`Provider "${a.providerId}" is working.\n\nResponse: ${preview}`, false, { sessionId, providerId: a.providerId, modelID, data: response });
    } catch (e) {
      if (sessionId) { try { await client.delete(`/api/session/${encodeURIComponent(sessionId)}`, undefined, req(a)); } catch { /* ignore */ } }
      return { ...toolError(e), structuredContent: { sessionId, providerId: a.providerId } };
    }
  });

  // ─── Durable dispatch and observation ──────────────────────────────
  R('opencode_run', 'Send a task and wait for its correlated response. Returns a job snapshot; observation timeout leaves the remote session running.', {
    type: 'object',
    properties: {
      prompt: { type: 'string' }, sessionId: { type: 'string' }, title: { type: 'string' },
      providerID: { type: 'string' }, modelID: { type: 'string' },
      variant: { type: 'string' }, agent: { type: 'string' }, format: { type: 'string' },
      maxDurationSeconds: { type: 'number' }, directory: directoryParam,
    },
    required: ['prompt'],
  }, async (a) => {
    let snapshot = { sessionId: a.sessionId ?? '', directory: a.directory, status: 'unknown' };
    try {
      const model = applyModelDefaults(a.providerID, a.modelID);
      snapshot = await jobs.start(
        { prompt: a.prompt, sessionId: a.sessionId, title: a.title, directory: a.directory,
          model, variant: a.variant, agent: a.agent, format: a.format }, {});
      if (['failed', 'unknown', 'cancelled', 'dispatch_failed'].includes(snapshot.status)) {
        return toolResult(`Job: ${snapshot.jobId}\nSession: ${snapshot.sessionId}\nStatus: ${snapshot.status}\n${snapshot.note ?? ''}`, true, snapshot);
      }
      const obs = await jobs.get(snapshot.jobId, {
        sessionId: snapshot.sessionId, directory: a.directory,
        pollMs: 2000, deadline: (a.maxDurationSeconds ?? 600) * 1000,
      });
      return toolResult(
        `Job: ${obs.jobId ?? snapshot.jobId}\nSession: ${obs.sessionId}\nStatus: ${obs.status}\n${obs.text ?? ''}`,
        obs.status === 'timeout',
        obs,
      );
    } catch (e) {
      return toolResult(`Job dispatch failed: ${e.message}`, true, { ...snapshot, status: 'failed', error: e.message });
    }
  });

  R('opencode_fire', 'Dispatch a background task and return its job/session IDs immediately. Use opencode_check or opencode_wait to observe.', {
    type: 'object',
    properties: {
      prompt: { type: 'string' }, sessionId: { type: 'string' }, title: { type: 'string' },
      providerID: { type: 'string' }, modelID: { type: 'string' },
      variant: { type: 'string' }, agent: { type: 'string' }, format: { type: 'string' },
      directory: directoryParam,
    },
    required: ['prompt'],
  }, async (a) => {
    try {
      const model = applyModelDefaults(a.providerID, a.modelID);
      const snap = await jobs.start(
        { prompt: a.prompt, sessionId: a.sessionId, title: a.title, directory: a.directory,
          model, variant: a.variant, agent: a.agent, format: a.format }, {});
      const note = snap.status === 'accepted'
        ? `Task dispatched. Use opencode_wait({sessionId: "${snap.sessionId}"}) to observe.`
        : snap.note;
      return toolResult(
        `Job: ${snap.jobId}\nSession: ${snap.sessionId}\nStatus: ${snap.status}\n${note}`,
        snap.status !== 'accepted',
        snap,
      );
    } catch (e) {
      return toolResult(`Dispatch failed: ${e.message}`, true, { status: 'failed' });
    }
  });

  R('opencode_check', 'Get current task status by observing a session. Pass detailed for full response text.', {
    type: 'object',
    properties: {
      sessionId: { type: 'string' }, detailed: { type: 'boolean' }, directory: directoryParam,
    },
    required: ['sessionId'],
  }, async (a) => {
    try {
      const obs = await jobs.get('check', {
        sessionId: a.sessionId, directory: a.directory,
        pollMs: 1000, deadline: 5000,
      });
      const lines = [];
      lines.push(`Session: ${obs.sessionId}`);
      lines.push(`Status: ${obs.status}`);
      if (a.detailed && obs.text) lines.push(`### Last message\n${obs.text.slice(0, 500)}`);
      return toolResult(lines.join('\n'), obs.status === 'timeout', obs);
    } catch (e) {
      return { ...toolError(e), structuredContent: { sessionId: a.sessionId, status: 'unknown' } };
    }
  });

  // ─── Quick status dashboard ────────────────────────────────────────
  R('opencode_status', 'Get a quick status dashboard: server health, provider count, session count, and VCS info.', {
    type: 'object', properties: { directory: directoryParam },
  }, async (a) => {
    try {
      const d = dir(a);
      const [health, providerRaw, sessions, vcs] = await Promise.all([
        client.get('/global/health', undefined, d).catch(() => null),
        client.get('/api/provider', undefined, d).catch(() => null),
        client.get('/api/session', undefined, d).catch(() => null),
        client.get('/api/vcs', undefined, d).catch(() => null),
      ]);
      const lines = [];
      if (health) lines.push(`Server: healthy (v${(health && health.version) ?? '?'})`);
      else lines.push('Server: UNREACHABLE');
      if (providerRaw) {
        const providers = providersOf(providerRaw);
        if (Array.isArray(providers)) {
          const configured = providers.filter(isProviderConfigured).length;
          lines.push(`Providers: ${configured} configured / ${providers.length} total`);
        }
      }
      if (sessions) {
        const arr = Array.isArray(sessions) ? sessions : (sessions?.data || []);
        lines.push(`Sessions: ${arr.length}`);
      }
      if (vcs) {
        const branch = vcs.branch ?? 'unknown';
        const dirty = vcs.dirty === true ? ' (dirty)' : vcs.dirty === false ? ' (clean)' : '';
        lines.push(`Branch: ${branch}${dirty}`);
      }
      return toolResult(`## Status\n${lines.join('\n')}`);
    } catch (e) { return toolError(e); }
  });
}

module.exports = { register };
