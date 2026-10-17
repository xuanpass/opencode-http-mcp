/**
 * Tool group: workflow (upstream src/tools/workflow.ts)
 * High-level composite operations. Routes pinned to live-verified 2.0.30.
 *
 * Durable job model (JobService, persistent): a "job" is a session turn with
 * a durable jobId. start() submits once (fire); get(jobId) observes ONCE —
 * the WAIT loop lives here in waitForSnapshot, mirroring upstream. The
 * session-observation helper (observeSession) is shared by the
 * session-based tools and the job engine.
 *
 * 2.0.30 honest degradation: /prompt_async, /session/{id}/abort and the
 * /question /permission reply routes 404 — the JobService surfaces these as
 * "unknown" states with explanatory notes rather than crashing, and
 * fire-and-forget / check / wait / job_list / job_update / job_cancel all
 * remain usable.
 */
'use strict';
const {
  toolResult, toolError, formatMessageResponse, formatMessageList,
  formatSessionList, analyzeMessageResponse, formatDiffResponse,
  resolveSessionStatus, isProviderConfigured, applyModelDefaults,
  redactSecrets, directoryParam, waitForSnapshot,
} = require('../helpers.js');
const { dir, req } = require('../util.js');
const { observeSession } = require('../jobs.js');

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
      // 2.0.30's /prompt is fire-and-forget (returns the user message, not the
      // assistant reply), so a one-shot ask must dispatch AND observe via the
      // JobService rather than treating the POST response as the answer.
      const model = applyModelDefaults(a.providerID, a.modelID);
      const started = await jobs.start(
        { prompt: a.prompt, sessionId: a.sessionId, title: a.title ?? String(a.prompt).slice(0, 80),
          directory: a.directory, model, variant: a.variant, agent: a.agent, format: a.format, system: a.system },
        {});
      sessionId = started.sessionId;
      if (['failed', 'unknown', 'cancelled', 'input_required'].includes(started.status)) {
        return toolResult(`Session: ${sessionId}\nStatus: ${started.status}\n${started.error ? `Error: ${JSON.stringify(started.error)}` : ''}`, true, started);
      }
      const obs = await waitForSnapshot(jobs, started.jobId, 300, 1500, {});
      const lines = [`Session: ${sessionId}`];
      if (obs.error) lines.push(`--- WARNING ---\n${JSON.stringify(obs.error)}`);
      if (obs.text) lines.push(obs.text);
      return toolResult(lines.join('\n\n') || 'Empty response.', obs.status === 'failed' || obs.timedOut, { sessionId, jobId: started.jobId, status: obs.status, data: obs });
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
      // Fire-and-forget /prompt → observe the turn via the JobService so we
      // return the assistant's reply, not the user message we just sent.
      const model = applyModelDefaults(a.providerID, a.modelID);
      const started = await jobs.start(
        { prompt: a.prompt, sessionId: a.sessionId, directory: a.directory,
          model, variant: a.variant, agent: a.agent, format: a.format },
        {});
      if (['failed', 'unknown', 'cancelled', 'input_required'].includes(started.status)) {
        return toolResult(`Session: ${a.sessionId}\nStatus: ${started.status}\n${started.error ? `Error: ${JSON.stringify(started.error)}` : ''}`, true, started);
      }
      const obs = await waitForSnapshot(jobs, started.jobId, 300, 1500, {});
      const lines = [];
      if (obs.error) lines.push(`--- WARNING ---\n${JSON.stringify(obs.error)}`);
      if (obs.text) lines.push(obs.text);
      return toolResult(lines.join('\n\n') || 'Empty response.', obs.status === 'failed' || obs.timedOut, { sessionId: a.sessionId, jobId: started.jobId, status: obs.status, data: obs });
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

  // ─── Wait for a job / session turn ────────────────────────────────
  R('opencode_wait', 'Wait for a job (jobId) or a session turn (sessionId) to complete. A timeout leaves the remote job running; resume with a longer wait.', {
    type: 'object',
    properties: {
      jobId: { type: 'string' },
      sessionId: { type: 'string' }, messageId: { type: 'string' },
      timeoutSeconds: { type: 'number', maximum: 86400 },
      pollIntervalMs: { type: 'number', minimum: 10, maximum: 60000 },
      directory: directoryParam,
    },
  }, async (a) => {
    if (!a.jobId && !a.sessionId) {
      return toolResult('Provide jobId (durable job) or sessionId (ad-hoc session) to wait on.', true);
    }
    try {
      // Durable job path: delegate the whole wait to the JobService.
      if (a.jobId) {
        const seconds = a.timeoutSeconds ?? 120;
        const obs = await waitForSnapshot(jobs, a.jobId, seconds, a.pollIntervalMs ?? 1000, {});
        const lines = [`Job: ${obs.jobId ?? a.jobId}`, `Session: ${obs.sessionId ?? ''}`, `Status: ${obs.status}`];
        if (obs.error) lines.push(`Error: ${JSON.stringify(obs.error)}`);
        if (obs.text) lines.push(obs.text);
        if (obs.note) lines.push(obs.note);
        return toolResult(lines.join('\n'), obs.status === 'failed' || obs.timedOut, obs);
      }
      // Ad-hoc session path: single-shot observeSession, no durable job record.
      const deadline = (a.timeoutSeconds ?? 120) * 1000;
      const pollMs = a.pollIntervalMs ?? 2000;
      const start = Date.now();
      let obs = { status: 'unknown' };
      while (Date.now() - start < deadline) {
        await sleep(pollMs);
        try {
          obs = await observeSession(client, a.sessionId, dir(a), a.messageId);
        } catch { /* keep polling */ }
        if (['completed', 'failed', 'cancelled', 'input_required'].includes(obs.status)) break;
      }
      const lines = [`Session: ${a.sessionId}`, `Status: ${obs.status}`];
      if (obs.error) lines.push(`Error: ${JSON.stringify(obs.error)}`);
      if (obs.text) lines.push(obs.text);
      const done = ['completed'].includes(obs.status);
      return toolResult(lines.join('\n'), !done && obs.status !== 'input_required', obs);
    } catch (e) {
      return { ...toolError(e), structuredContent: { jobId: a.jobId, sessionId: a.sessionId, status: 'unknown' } };
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
      // Fire-and-forget /prompt → observe via the JobService (we must not
      // treat the immediate POST response as the model's reply).
      const started = await jobs.start(
        { prompt: 'Say hello in one word.', sessionId: undefined, title: `[test] ${a.providerId}`,
          directory: a.directory, model: { providerID: a.providerId, modelID }, variant: a.variant, format: a.format },
        {});
      sessionId = started.sessionId;
      if (['failed', 'unknown', 'cancelled', 'input_required'].includes(started.status)) {
        try { await client.delete(`/api/session/${encodeURIComponent(sessionId)}`, undefined, req(a)); } catch { /* best-effort */ }
        return toolResult(`Provider "${a.providerId}" FAILED.\n\n${started.error ? JSON.stringify(started.error) : 'No response received.'}`, true, { sessionId, data: started });
      }
      const obs = await waitForSnapshot(jobs, started.jobId, 120, 1500, {});
      try { await client.delete(`/api/session/${encodeURIComponent(sessionId)}`, undefined, req(a)); } catch { /* best-effort */ }
      if (obs.status === 'failed' || obs.timedOut || !obs.text) {
        return toolResult(`Provider "${a.providerId}" FAILED.\n\n${obs.error ? JSON.stringify(obs.error) : (obs.timedOut ? 'Timed out waiting for a reply.' : 'No response received.')}`, true, { sessionId, data: obs });
      }
      const preview = obs.text.length > 200 ? obs.text.slice(0, 200) + '...' : obs.text;
      return toolResult(`Provider "${a.providerId}" is working.\n\nResponse: ${preview}`, false, { sessionId, providerId: a.providerId, modelID, data: obs });
    } catch (e) {
      if (sessionId) { try { await client.delete(`/api/session/${encodeURIComponent(sessionId)}`, undefined, req(a)); } catch { /* ignore */ } }
      return { ...toolError(e), structuredContent: { sessionId, providerId: a.providerId } };
    }
  });

  // ─── Durable dispatch and observation ──────────────────────────────
  R('opencode_run', 'Send a task and wait for its correlated response. Returns a durable job id; an observation timeout leaves the remote job running and can be resumed with opencode_check.', {
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
      if (['failed', 'unknown', 'cancelled', 'input_required'].includes(snapshot.status)) {
        return toolResult(
          `Job: ${snapshot.jobId}\nSession: ${snapshot.sessionId}\nStatus: ${snapshot.status}\n${snapshot.error ? `Error: ${JSON.stringify(snapshot.error)}` : (snapshot.note || '')}`,
          true, snapshot);
      }
      const seconds = a.maxDurationSeconds ?? 600;
      const obs = await waitForSnapshot(jobs, snapshot.jobId, seconds, 1000, {});
      const lines = [
        `Job: ${obs.jobId ?? snapshot.jobId}`,
        `Session: ${obs.sessionId ?? snapshot.sessionId}`,
        `Status: ${obs.status}`,
      ];
      if (obs.error) lines.push(`Error: ${JSON.stringify(obs.error)}`);
      if (obs.text) lines.push(obs.text);
      return toolResult(lines.join('\n'), obs.status === 'failed' || obs.timedOut, obs);
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
        ? `Task dispatched. Use opencode_check({jobId: "${snap.jobId}"}) or opencode_wait({jobId: "${snap.jobId}"}) to observe it.`
        : (snap.error ? `Error: ${JSON.stringify(snap.error)}` : (snap.note || ''));
      return toolResult(
        `Job: ${snap.jobId}\nSession: ${snap.sessionId ?? '(pending)'}\nStatus: ${snap.status}\n${note}`,
        snap.status !== 'accepted',
        snap,
      );
    } catch (e) {
      return toolResult(`Dispatch failed: ${e.message}`, true, { status: 'failed' });
    }
  });

  R('opencode_check', 'Get current task status. Pass jobId (durable job) or sessionId (ad-hoc) for an exact read; detailed includes response text and pending inputs.', {
    type: 'object',
    properties: {
      jobId: { type: 'string' }, sessionId: { type: 'string' },
      detailed: { type: 'boolean' }, directory: directoryParam,
    },
  }, async (a) => {
    if (!a.jobId && !a.sessionId) return toolResult('Provide jobId or sessionId to check.', true);
    try {
      let obs;
      if (a.jobId) obs = await jobs.get(a.jobId);
      else obs = await observeSession(client, a.sessionId, dir(a), undefined);
      const lines = [];
      if (obs.jobId) lines.push(`Job: ${obs.jobId}`);
      lines.push(`Session: ${obs.sessionId ?? a.sessionId}`);
      lines.push(`Status: ${obs.status}`);
      if (a.detailed && obs.error) lines.push(`Error: ${JSON.stringify(obs.error)}`);
      if (a.detailed && obs.text) lines.push(`### Last message\n${String(obs.text).slice(0, 1000)}`);
      if (obs.inputs && obs.inputs.length) lines.push(`Pending inputs: ${obs.inputs.map((i) => `${i.kind}:${i.id}`).join(', ')}`);
      return toolResult(lines.join('\n'), obs.status === 'failed', obs);
    } catch (e) {
      return { ...toolError(e), structuredContent: { jobId: a.jobId, sessionId: a.sessionId, status: 'unknown' } };
    }
  });

  R('opencode_job_list', 'List durable jobs (newest first) still within their TTL.', {
    type: 'object',
    properties: { limit: { type: 'number', minimum: 1, maximum: 1000 } },
  }, async (a) => {
    try {
      const items = await jobs.list(a.limit ?? 50);
      if (!items.length) return toolResult('No durable jobs recorded for this scope.');
      const lines = items.map((j) => {
        const created = j.createdAt ? new Date(j.createdAt).toISOString() : '?';
        return `- ${j.jobId}\n    status: ${j.status}\n    session: ${j.sessionId ?? '(pending)'}\n    created: ${created}${j.error ? `\n    error: ${JSON.stringify(j.error)}` : ''}`;
      });
      return toolResult(`## Durable jobs (${items.length})\n${lines.join('\n')}`, false, { jobs: items });
    } catch (e) { return toolError(e); }
  });

  R('opencode_job_cancel', 'Cancel a durable job. Refuses to abort a session whose newest turn is a different (newer) job.', {
    type: 'object',
    properties: { jobId: { type: 'string' } },
    required: ['jobId'],
  }, async (a) => {
    try {
      const snap = await jobs.cancel(a.jobId);
      const lines = [`Job: ${snap.jobId}`, `Session: ${snap.sessionId ?? ''}`, `Status: ${snap.status}`];
      if (snap.error) lines.push(`Error: ${JSON.stringify(snap.error)}`);
      return toolResult(lines.join('\n'), snap.status === 'failed', snap);
    } catch (e) {
      return { ...toolError(e), structuredContent: { jobId: a.jobId, status: 'unknown' } };
    }
  });

  R('opencode_job_update', 'Answer a job\'s pending question/permission inputs. Pass the input id, kind, and (for questions) the array of answers, or (for permissions) a reply of once/always/reject.', {
    type: 'object',
    properties: {
      jobId: { type: 'string' },
      responses: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            kind: { type: 'string', enum: ['question', 'permission'] },
            answers: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
            reply: { type: 'string', enum: ['once', 'always', 'reject'] },
            reject: { type: 'boolean' },
            message: { type: 'string' },
          },
          required: ['id', 'kind'],
        },
      },
    },
    required: ['jobId', 'responses'],
  }, async (a) => {
    try {
      const snap = await jobs.update(a.jobId, a.responses || []);
      const lines = [`Job: ${snap.jobId}`, `Session: ${snap.sessionId ?? ''}`, `Status: ${snap.status}`];
      if (snap.error) lines.push(`Error: ${JSON.stringify(snap.error)}`);
      if (snap.text) lines.push(snap.text);
      return toolResult(lines.join('\n'), snap.status === 'failed', snap);
    } catch (e) {
      return { ...toolError(e), structuredContent: { jobId: a.jobId, status: 'unknown' } };
    }
  });

  // ─── Quick status dashboard ────────────────────────────────────────
  R('opencode_status', 'Get a quick status dashboard: server health, provider count, session count, and VCS info.', {
    type: 'object', properties: { directory: directoryParam },
  }, async (a) => {
    try {
      const d = dir(a);
      let healthOk = false;
      let health = null;
      try { health = await client.get('/global/health', undefined, d); healthOk = true; } catch { healthOk = false; }
      const [providerRaw, sessions, vcs] = await Promise.all([
        client.get('/api/provider', undefined, d).catch(() => null),
        client.get('/api/session', undefined, d).catch(() => null),
        client.get('/api/vcs', undefined, d).catch(() => null),
      ]);
      const lines = [];
      if (healthOk) lines.push(`Server: healthy (v${(health && health.version) ?? '?'})`);
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
