/**
 * Layer 1 — JobService (pure-JS re-implementation of upstream src/jobs.ts).
 *
 * OpenCode 2.x has no durable job API, so a "job" here is a *session turn*:
 * we dispatch a prompt (synchronously via /prompt, or fire-and-forget via
 * /prompt_async) and observe the session until the assistant replies or it
 * stops being active. This mirrors upstream JobService's degraded session-
 * observation behavior, but routes to the live 2.x endpoints.
 */
'use strict';

const crypto = require('crypto');

function createMessageId() {
  return 'm' + crypto.randomBytes(8).toString('hex');
}

function createJobId() {
  return 'job_' + crypto.randomBytes(8).toString('hex');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Observe a session until the assistant responds or it is no longer active.
 * @returns a snapshot: { sessionId, status, text, messageCount, ... }
 */
async function observeSession(client, sessionId, { messageId, directory, pollMs = 1500, deadline = 150000 } = {}) {
  const start = Date.now();
  let lastAssistant = '';
  let sawAssistant = false;
  while (Date.now() - start < deadline) {
    await sleep(pollMs);
    let msgs = [];
    try {
      msgs = await client.get(`/api/session/${encodeURIComponent(sessionId)}/message`, undefined, directory);
    } catch {
      /* ignore transient read failures while polling */
    }
    const arr = Array.isArray(msgs) ? msgs : (msgs?.data || []);
    const assistant = arr.filter((m) => m && (m.type === 'assistant' || (m.type && m.type !== 'user' && !m.error)));
    if (assistant.length) {
      lastAssistant = assistant.map((m) => extractText(m)).join('\n---\n');
      sawAssistant = true;
    }
    let active = false;
    try {
      const act = await client.get('/api/session/active', undefined, directory);
      const actArr = Array.isArray(act) ? act : (act?.data || []);
      active = actArr.some((s) => s && s.id === sessionId);
    } catch {
      active = true; // if we can't tell, keep waiting a bit
    }
    if (!active && sawAssistant) return { sessionId, status: 'completed', text: lastAssistant, messageCount: arr.length };
    if (!active && !sawAssistant) return { sessionId, status: 'completed', text: lastAssistant, note: 'Session idle with no captured assistant text', messageCount: arr.length };
    if (messageId) {
      const matched = arr.find((m) => m && m.id === messageId && m.type === 'assistant');
      if (matched) return { sessionId, status: 'completed', text: extractText(matched), messageCount: arr.length };
    }
  }
  return { sessionId, status: 'timeout', text: lastAssistant, note: 'Observation timed out' };
}

function extractText(m) {
  if (!m) return '';
  if (typeof m === 'string') return m;
  if (m.text != null) return String(m.text);
  if (m.payload && m.payload.text != null) return String(m.payload.text);
  if (Array.isArray(m.parts)) {
    return m.parts.map((p) => (p && p.text != null ? String(p.text) : '')).join('');
  }
  if (m.content != null) return typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
  return '';
}

class JobService {
  constructor(client) {
    this.client = client;
  }

  /**
   * Dispatch a prompt and return immediately with a job snapshot (fire).
   * Uses /prompt_async when available; falls back to /prompt.
   */
  async start({ prompt, sessionId, title, directory, model, variant, agent, format }, { signal } = {}) {
    const client = this.client;
    let sid = sessionId;
    if (!sid) {
      const created = await client.post('/api/session', { title: title || 'wb-job', location: directory || null }, { directory });
      sid = created?.id;
      if (!sid) throw new Error('Could not create a session (no id returned)');
    }
    const messageId = createMessageId();
    const body = {
      messageID: messageId,
      parts: [{ type: 'text', text: prompt }],
    };
    if (model && (model.providerID || model.modelID)) body.model = model;
    if (variant) body.variant = variant;
    if (agent) body.agent = agent;
    if (format) body.format = format;

    let accepted = false;
    // 2.0.30 exposes /prompt (POST) but NOT /prompt_async. Try the sync
    // prompt first; if a future build adds prompt_async, use it for true
    // fire-and-forget.
    try {
      await client.post(`/api/session/${encodeURIComponent(sid)}/prompt`, body, { directory });
      accepted = true;
    } catch {
      try {
        await client.post(`/api/session/${encodeURIComponent(sid)}/prompt_async`, body, { directory });
        accepted = true;
      } catch {
        accepted = false;
      }
    }
    const jobId = createJobId();
    return {
      jobId,
      sessionId: sid,
      messageId,
      directory,
      status: accepted ? 'accepted' : 'dispatch_failed',
      note: accepted ? 'Task dispatched via /prompt' : 'Dispatch failed — no usable prompt route on this build',
    };
  }

  /** Observe a previously dispatched job (by sessionId). */
  async get(jobId, { sessionId, directory, pollMs, deadline } = {}) {
    return observeSession(this.client, sessionId, { directory, pollMs, deadline });
  }
}

module.exports = { JobService, JobSnapshot: Object, observeSession, createMessageId, createJobId };
