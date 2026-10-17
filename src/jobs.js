/**
 * Layer 1 — JobService (full persistent port of upstream src/jobs.ts,
 * route-adapted to a live OpenCode 2.0.30 server).
 *
 * A "job" is a durable *session turn*: we submit a prompt to OpenCode and
 * keep a server-side record of that turn (id, session, correlation, status,
 * pending inputs, submitted answers) that survives a bridge restart and can
 * be observed by multiple processes. OpenCode owns the actual prompt
 * execution; this service owns ownership + observation + reply bookkeeping.
 *
 * Fidelity vs upstream 3.0.0:
 *   - storeRoot file store (0o700 dir, 0o600 json, atomic tmp+rename) with a
 *     process-local Map fallback (storeRoot === null, e.g. ephemeral tests).
 *   - per-jobId directory lock (mkdir atomic) with dead-owner recovery via
 *     owner.json {pid,host}; recovery guarded by a unique "recovery" file so
 *     only one process reclaims a stale lock.
 *   - TTL (default 24h) + scope partition keyed on baseUrl + scope string.
 *   - digest-idempotent update(): a reply is recorded "sending" BEFORE the
 *     POST and "sent" after, so an uncertain reply is never blindly replayed.
 *   - cancel() refuses to abort a session whose newest user turn is a
 *     different (newer) turn — OpenCode's abort endpoint is session-wide.
 *
 * 2.x route adaptation — VERIFIED against a live 2.0.30 server:
 *   - POST /prompt takes a TOP-LEVEL `text` field (NOT a parts array), plus
 *     optional model/agent, and is FIRE-AND-FORGET: it returns the user
 *     message in ~0.05s while the assistant turn runs server-side.
 *   - /prompt_async does NOT exist (404) — so the synchronous /prompt is the
 *     only dispatch route and it already has fire-and-forget semantics.
 *   - assistant message rows are FLAT on 2.x:
 *     { id, type, time:{created,streamed,completed}, content:[{type,text}],
 *       finish, agent, model }. The 1.x { info:{role,time,finish} } shape is
 *     also accepted. Text lives in content[] (not parts[]).
 *   - There is no parentID on 2.x rows and the client messageID is not
 *     echoed back, so a turn's assistant is resolved as "the latest
 *     assistant in the session" once no newer user turn has been dispatched.
 *   - /session/{id}/abort does NOT exist (404) — cancel degrades to
 *     status "unknown" with an honest AbortRouteUnavailable note; the turn
 *     ends on its own and a later get() confirms.
 *   - /session/status is not usable as a global map on 2.0.30 — completion
 *     is decided purely from the message stream (assistant completed + a
 *     non-tool-call finish), which is the authoritative signal on 2.x.
 */
'use strict';

const crypto = require('crypto');
const fsPromises = require('fs/promises');
const { homedir, hostname } = require('os');
const { join } = require('path');
const { OpenCodeError, OpenCodeSubmissionError } = require('./http.js');
const {
  createRequestContext, abortableSleep, throwIfAborted, withRequestOptions,
} = require('./async.js');
const { formatMessageResponse, normalizeDirectory } = require('./helpers.js');

// ── ID layout (matches upstream id.ts) ──────────────────────────────
let lastTimestamp = 0;
let idCounter = 0;
/** msg_<12-hex-timestamp><14-hex-random> — strictly ascending per ms. */
function createMessageId() {
  const now = Date.now();
  idCounter = now === lastTimestamp ? idCounter + 1 : 1;
  lastTimestamp = now;
  const encoded = (BigInt(now) * 4096n + BigInt(idCounter)).toString(16).slice(-12).padStart(12, '0');
  return `msg_${encoded}${crypto.randomBytes(7).toString('hex')}`;
}
function createJobId() {
  return 'job_' + crypto.randomUUID().replaceAll('-', '');
}

const segment = (v) => encodeURIComponent(v);
const hash = (v) => crypto.createHash('sha256').update(v).digest('hex');
const isTerminal = (s) => s === 'completed' || s === 'failed' || s === 'cancelled';

/** Persist operational diagnostics only — never the prompt or request body. */
function requestError(error) {
  if (error instanceof OpenCodeSubmissionError) {
    return { name: error.name, message: 'Submission outcome unknown; check this job before retrying.' };
  }
  if (error instanceof OpenCodeError) {
    return { name: error.name, message: 'OpenCode rejected the request', status: error.status };
  }
  return { name: error instanceof Error ? error.name : 'Error', message: 'The request could not be completed' };
}

function publicSnapshot(job) {
  const { version: _v, responses: _r, cancelRequested: _c, ...snapshot } = job;
  return structuredClone(snapshot);
}

/**
 * Normalize a message row into a common shape, accepting both the 2.x flat
 * layout ({ id, type, time, content }) and the 1.x nested layout
 * ({ info:{ id, role, time, finish } }).
 */
function normMsg(m) {
  if (!m) return null;
  const info = m.info || m;
  const role = info.role || m.type || null;
  const time = info.time || m.time || {};
  return {
    id: info.id || m.id || null,
    role,
    parentID: info.parentID || m.parentID || null,
    created: typeof time.created === 'number' ? time.created : (typeof time.updated === 'number' ? time.updated : 0),
    completed: time.completed,
    finish: info.finish || m.finish || null,
    structured: info.structured,
    error: info.error || m.error,
    raw: m,
  };
}

/**
 * Read pending question/permission requests belonging to a session.
 * Routes are optional on 2.0.30 — a 404 means "none supported / none pending".
 */
async function pendingInputs(client, sessionId, directory, options) {
  const out = [];
  for (const kind of ['question', 'permission']) {
    try {
      const response = await client.get(`/api/${kind}`, undefined, directory, options);
      const arr = Array.isArray(response) ? response : (response && response.data ? response.data : []);
      for (const input of arr) {
        if (input && input.sessionID === sessionId && typeof input.id === 'string') {
          out.push({ ...input, kind });
        }
      }
    } catch (error) {
      if (error instanceof OpenCodeError && error.status === 404) continue; // route absent on this build
      throw error;
    }
  }
  return out;
}

/**
 * Observe a specific dispatched turn (or the latest user turn of a session).
 * Returns a JobSnapshot. Never blocks: a single status read, no internal
 * polling — the caller (JobService.get / tool layer) controls the wait.
 */
async function observeSession(client, sessionId, directory, messageId, options = {}) {
  if (!sessionId) throw new Error('sessionId is required');
  directory = normalizeDirectory(directory);
  const context = createRequestContext(options);
  const request = { signal: context.signal, deadline: context.deadline };
  try {
    const msgRaw = await client.get(`/api/session/${segment(sessionId)}/message`, { limit: '100' }, directory, request);
    const sessionRaw = await client.get(`/api/session/${segment(sessionId)}`, undefined, directory, request).catch(() => null);
    const messages = (Array.isArray(msgRaw) ? msgRaw : (msgRaw && msgRaw.data ? msgRaw.data : []))
      .map(normMsg).filter(Boolean)
      .sort((a, b) => (a.created - b.created) || String(a.id).localeCompare(String(b.id)));

    const users = messages.filter((m) => m.role === 'user');
    const latestUser = users.slice(-1)[0] || null;
    const assistants = messages.filter((m) => m.role === 'assistant');
    const assistant = assistants.slice(-1)[0] || null;

    // A turn is "superseded" when a user turn newer than the one we observe
    // has been dispatched. We can only PROVE that when our messageID IS
    // echoed in the history (1.x). On 2.x the client messageID is never
    // echoed, so we degrade to the single-turn assumption: the latest
    // assistant belongs to the (only) turn in the session — the one we fired.
    const ourTurnKnown = !!(messageId && users.some((u) => u.id === messageId));
    const superseded = !!(ourTurnKnown && latestUser && latestUser.id !== messageId);

    const snapshot = {
      sessionId, directory, messageId: messageId || (latestUser && latestUser.id) || null,
      status: 'accepted', session: sessionRaw,
    };

    if (assistant && !superseded) {
      snapshot.result = (assistant.structured !== undefined ? assistant.structured : assistant.raw);
      snapshot.text = formatMessageResponse(assistant.raw);
      if (assistant.error) {
        snapshot.error = assistant.error;
        snapshot.status = assistant.error.name === 'MessageAbortedError' ? 'cancelled' : 'failed';
        return snapshot;
      }
      // A tool-call step can finish while the turn continues. Require a
      // completed assistant whose finish reason is not an open tool-call step.
      const done = typeof assistant.completed === 'number' &&
        (assistant.structured !== undefined || !['tool-calls', 'unknown'].includes(assistant.finish));
      if (done) {
        snapshot.status = 'completed';
        return snapshot;
      }
    }

    if (superseded) {
      snapshot.status = 'unknown';
      snapshot.inputs = [];
      return snapshot;
    }
    if (!assistant) {
      snapshot.status = 'running';
    }

    snapshot.inputs = await pendingInputs(client, sessionId, directory, request);
    if (snapshot.inputs.length) snapshot.status = 'input_required';
    return snapshot;
  } finally {
    context.dispose();
  }
}

/**
 * Durable ownership + observation handles. Prompt execution stays with
 * OpenCode; this service persists job state, serializes concurrent
 * operations on the same job, and de-duplicates input replies.
 */
class JobService {
  /**
   * @param {import('./http.js').OpenCodeClient} client
   * @param {{ storeRoot?: string|null, scope?: string, directory?: string, ttlMs?: number }} options
   *   storeRoot === null → process-local memory store (isolated/ephemeral).
   *   storeRoot omitted → per-scope directory under the platform state dir.
   */
  constructor(client, options = {}) {
    if (!client) throw new Error('JobService requires an OpenCodeClient');
    this.client = client;
    this.ttl = options.ttlMs ?? 24 * 60 * 60 * 1000;
    if (!Number.isFinite(this.ttl) || this.ttl <= 0) throw new Error('Job TTL must be positive');
    this.directory = normalizeDirectory(options.directory);
    const scope = hash(JSON.stringify([client.getBaseUrl(), options.scope ?? 'default']));
    if (options.storeRoot === null) {
      this.store = null;
    } else {
      const base = process.platform === 'win32'
        ? (process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'))
        : (process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'));
      this.store = options.storeRoot ? join(options.storeRoot, scope) : join(base, 'opencode-mcp', 'tasks', scope);
    }
    this.memory = new Map();
    this.memoryLocks = new Set();
  }

  // ── storage ──────────────────────────────────────────────────────────
  _checkId(jobId) {
    if (typeof jobId !== 'string' || !/^job_[a-f0-9]{32}$/.test(jobId)) throw new Error('Invalid job ID');
  }
  async _prepare() {
    if (this.store) {
      await fsPromises.mkdir(this.store, { recursive: true, mode: 0o700 });
      try { await fsPromises.chmod(this.store, 0o700); } catch { /* best effort */ }
    }
  }
  async _read(jobId) {
    this._checkId(jobId);
    let job;
    try {
      job = this.store
        ? JSON.parse(await fsPromises.readFile(join(this.store, `${jobId}.json`), 'utf8'))
        : structuredClone(this.memory.get(jobId));
    } catch (error) {
      if (error && error.code === 'ENOENT') throw new Error('Job not found in this server and credential scope');
      throw error;
    }
    if (!job || job.version !== 1 || job.jobId !== jobId) throw new Error('Job not found or invalid job record');
    if (job.expiresAt <= Date.now()) {
      if (this.store) await fsPromises.rm(join(this.store, `${jobId}.json`), { force: true });
      else this.memory.delete(jobId);
      throw new Error('Job expired; observe its OpenCode session directly if still available');
    }
    return job;
  }
  async _save(job) {
    job.updatedAt = Date.now();
    if (!this.store) { this.memory.set(job.jobId, structuredClone(job)); return; }
    await this._prepare();
    const path = join(this.store, `${job.jobId}.json`);
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    const handle = await fsPromises.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(job), 'utf8');
      await handle.sync();
      await handle.close();
      await fsPromises.rename(temporary, path);
    } finally {
      await handle.close().catch(() => {});
      await fsPromises.rm(temporary, { force: true });
    }
  }

  // ── locking ──────────────────────────────────────────────────────────
  async _locked(jobId, options, action) {
    this._checkId(jobId);
    const operation = createRequestContext(options);
    try { await this._prepare(); } catch (error) { operation.dispose(); throw error; }
    const context = createRequestContext({ signal: operation.signal, deadline: operation.deadline, timeout: Math.min((options && options.timeout) || 5000, 5000) });
    let release;
    try {
      while (!release) {
        throwIfAborted(context.signal);
        if (!this.store) {
          if (!this.memoryLocks.has(jobId)) {
            this.memoryLocks.add(jobId);
            release = async () => { this.memoryLocks.delete(jobId); };
          }
        } else {
          const lock = join(this.store, `${jobId}.lock`);
          try {
            await fsPromises.mkdir(lock, { mode: 0o700 });
            const owner = await fsPromises.open(join(lock, 'owner.json'), 'wx', 0o600);
            try { await owner.writeFile(JSON.stringify({ pid: process.pid, host: hostname() })); }
            finally { await owner.close(); }
            release = async () => {
              await fsPromises.rm(join(lock, 'owner.json'), { force: true });
              // No recursive deletion: a competing recovery guard must never
              // be removed by the previous owner.
              await fsPromises.rmdir(lock);
            };
          } catch (error) {
            if (!error || error.code !== 'EEXIST') throw error;
            await this._recoverDeadOwner(lock);
          }
        }
        if (!release) await abortableSleep(25, context.signal);
      }
    } catch (error) {
      operation.dispose();
      throw error;
    } finally { context.dispose(); }
    try {
      throwIfAborted(operation.signal);
      return await withRequestOptions({ signal: operation.signal, deadline: operation.deadline }, action);
    } finally {
      operation.dispose();
      if (release) await release();
    }
  }

  /**
   * Reclaim a lock directory whose recorded owner process is gone. Fails
   * closed on any uncertainty (missing metadata, remote host, live pid):
   * a missing owner.json may belong to a process still acquiring.
   */
  async _recoverDeadOwner(lock) {
    let owner;
    try {
      owner = JSON.parse(await fsPromises.readFile(join(lock, 'owner.json'), 'utf8'));
    } catch (error) {
      if (error && error.code === 'ENOENT') return; // mid-acquire; leave it
      if (error instanceof SyntaxError) return;
      throw error;
    }
    if (owner.host !== hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0) return;
    try {
      process.kill(owner.pid, 0); // ESRCH below proves the process is dead
      return;
    } catch (error) {
      if (!error || error.code !== 'ESRCH') return;
    }
    // Single-writer recovery: only the process that first creates "recovery"
    // proceeds to dismantle the stale lock.
    let guard;
    try { guard = await fsPromises.open(join(lock, 'recovery'), 'wx', 0o600); }
    catch (error) {
      if (error && ['EEXIST', 'ENOENT'].includes(error.code)) return;
      throw error;
    }
    await guard.close();
    try {
      const current = JSON.parse(await fsPromises.readFile(join(lock, 'owner.json'), 'utf8'));
      if (current.pid !== owner.pid || current.host !== owner.host) return;
      await fsPromises.rm(join(lock, 'owner.json'));
    } finally {
      await fsPromises.rm(join(lock, 'recovery'), { force: true });
    }
    try { await fsPromises.rmdir(lock); }
    catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error && error.code)) throw error; }
  }

  // ── observation ──────────────────────────────────────────────────────
  async _refresh(job, options) {
    if (isTerminal(job.status) || !job.sessionId) return job;
    const observed = await observeSession(this.client, job.sessionId, job.directory, job.messageId, options);
    // Absence of a turn cannot prove an ambiguous submission failed.
    if (job.status === 'unknown' &&
        (observed.status === 'accepted' || (job.cancelRequested && !isTerminal(observed.status)))) {
      observed.status = 'unknown';
    }
    const updated = { ...job, ...observed };
    if (observed.status !== 'unknown') delete updated.error;
    if (observed.error) updated.error = observed.error;
    await this._save(updated);
    return updated;
  }

  // ── public API ───────────────────────────────────────────────────────
  /**
   * Dispatch a prompt and record ownership BEFORE any remote mutation.
   * On 2.0.30 the only dispatch route is the synchronous /prompt, which is
   * itself fire-and-forget (returns the user message immediately). An
   * optional /prompt_async is tried first for newer builds; a 404 falls
   * through to /prompt.
   */
  async start(args, options = {}) {
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) throw new Error('prompt is required');
    const directory = normalizeDirectory(args.directory || this.directory);
    const now = Date.now();
    const job = {
      version: 1,
      jobId: createJobId(),
      sessionId: args.sessionId,
      messageId: createMessageId(),
      directory,
      status: 'unknown',
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.ttl,
      responses: {},
    };
    return this._locked(job.jobId, options, async () => {
      const context = createRequestContext(options);
      const request = { signal: context.signal, deadline: context.deadline };
      try {
        throwIfAborted(context.signal);
        await this._save(job); // record ownership before the first remote mutation
        try {
          let sid = job.sessionId;
          if (!sid) {
            const session = await this.client.post('/api/session', { title: args.title || 'MCP delegated task', location: directory || null }, { ...request, directory });
            sid = session && session.id;
            if (!sid) throw new Error('OpenCode returned no session ID');
            job.sessionId = sid;
            await this._save(job);
          }
          // 2.x contract: top-level `text`, optional model/agent. NOT a
          // parts array (a parts body is rejected with "Missing key at [text]").
          const body = { text: args.prompt };
          if (args.model) body.model = args.model;
          if (args.agent) body.agent = args.agent;
          if (args.format) body.format = args.format;
          if (args.system) body.system = args.system;
          const promptPath = `/api/session/${segment(sid)}/prompt`;
          try {
            await this.client.post(`${promptPath}_async`, body, { ...request, directory });
          } catch (asyncErr) {
            // /prompt_async is absent on 2.0.30 → synchronous /prompt.
            if (!(asyncErr instanceof OpenCodeError && asyncErr.status === 404)) throw asyncErr;
            await this.client.post(promptPath, body, { ...request, directory });
          }
          job.status = 'accepted';
          delete job.error;
        } catch (error) {
          job.status = error instanceof OpenCodeError ? 'failed' : 'unknown';
          job.error = requestError(error);
        }
        await this._save(job);
        return publicSnapshot(job);
      } finally { context.dispose(); }
    });
  }

  /** Observe a job once (no internal polling). */
  async get(jobId, options = {}) {
    return this._locked(jobId, options, async () => publicSnapshot(await this._refresh(await this._read(jobId), options)));
  }

  /** List durable jobs (newest first), silently skipping expired/invalid. */
  async list(limit = 50) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit must be an integer between 1 and 1000');
    await this._prepare();
    const names = this.store
      ? await fsPromises.readdir(this.store)
      : [...this.memory.keys()].map((id) => `${id}.json`);
    const ids = names.filter((n) => /^job_[a-f0-9]{32}\.json$/.test(n)).map((n) => n.slice(0, -5));
    const values = [];
    for (const id of ids) {
      try { values.push(publicSnapshot(await this._read(id))); }
      catch (error) { if (!(error instanceof Error && /expired|not found/.test(error.message))) throw error; }
    }
    return values.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, limit);
  }

  /**
   * Cancel a job. OpenCode's abort endpoint is session-wide, so refuse to
   * abort a session whose newest user turn is NOT this job's turn. On 2.0.30
   * /abort is absent → degrade to "unknown" with an explanatory note.
   */
  async cancel(jobId, options = {}) {
    return this._locked(jobId, options, async () => {
      let job = await this._read(jobId);
      if (isTerminal(job.status)) return publicSnapshot(job);
      if (!job.sessionId) throw new Error('Cannot abort a job whose session creation outcome is unknown');
      job = await this._refresh(job, options);
      if (isTerminal(job.status)) return publicSnapshot(job);
      if (!job.sessionId) throw new Error('No known session to cancel');

      const messagesRaw = await this.client.get(`/api/session/${segment(job.sessionId)}/message`, { limit: '100' }, job.directory, options);
      const users = (Array.isArray(messagesRaw) ? messagesRaw : (messagesRaw && messagesRaw.data ? messagesRaw.data : []))
        .map(normMsg).filter(Boolean).filter((m) => m.role === 'user')
        .sort((a, b) => (a.created - b.created) || String(a.id).localeCompare(String(b.id)));
      const newest = users.slice(-1)[0] || null;
      // When the submitted messageID IS echoed we can prove which turn owns
      // the session and refuse to abort a turn that is not this job's. When it
      // is NOT echoed (2.0.30), we degrade to the single-turn assumption: the
      // latest user turn is the one we dispatched, so aborting is safe.
      if (newest && job.messageId && users.some((m) => m.id === job.messageId) && newest.id !== job.messageId) {
        throw new Error('A newer turn owns this session; refusing to abort unrelated work');
      }
      if (job.cancelRequested) return publicSnapshot(job);
      job.cancelRequested = true;
      await this._save(job);
      try {
        await this.client.post(`/api/session/${segment(job.sessionId)}/abort`, {}, { ...options, directory: job.directory });
        job.status = 'cancelled';
        delete job.error;
      } catch (error) {
        if (error instanceof OpenCodeError && error.status === 404) {
          job.status = 'unknown';
          job.error = { name: 'AbortRouteUnavailable', message: 'This OpenCode build has no /abort route; the turn will end on its own. Observe the job again to confirm.' };
        } else {
          job.status = 'unknown';
          job.error = requestError(error);
          if (error instanceof OpenCodeError) job.cancelRequested = false;
        }
      }
      await this._save(job);
      return publicSnapshot(job);
    });
  }

  /**
   * Answer pending question/permission inputs. Digest-keyed idempotency:
   * identical retries no-op, a *different* answer to the same input is
   * rejected, and an uncertain ("sending") reply is never replayed.
   */
  async update(jobId, responses, options = {}) {
    if (!Array.isArray(responses) || responses.length < 1 || responses.length > 100) {
      throw new Error('Provide between 1 and 100 input responses');
    }
    return this._locked(jobId, options, async () => {
      let job = await this._read(jobId);
      if (isTerminal(job.status)) return publicSnapshot(job);
      job = await this._refresh(job, options);
      for (const response of responses) {
        if (!response || typeof response.id !== 'string' || !['question', 'permission'].includes(response.kind)) {
          throw new Error('Invalid input response');
        }
        const key = `${response.kind}:${response.id}`;
        const digest = hash(JSON.stringify({
          id: response.id, kind: response.kind, answers: response.answers,
          reply: response.reply, reject: response.reject, message: response.message,
        }));
        const previous = job.responses[key];
        if (previous) {
          if (previous.digest !== digest) throw new Error('This input already has a different submitted response');
          if (previous.state !== 'sent') throw new Error('Previous reply outcome is unknown; it cannot be safely resent');
          continue;
        }
        if (!job.inputs || !job.inputs.some((input) => input.id === response.id && input.kind === response.kind)) {
          throw new Error('Input does not belong to this job\'s pending requests');
        }
        if (response.kind === 'permission' &&
            (!['once', 'always', 'reject'].includes(response.reply || '') || response.answers !== undefined || response.reject !== undefined)) {
          throw new Error('Permission response requires once, always, or reject without question answers');
        }
        if (response.kind === 'question' &&
            (response.reply !== undefined || (response.reject === true && response.answers !== undefined))) {
          throw new Error('Question response requires answers or reject=true, exclusively');
        }
        if (response.kind === 'question' && !response.reject &&
            (!Array.isArray(response.answers) || !response.answers.every((arr) => Array.isArray(arr) && arr.every((s) => typeof s === 'string')))) {
          throw new Error('Question response requires an array of answer arrays');
        }
        job.responses[key] = { digest, state: 'sending' };
        await this._save(job);
        try {
          const isReject = response.kind === 'question' && response.reject;
          const path = `/api/${response.kind}/${segment(response.id)}/${isReject ? 'reject' : 'reply'}`;
          const body = response.kind === 'permission'
            ? { reply: response.reply, ...(response.message ? { message: response.message } : {}) }
            : (isReject ? undefined : { answers: response.answers });
          await this.client.post(path, body, { ...options, directory: job.directory });
          job.responses[key].state = 'sent';
        } catch (error) {
          if (error instanceof OpenCodeError && error.status === 404) {
            job.responses[key].state = 'unknown';
            job.error = { name: 'ReplyRouteUnavailable', message: `This OpenCode build has no reply route for ${response.kind} inputs; the answer could not be delivered.` };
            await this._save(job);
            throw error;
          }
          if (error instanceof OpenCodeError) {
            delete job.responses[key]; // deterministic 4xx: safe to retry
          } else {
            job.responses[key].state = 'unknown';
          }
          job.error = requestError(error);
          await this._save(job);
          throw error;
        }
        await this._save(job);
      }
      return publicSnapshot(await this._refresh(job, options));
    });
  }
}

module.exports = {
  JobService,
  observeSession,
  createMessageId,
  createJobId,
  pendingInputs,
  requestError,
  publicSnapshot,
  isTerminal,
};
