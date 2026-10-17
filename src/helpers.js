/**
 * Layer 0.5 — helpers (pure-JS re-implementation of upstream src/helpers.ts)
 *
 * Formatting + small utilities used across tool modules. No external deps.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createRequestContext, abortableSleep, withAbort } = require('./async.js');

/**
 * Observe a durable job until it reaches a terminal or input_required state,
 * or the deadline elapses. Each iteration is a single jobs.get(jobId) (one
 * OpenCode status read) — the loop, not the JobService, owns the wait. A
 * timeout leaves the remote job running and returns the last snapshot so a
 * later check/wait can resume. Shared by the one-shot tools (ask/reply/
 * provider_test/message_send) and the durable tools (run/wait).
 */
async function waitForSnapshot(jobs, jobId, seconds, intervalMs, extra = {}) {
  const timeoutNote = 'Timeout: session still running or its outcome is unknown. Use opencode_check to read progress, opencode_wait to wait longer, or opencode_job_cancel to stop it.';
  let snapshot;
  try { snapshot = await jobs.get(jobId, { signal: extra.signal }); }
  catch (e) { return { status: 'failed', timedOut: false, error: e instanceof Error ? e.message : String(e) }; }
  if (seconds === 0) return { ...snapshot, timedOut: true };
  const context = createRequestContext({ signal: extra.signal, timeout: seconds * 1000 });
  try {
    while (true) {
      snapshot = await withAbort(jobs.get(jobId, { signal: context.signal }), context.signal);
      if (['completed', 'failed', 'cancelled', 'input_required'].includes(snapshot.status)) return snapshot;
      await abortableSleep(Math.min(intervalMs, Math.max(0, context.deadline - Date.now())), context.signal);
    }
  } catch (error) {
    if (context.signal.aborted) {
      if (extra.signal && extra.signal.aborted) return { ...snapshot, observationCancelled: true, note: 'Observation cancelled. The remote session may still be running.' };
      return { ...snapshot, timedOut: true, note: timeoutNote };
    }
    return { ...snapshot, status: 'unknown', error: error instanceof Error ? error.message : String(error) };
  } finally {
    context.dispose();
  }
}

// ── Result envelopes (MCP tool results) ──────────────────────────────
function toolResult(text, isError, structuredContent) {
  const out = { content: [{ type: 'text', text: String(text ?? '') }] };
  if (isError) out.isError = true;
  if (structuredContent) out.structuredContent = structuredContent;
  return out;
}

function toolError(e) {
  const msg = e && e.message ? e.message : String(e);
  return toolResult(`Error: ${msg}`, true);
}

function toolJson(value) {
  return toolResult(JSON.stringify(value, null, 2));
}

// ── Param schema fragments (kept as plain objects, not zod) ──────────
const directoryParam = {
  type: 'string',
  description: 'Project directory to target. Optional; defaults to the server default project.',
};

/**
 * Validate a project directory before it is forwarded as the
 * `x-opencode-directory` header. Rejects control bytes (header
 * smuggling), and requires an absolute path on the OpenCode server's
 * filesystem — a client-relative path would silently target the wrong
 * project. Mirrors upstream src/helpers.ts::normalizeDirectory.
 * @returns the directory (string), or undefined when empty.
 */
function normalizeDirectory(directory) {
  if (!directory) return undefined;
  // Reject control bytes that could smuggle headers when forwarded.
  if (/[\0\r\n]/.test(directory)) {
    throw new Error('Invalid directory: path must not contain NUL or CR/LF characters.');
  }
  // Absolute on POSIX or on Windows (C:\, C:/ or \\server\share UNC).
  const posixAbs = path.posix.isAbsolute(directory);
  const windowsAbs = /^[a-z]:[\\/]/i.test(directory) || /^\\\\[^\\]+\\[^\\]+/i.test(directory);
  if (!posixAbs && !windowsAbs) {
    throw new Error(
      `Invalid directory: "${directory}" is not an absolute path. ` +
      'Use an absolute path on the OpenCode server, not a client-relative path.',
    );
  }
  return directory;
}

// ── Message / response formatting ────────────────────────────────────
function fmtText(msg) {
  if (msg == null) return '';
  if (typeof msg === 'string') return msg;
  if (msg.text != null) return String(msg.text);
  if (msg.payload && msg.payload.text != null) return String(msg.payload.text);
  if (Array.isArray(msg.parts)) {
    return msg.parts.map((p) => (p && p.text != null ? String(p.text) : '')).join('');
  }
  // 2.x message rows carry text in content[] (array of {type,text}); the 1.x
  // parts[] layout is handled above.
  if (Array.isArray(msg.content)) {
    return msg.content.map((p) => (p && p.text != null ? String(p.text) : '')).join('');
  }
  if (msg.content != null) {
    return typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  }
  return JSON.stringify(msg);
}

function roleOf(m) {
  if (!m || !m.type) return m?.role || '?';
  if (m.type === 'user') return 'user';
  if (m.type === 'assistant') return 'assistant';
  return m.type;
}

function formatMessageResponse(msg) {
  if (msg == null) return '';
  if (typeof msg === 'string') return msg;
  const lines = [];
  const role = roleOf(msg);
  if (role) lines.push(`[${role}]`);
  const text = fmtText(msg);
  if (text) lines.push(text);
  // surface parts for richer content
  if (Array.isArray(msg.parts)) {
    for (const p of msg.parts) {
      if (p && p.type === 'text' && p.text) lines.push(p.text);
      else if (p && p.type === 'file') lines.push(`[file] ${p.file?.url || p.file?.path || ''}`);
      else if (p && p.type === 'reasoning') lines.push(`[reasoning] ${String(p.text || '').slice(0, 400)}`);
      else if (p && p.type === 'tool') lines.push(`[tool] ${p.tool || p.name || ''} ${p.state?.status || ''}`.trim());
    }
  }
  return lines.join('\n');
}

function analyzeMessageResponse(msg) {
  const hasError = !!(msg && (msg.error || (msg.info && msg.info.error)));
  const text = fmtText(msg);
  const isEmpty = !hasError && !text.trim();
  let warning = '';
  if (msg && msg.error) warning = `Message error: ${String(msg.error)}`;
  else if (isEmpty) {
    const prov = msg && (msg.providerID || (msg.info && msg.info.providerID));
    const model = msg && (msg.modelID || (msg.info && msg.info.modelID));
    if (prov) {
      warning =
        `Empty response (provider ${prov}${model ? `, model ${model}` : ''}). ` +
        'Check that the provider/model is configured and has a valid API key, or that the model has not moved.';
    }
  }
  return { hasError, isEmpty, warning };
}

function formatMessageList(messages, limit) {
  if (!Array.isArray(messages)) return `No messages found.\nRaw: ${JSON.stringify(messages)}`;
  const list = limit ? messages.slice(0, limit) : messages;
  if (list.length === 0) return 'No messages yet.';
  return list.map((m, i) => {
    const role = roleOf(m);
    const time = m.time && m.time.updated ? new Date(m.time.updated).toISOString() : '';
    const text = fmtText(m);
    return `--- ${i + 1}. [${role}] ${time}\n${text}`;
  }).join('\n\n');
}

// ── Session formatting ───────────────────────────────────────────────
function formatSessionList(sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) return 'No sessions found.';
  const lines = sessions.map((s) => {
    const id = s.id || '?';
    const title = s.title || s.name || '(untitled)';
    const dir = s.location?.directory || s.directory || '';
    const up = s.time?.updated ? new Date(s.time.updated).toISOString() : s.updatedAt || '';
    return `- ${title} [${id}]${dir ? ` (${dir})` : ''}${up ? ` — updated ${up}` : ''}`;
  });
  return lines.join('\n');
}

function resolveSessionStatus(raw) {
  if (!raw) return 'idle';
  if (typeof raw === 'string') return raw;
  if (raw.status) return String(raw.status);
  if (raw.type) return String(raw.type);
  return String(raw);
}

// ── Model defaults ────────────────────────────────────────────────────
function applyModelDefaults(providerID, modelID) {
  if (!providerID && !modelID) return undefined;
  return { providerID, modelID };
}

// ── Diff formatting ───────────────────────────────────────────────────
function formatDiffResponse(diffs) {
  if (!Array.isArray(diffs) || diffs.length === 0) return 'No changes.';
  return diffs.map((d) => {
    const file = d.file?.path || d.file || d.path || '?';
    const parts = [];
    if (d.additions) parts.push(`+${d.additions}`);
    if (d.deletions) parts.push(`-${d.deletions}`);
    const body = d.patch || d.content || '';
    const header = `## ${file}${parts.length ? ` (${parts.join(' ')})` : ''}`;
    return body ? `${header}\n${body}` : header;
  }).join('\n\n');
}

// ── Redact secrets from config output ─────────────────────────────────
function redactSecrets(obj) {
  const isSecretKey = (k) => /secret|token|api[_-]?key|password|_key|authorization/i.test(k);
  function walk(v) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    if (Array.isArray(v)) return v.map(walk);
    return v;
  }
  function top(o) {
    if (!o || typeof o !== 'object') return o;
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      out[k] = isSecretKey(k) && typeof v === 'string' ? `***${v.slice(-4)}` : walk(v);
    }
    return out;
  }
  return top(obj);
}

// ── Provider helpers ────────────────────────────────────────────────
function isProviderConfigured(p) {
  if (!p || typeof p !== 'object') return false;
  if (p.configured === true) return true;
  if (Array.isArray(p.env) && p.env.length > 0) return true;
  if (p.apiKey || p.key || p.token) return true;
  return false;
}

module.exports = {
  toolResult,
  toolJson,
  toolError,
  directoryParam,
  normalizeDirectory,
  fmtText,
  roleOf,
  formatMessageResponse,
  analyzeMessageResponse,
  formatMessageList,
  formatSessionList,
  resolveSessionStatus,
  applyModelDefaults,
  formatDiffResponse,
  redactSecrets,
  isProviderConfigured,
  waitForSnapshot,
};
