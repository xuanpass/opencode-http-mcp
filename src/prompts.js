/**
 * MCP Prompts — reusable prompt templates for common workflows.
 * Ported from upstream prompts.ts to dependency-free pure JS.
 */

function createPrompts() {
  // Define the prompts as an array of objects.
  // Each prompt has: name, description, and an arguments schema (simplified).
  const prompts = [
    {
      name: 'opencode-code-review',
      description: 'Review code changes in an OpenCode session. Fetches the diff and provides a structured review.',
      arguments: {
        type: 'object',
        properties: {
          sessionId: {
            type: 'string',
            description: 'Session ID to review changes from',
          },
        },
        required: ['sessionId'],
      },
    },
    {
      name: 'opencode-debug',
      description: 'Start a debugging session with OpenCode',
      arguments: {
        type: 'object',
        properties: {
          issue: {
            type: 'string',
            description: 'Description of the bug or issue',
          },
          context: {
            type: 'string',
            description: 'Additional context (file paths, error messages, etc.)',
          },
        },
        required: ['issue'],
      },
    },
    {
      name: 'opencode-project-setup',
      description: 'Get oriented in a new project using OpenCode',
      arguments: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'opencode-implement',
      description: 'Have OpenCode implement a feature or make changes',
      arguments: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'Description of what to implement',
          },
          requirements: {
            type: 'string',
            description: 'Specific requirements or constraints',
          },
        },
        required: ['description'],
      },
    },
    {
      name: 'opencode-best-practices',
      description: 'Get best practices for using OpenCode MCP tools effectively. Covers tool selection, async workflows, provider configuration, and common pitfalls.',
      arguments: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'opencode-session-summary',
      description: 'Summarize what happened in an OpenCode session',
      arguments: {
        type: 'object',
        properties: {
          sessionId: {
            type: 'string',
            description: 'Session ID to summarize',
          },
        },
        required: ['sessionId'],
      },
    },
  ];

  function listPrompts() {
    // Return a list of prompt descriptors (name, description, and the properties of the arguments schema)
    return prompts.map(p => ({
      name: p.name,
      description: p.description,
      // We return the arguments schema as is, but we could also return just the properties if desired.
      // For simplicity, we return the whole arguments object.
      arguments: p.arguments,
    }));
  }

  function getPrompt(name) {
    const prompt = prompts.find(p => p.name === name);
    if (!prompt) {
      throw new Error(`Prompt not found: ${name}`);
    }
    return prompt;
  }

  return { listPrompts, getPrompt };
}

module.exports = { createPrompts };