/**
 * Tool group: input (upstream src/tools/input.ts)
 * Upstream exposes: question_list / question_reply / question_reject +
 * job_get / job_cancel / job_list / job_input.
 *
 * 2.x reality on 2.0.30:
 *   - /api/question and /api/permission are BOTH 404 -> the question_* and
 *     job_input "pending input" surface has no server route; report honestly.
 *   - Job observation works through our JobService (session-turn model):
 *     job_get observes by session; job_cancel aborts the session.
 */
'use strict';
const { toolResult, toolJson, toolError, directoryParam } = require('../helpers.js');
const { dir } = require('../util.js');

function register(registry, ctx) {
  const { client, jobs } = ctx;
  const R = (name, desc, schema, fn) => registry.tool(name, desc, { inputSchema: schema, run: fn });

  R('opencode_question_list', 'List pending OpenCode questions (may be unavailable on this build).', {
    type: 'object',
    properties: { sessionId: { type: 'string' }, directory: directoryParam },
  }, async (a) => {
    try {
      const questions = await client.get('/api/question', undefined, dir(a));
      const arr = Array.isArray(questions) ? questions : (questions?.data || []);
      const filtered = a.sessionId ? arr.filter((q) => q.sessionID === a.sessionId) : arr;
      return toolJson(filtered);
    } catch (e) {
      return toolResult(
        `opencode_question_list: /api/question is not available on this OpenCode server (2.x build). ` +
        `Pending inputs surface via session permissions instead. Detail: ${e.message}`,
        true,
      );
    }
  });

  R('opencode_question_reply', 'Answer a pending OpenCode question.', {
    type: 'object',
    properties: {
      requestId: { type: 'string' },
      answers: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
      directory: directoryParam,
    },
    required: ['requestId', 'answers'],
  }, async () => toolResult(
    'opencode_question_reply: /api/question/{id}/reply is not available on this OpenCode server (2.x build).',
    true,
  ));

  R('opencode_question_reject', 'Reject a pending OpenCode question.', {
    type: 'object',
    properties: { requestId: { type: 'string' }, directory: directoryParam },
    required: ['requestId'],
  }, async () => toolResult(
    'opencode_question_reject: /api/question/{id}/reject is not available on this OpenCode server (2.x build).',
    true,
  ));

  R('opencode_job_get', 'Observe a dispatched task by session, including current status and captured response text.', {
    type: 'object',
    properties: {
      jobId: { type: 'string' },
      sessionId: { type: 'string' },
      directory: directoryParam,
      pollMs: { type: 'number' },
      deadline: { type: 'number' },
    },
  }, async (a) => {
    try {
      const snap = await jobs.get(a.jobId, {
        sessionId: a.sessionId, directory: dir(a), pollMs: a.pollMs, deadline: a.deadline,
      });
      const text = snap.text || `Job ${a.jobId ?? ''}: ${snap.status}`;
      return toolResult(text, snap.status === 'timeout', { ...snap });
    } catch (e) {
      return toolResult(e instanceof Error ? e.message : String(e), true, { jobId: a.jobId, status: 'unknown' });
    }
  });

  // NOTE: upstream also registers opencode_job_${get,cancel} here. Our
  // durable-job variants (jobId-based, JobService-backed) live in
  // workflow.js — registering a sessionId-based job_cancel here would
  // collide (registry is a Map; last registration wins), so it is omitted.
}

module.exports = { register };
