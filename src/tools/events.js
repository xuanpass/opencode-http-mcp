/**
 * Tool group: events (upstream src/tools/events.ts, 1 tool)
 * 2.x routes: /api/event (project-scope) and /global/event (global) are both
 * SSE streams on 2.0.30 (verified: /api/event => 200 text/event-stream).
 * We poll within a bounded window and collect up to maxEvents.
 */
'use strict';
const { toolResult, toolError, directoryParam } = require('../helpers.js');
const { dir } = require('../util.js');

function register(registry, ctx) {
  const { client } = ctx;
  registry.tool('opencode_events_poll', 'Poll project events from OpenCode, or explicitly select global scope. Collects up to maxEvents within the duration.', {
    inputSchema: {
      type: 'object',
      properties: {
        durationMs: { type: 'number', description: 'How long to collect in ms (default 3000, max 30000)' },
        maxEvents: { type: 'number', description: 'Max events to collect (default 50, max 1000)' },
        directory: directoryParam,
        scope: { type: 'string', enum: ['project', 'global'] },
      },
    },
    run: async (a) => {
      const durationMs = Math.min(Math.max(a.durationMs ?? 3000, 1), 30000);
      const maxEvents = Math.min(Math.max(a.maxEvents ?? 50, 1), 1000);
      const scope = a.scope ?? 'project';
      if (scope === 'global' && a.directory) {
        return toolResult('Global event scope cannot be combined with directory.', true);
      }
      try {
        const events = [];
        const deadline = Date.now() + durationMs;
        const path = scope === 'global' ? '/global/event' : '/api/event';
        for await (const evt of client.subscribeSSE(path, { deadline, directory: scope === 'project' ? dir(a) : undefined })) {
          events.push({ event: evt.event, data: evt.data });
          if (events.length >= maxEvents) break;
        }
        const formatted = events.map((e) => {
          try { return `[${e.event}] ${JSON.stringify(JSON.parse(e.data), null, 2)}`; }
          catch { return `[${e.event}] ${e.data}`; }
        }).join('\n\n');
        return toolResult(
          events.length ? `Collected ${events.length} event(s):\n\n${formatted}` : 'No events received during the polling period.',
          false,
          { events, partial: false, scope },
        );
      } catch (e) { return toolError(e); }
    },
  });
}

module.exports = { register };
