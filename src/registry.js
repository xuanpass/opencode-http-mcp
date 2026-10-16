/**
 * Layer 0.5 — tool registry.
 *
 * Each grouped module exports a `register(registry, client)` function that
 * adds its tools. A tool is: { name, description, inputSchema, run }.
 * `run(args, ctx)` receives the tool arguments and a context object
 * { client, jobs } and returns an MCP result ({ content, isError?,
 * structuredContent? }).
 *
 * Keep one module per upstream file for parity + easy maintenance.
 */
'use strict';

class Registry {
  constructor() {
    this.tools = new Map();
  }

  tool(name, description, { inputSchema, run }) {
    this.tools.set(name, { name, description, inputSchema: inputSchema || { type: 'object', properties: {} }, run });
    return this;
  }

  list() {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  get(name) {
    return this.tools.get(name);
  }

  names() {
    return [...this.tools.keys()];
  }

  size() {
    return this.tools.size;
  }
}

module.exports = { Registry };
