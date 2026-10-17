/**
 * Layer 0 — OpenCodeClient (pure-JS re-implementation of upstream src/client.ts)
 *
 * Thin, dependency-free HTTP wrapper that speaks to an OpenCode 2.x/3.x
 * server. All business routes use the 2.x `/api/...` prefix. The one known
 * exception is health, which lives at `/global/health` on 2.x (verified:
 * `/api/health` returns 404 there).
 *
 * Response envelope: 2.x list/record endpoints return `{ data: ... }`.
 * This client unwraps `.data` so callers get the raw array/object.
 * Single-object endpoints (e.g. /api/vcs) return the object directly and we
 * tolerate both shapes.
 */
'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { abortableSleep, abortReason, throwIfAborted } = require('./async.js');

const HEALTH_PATH = '/global/health'; // 2.x verified working route
const MAX_RETRIES = 2;      // GET-only
const BASE_DELAY_MS = 500;

/** True for network-level failures that a bounded GET retry may recover from. */
function isConnectionError(err) {
  const msg = ((err && err.message) || '').toLowerCase();
  return (
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('ehostunreach') ||
    msg.includes('fetch failed') ||
    msg.includes('network error') ||
    msg.includes('socket hang up') ||
    msg.includes('timeout') ||
    msg.includes('etimedout') ||
    msg.includes('econnreset')
  );
}

class OpenCodeError extends Error {
  constructor(message, status, method, path, body) {
    super(message);
    this.name = 'OpenCodeError';
    this.status = status;
    this.method = method;
    this.path = path;
    this.body = body;
  }
  get isTransient() {
    return [429, 502, 503, 504].includes(this.status);
  }
  get isNotFound() { return this.status === 404; }
  get isAuth() { return this.status === 401 || this.status === 403; }
}

/**
 * A write was dispatched but the outcome is unknown (response lost / socket
 * dropped before a status arrived). OpenCode may have accepted it — unlike a
 * plain error, this MUST NOT be retried or replayed, or the prompt runs twice.
 */
class OpenCodeSubmissionError extends Error {
  constructor(method, path, cause) {
    super(
      `${method} ${path}: submission outcome unknown; the server may have accepted this operation. ` +
      `Check its session before retrying. ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'OpenCodeSubmissionError';
    this.method = method;
    this.path = path;
    this.submissionOutcome = 'unknown';
    this.cause = cause;
  }
}

function buildAuth(user, pass) {
  if (!pass) return undefined;
  return 'Basic ' + Buffer.from(`${user || 'opencode'}:${pass}`).toString('base64');
}

class OpenCodeClient {
  constructor({ baseUrl, username, password, timeoutMs = 60000 } = {}) {
    this.baseUrl = (baseUrl || 'http://127.0.0.1:49374').replace(/\/+$/, '');
    this.username = username;
    this.password = password;
    this.auth = buildAuth(username, password);
    this.timeoutMs = timeoutMs;
  }

  getBaseUrl() { return this.baseUrl; }

  _http() {
    const u = new URL(this.baseUrl);
    return u.protocol === 'https:' ? https : http;
  }

  /**
   * Core request. Returns unwrapped `.data` when present, else the parsed body.
   * Throws OpenCodeError on non-2xx.
   */
  /**
   * One raw HTTP round trip. No retries, no submission bookkeeping — that
   * lives in request(). Resolves to the unwrapped `.data` (or the parsed
   * body) on 2xx; rejects with OpenCodeError otherwise.
   */
  _doOnce(method, path, { query, body, directory, timeoutMs, signal } = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(this.baseUrl + path);
      if (query) {
        for (const [k, v] of Object.entries(query)) {
          if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
        }
      }
      const lib = this._http();
      const data = body != null ? JSON.stringify(body) : null;
      const headers = {
        Accept: 'application/json',
        'x-opencode-directory': directory || '',
      };
      if (this.auth) headers.Authorization = this.auth;
      if (data) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(data);
      }
      let settled = false;
      const settle = (fn) => { if (settled) return; settled = true; fn(); };
      const req = lib.request(
        {
          method,
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + (u.search || ''),
          headers,
        },
        (res) => {
          let chunks = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (chunks += c));
          res.on('end', () => {
            const ok = res.statusCode >= 200 && res.statusCode < 300;
            let json = null;
            try { json = chunks ? JSON.parse(chunks) : null; } catch { /* keep raw */ }
            if (!ok) {
              settle(() => reject(new OpenCodeError(
                `${method} ${path} failed (${res.statusCode}): ${String(chunks).slice(0, 400)}`,
                res.statusCode, method, path, chunks,
              )));
              return;
            }
            if (json && typeof json === 'object' && 'data' in json && !Array.isArray(json)) {
              settle(() => resolve(json.data !== undefined ? json.data : json));
            } else {
              settle(() => resolve(json));
            }
          });
        },
      );
      // timeoutMs === 0 means "no client-side timeout" (used by
      // fire-and-forget dispatch, which keeps the socket open until the
      // server finishes the turn on its own).
      const tm = timeoutMs != null ? timeoutMs : this.timeoutMs;
      if (tm > 0) {
        req.setTimeout(tm, () => {
          settle(() => req.destroy(new Error(`timeout after ${tm}ms: ${method} ${path}`)));
        });
      }
      req.on('error', (e) => settle(() => reject(new OpenCodeError(String(e.message), 0, method, path, String(e)))));
      if (signal) {
        const onAbort = () => settle(() => req.destroy(abortReason(signal)));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
        req.on('close', () => signal.removeEventListener('abort', onAbort));
      }
      if (data) req.write(data);
      req.end();
    });
  }

  /**
   * Core request with cancellation + bounded GET retry + write protection.
   *
   * `options` is a RequestOptions bag ({ signal, deadline, timeout }) — the
   * same shape JobService threads through. A caller abort is a pre-flight
   * cancel (not a submission loss). A write that fails before a status is
   * known is an OpenCodeSubmissionError: the server may have accepted it, so
   * it must never be replayed. GETs retry a couple of times on transient
   * statuses and connection errors.
   */
  async request(method, path, { query, body, directory, timeoutMs, signal, deadline, timeout } = {}) {
    const readOnly = method === 'GET';
    throwIfAborted(signal);
    const t = timeoutMs || timeout || this.timeoutMs;
    if (deadline !== undefined && Number.isFinite(deadline)) {
      const remaining = deadline - Date.now();
      const effective = t !== undefined ? Math.min(t, Math.max(1, remaining)) : Math.max(1, remaining);
      return this._doOnce(method, path, { query, body, directory, timeoutMs: effective, signal });
    }
    let lastError;
    const attempts = readOnly ? MAX_RETRIES + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      throwIfAborted(signal);
      if (attempt > 0) await abortableSleep(BASE_DELAY_MS * Math.pow(2, attempt - 1), signal);
      try {
        return await this._doOnce(method, path, { query, body, directory, timeoutMs: t, signal });
      } catch (e) {
        throwIfAborted(signal);
        lastError = e;
        if (!readOnly) {
          if (e instanceof OpenCodeError) throw e;
          throw new OpenCodeSubmissionError(method, path, e);
        }
        if (e instanceof OpenCodeError && !e.isTransient) throw e;
        if (!(e instanceof OpenCodeError) && !isConnectionError(e)) throw e;
      }
    }
    if (lastError instanceof OpenCodeError && lastError.status === 0 && isConnectionError(lastError)) {
      throw new OpenCodeSubmissionError(method, path, lastError);
    }
    throw lastError || new Error(`${method} ${path} failed after retries`);
  }

  get(path, query, directory, options) { return this.request('GET', path, { query, directory, ...options }); }
  post(path, body, opts) { return this.request('POST', path, { body, ...(opts || {}) }); }

  /**
   * Fire-and-forget POST: dispatches the request and does NOT wait for the
   * response. The socket stays open until the server finishes the turn on
   * its own (or the caller-supplied signal aborts it). Used for synchronous
   * /prompt fallbacks when /prompt_async is absent: the caller wants
   * fire-and-forget semantics without blocking the lock, so the turn outcome
   * is observed later via /message instead of this response.
   *
   * Resolves once the request is flushed and 2xx headers arrive (or rejects
   * on a hard client error / a non-2xx response) — but NEVER waits for the
   * body. If the caller ignores the returned promise's rejection (via a
   * .catch), the request continues server-side.
   */
  postFireAndForget(path, body, { directory, signal } = {}) {
    return this._doOnce('POST', path, { body, directory, timeoutMs: 0, signal });
  }
  patch(path, body, opts) { return this.request('PATCH', path, { body, ...(opts || {}) }); }
  put(path, body, opts) { return this.request('PUT', path, { body, ...(opts || {}) }); }
  delete(path, query, opts) { return this.request('DELETE', path, { query, ...(opts || {}) }); }

  health() { return this.request('GET', HEALTH_PATH); }

  /**
   * Subscribe to an SSE endpoint and yield parsed events.
   * Each yielded item is `{ event, data }`. Honors deadline (ms) and a
   * caller-supplied AbortSignal. Returns an async generator.
   */
  async *subscribeSSE(path, { deadline, signal, directory } = {}) {
    const u = new URL(this.baseUrl + path);
    const lib = this._http();
    const headers = {
      Accept: 'text/event-stream',
      'x-opencode-directory': directory || '',
    };
    if (this.auth) headers.Authorization = this.auth;

    const stop = () => {
      try { req.destroy(); } catch { /* already closed */ }
    };
    if (signal) signal.addEventListener('abort', stop, { once: true });
    const timer = deadline ? setTimeout(stop, deadline) : null;

    let req;
    let currentResolve = () => {};
    try {
      req = lib.request({
        method: 'GET',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + (u.search || ''),
        headers,
      }, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          const r = currentResolve; currentResolve = () => {}; r({ event: '__error__', data: `HTTP ${res.statusCode}` });
          return;
        }
        res.setEncoding('utf8');
        let event = '';
        let data = '';
        res.on('data', (chunk) => {
          for (const line of chunk.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
            else if (line === '') {
              if (event || data) {
                const r = currentResolve; currentResolve = () => {};
                r({ event: event || 'message', data });
                event = '';
                data = '';
              }
            }
          }
        });
        res.on('end', () => { const r = currentResolve; currentResolve = () => {}; r(null); });
        res.on('error', () => { const r = currentResolve; currentResolve = () => {}; r(null); });
      });
      req.on('close', () => { const r = currentResolve; currentResolve = () => {}; r(null); });
      req.on('error', () => {});
      req.end();
      // Pump events; each next() blocks until the stream yields one.
      while (true) {
        const evt = await new Promise((resolve) => { currentResolve = resolve; });
        if (evt === null) break; // stream ended
        yield evt;
        if (timer && Date.now() >= deadline) break;
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', stop);
      try { req.destroy(); } catch { /* ignore */ }
    }
  }
}

module.exports = { OpenCodeClient, OpenCodeError, HEALTH_PATH };
