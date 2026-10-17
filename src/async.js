/**
 * Layer 0 — async primitives (pure-JS port of upstream src/async.ts).
 *
 * One shared "request options" budget (signal + deadline + timeout) is
 * threaded through every OpenCodeClient call, JobService lock, and
 * observation sleep so a single MCP caller cancellation can unwind the
 * whole operation. AsyncLocalStorage carries the budget implicitly so
 * nested calls inherit it without explicit plumbing.
 */
'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const requestOptionsStorage = new AsyncLocalStorage();

/**
 * Propagate the MCP caller's cancellation context through ordinary handlers.
 * @template T
 * @param {{ signal?: AbortSignal, deadline?: number, timeout?: number }} options
 * @param {() => T} callback
 * @returns {T}
 */
function withRequestOptions(options, callback) {
  return requestOptionsStorage.run(options || {}, callback);
}

/** Read the RequestOptions inherited from the nearest withRequestOptions scope. */
function currentRequestOptions() {
  return requestOptionsStorage.getStore() || {};
}

function abortReason(signal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Operation aborted', 'AbortError');
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortReason(signal);
}

/**
 * Race an already-started promise against a signal. Even libraries that
 * swallow AbortError or ignore the signal are unblocked this way.
 */
function withAbort(work, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    Promise.resolve(work).then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error) => { signal.removeEventListener('abort', abort); reject(error); },
    );
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Build a request context: merges inherited signal/deadline/timeout with the
 * caller's, computes a concrete deadline, wires a timeout timer, and returns
 * { signal, deadline, abort, dispose }. The caller MUST dispose() so the
 * timer is cleared.
 */
function createRequestContext(options = {}, defaultTimeout = 120000) {
  const inherited = currentRequestOptions();
  options = {
    signal: options.signal || inherited.signal,
    deadline: options.deadline !== undefined ? options.deadline : inherited.deadline,
    timeout: options.timeout !== undefined ? options.timeout : inherited.timeout,
  };
  const timeout = options.timeout !== undefined ? options.timeout : defaultTimeout;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2147483647) {
    throw new RangeError('timeout must be a positive finite duration no greater than 2147483647ms');
  }
  if (options.deadline !== undefined && !Number.isFinite(options.deadline)) {
    throw new RangeError('deadline must be a finite Unix timestamp in milliseconds');
  }
  const deadline = Math.min(options.deadline !== undefined ? options.deadline : Infinity, Date.now() + timeout);
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal ? options.signal.reason : undefined);
  const expire = () => controller.abort(new DOMException('Operation deadline exceeded', 'TimeoutError'));
  if (options.signal && options.signal.aborted) abort();
  else if (options.signal) options.signal.addEventListener('abort', abort, { once: true });
  const remaining = deadline - Date.now();
  const timer = remaining > 0 ? setTimeout(expire, remaining) : undefined;
  if (remaining <= 0) expire();
  return {
    signal: controller.signal,
    deadline,
    abort: (reason) => controller.abort(reason),
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', abort);
    },
  };
}

/**
 * A sleep that resolves on the timer OR rejects if the signal aborts.
 * Used for lock acquisition polling and observation waits.
 */
function abortableSleep(milliseconds, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
    };
    const abort = () => { cleanup(); reject(abortReason(signal)); };
    timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
    if (signal) signal.addEventListener('abort', abort, { once: true });
  });
}

module.exports = {
  withRequestOptions,
  currentRequestOptions,
  abortReason,
  throwIfAborted,
  withAbort,
  createRequestContext,
  abortableSleep,
};
