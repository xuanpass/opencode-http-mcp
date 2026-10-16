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

const HEALTH_PATH = '/global/health'; // 2.x verified working route

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
  request(method, path, { query, body, directory, timeoutMs } = {}) {
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
              reject(new OpenCodeError(
                `${method} ${path} failed (${res.statusCode}): ${String(chunks).slice(0, 400)}`,
                res.statusCode, method, path, chunks,
              ));
              return;
            }
            // Unwrap the 2.x `{ data }` envelope when present.
            if (json && typeof json === 'object' && 'data' in json && !Array.isArray(json)) {
              resolve(json.data !== undefined ? json.data : json);
            } else {
              resolve(json);
            }
          });
        },
      );
      const t = timeoutMs ? req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`timeout after ${timeoutMs}ms: ${method} ${path}`));
      }) : null;
      req.on('error', (e) => reject(new OpenCodeError(String(e.message), 0, method, path, String(e))));
      if (data) req.write(data);
      req.end();
      if (t) req.on('close', () => req.setTimeout(0));
    });
  }

  get(path, query, directory) { return this.request('GET', path, { query, directory }); }
  post(path, body, opts) { return this.request('POST', path, { ...opts, body }); }
  patch(path, body, opts) { return this.request('PATCH', path, { ...opts, body }); }
  put(path, body, opts) { return this.request('PUT', path, { ...opts, body }); }
  delete(path, query, opts) { return this.request('DELETE', path, { ...(opts || {}), query }); }

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
