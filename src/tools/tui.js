/**
 * Tool group: tui (upstream src/tools/tui.ts, 9 tools)
 * The 2.x server exposes no /api/tui/* routes on 2.0.31 (all 404).
 * These drive the remote TUI; since the build lacks them, each tool
 * returns an honest no-route message instead of 404.
 */
'use strict';
const { toolResult, directoryParam } = require('../helpers.js');

function noRoute(name) {
  return toolResult(
    `${name}: TUI control routes are not available on this OpenCode server (2.x build lacks /api/tui/*). ` +
    'Use the session/message tools to drive workloads programmatically instead.',
    true,
  );
}

function register(registry, ctx) {
  const R = (name, desc, schema, fn) => registry.tool(name, desc, { inputSchema: schema, run: fn });
  const D = { directory: directoryParam };

  R('opencode_tui_append_prompt', 'Append text to the TUI prompt input field.',
    { type: 'object', properties: { text: { type: 'string' }, directory: directoryParam }, required: ['text'] },
    async () => noRoute('opencode_tui_append_prompt'));

  R('opencode_tui_submit_prompt', 'Submit the current TUI prompt.',
    { type: 'object', properties: D },
    async () => noRoute('opencode_tui_submit_prompt'));

  R('opencode_tui_clear_prompt', 'Clear the current TUI prompt.',
    { type: 'object', properties: D },
    async () => noRoute('opencode_tui_clear_prompt'));

  R('opencode_tui_execute_command', 'Execute a slash command through the TUI.',
    { type: 'object', properties: { command: { type: 'string' }, directory: directoryParam }, required: ['command'] },
    async () => noRoute('opencode_tui_execute_command'));

  R('opencode_tui_show_toast', 'Show a toast notification in the TUI.',
    { type: 'object', properties: { message: { type: 'string' }, title: { type: 'string' }, variant: { type: 'string', enum: ['info', 'success', 'warning', 'error'] }, directory: directoryParam }, required: ['message'] },
    async () => noRoute('opencode_tui_show_toast'));

  R('opencode_tui_open_help', 'Open the help dialog in the TUI.',
    { type: 'object', properties: D },
    async () => noRoute('opencode_tui_open_help'));

  R('opencode_tui_open_sessions', 'Open the session selector in the TUI.',
    { type: 'object', properties: D },
    async () => noRoute('opencode_tui_open_sessions'));

  R('opencode_tui_open_models', 'Open the model selector in the TUI.',
    { type: 'object', properties: D },
    async () => noRoute('opencode_tui_open_models'));

  R('opencode_tui_open_themes', 'Open the theme selector in the TUI.',
    { type: 'object', properties: D },
    async () => noRoute('opencode_tui_open_themes'));
}

module.exports = { register };
