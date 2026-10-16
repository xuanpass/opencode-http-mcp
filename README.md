# opencode-http-mcp

A **zero-dependency, pure-JavaScript** stdio MCP server that bridges MCP
clients (Claude Desktop, WorkBuddy, Cursor, any JSON-RPC stdio client) to an
OpenCode 2.x / 3.x server.

It talks **directly** to OpenCode's official `/api/...` HTTP endpoints and
hand-rolls the MCP stdio (JSON-RPC) protocol on top of `node:readline`.
No `@modelcontextprotocol/sdk`, no `zod`, no build step — just one JS file.

## Why this exists

The community `opencode-mcp` package targets OpenCode's **1.x** top-level
routes (`POST /session`, `GET /fs/read/*`). OpenCode **2.x/3.x** moved every
business endpoint behind an `/api/...` prefix, so the older wrapper returns
`405`, the Web UI HTML, or crashes with `.map is not a function`.
`opencode-http-mcp` was written to speak the current `/api/...` contract
from the start.

## Features

- **Zero dependencies** — only `node:http` and `node:url` from the standard library.
- **No build step** — point your MCP client at `index.js` and it runs.
- **Correct `/api/...` routing** for OpenCode 2.x/3.x.
- **Basic + workflow tools** out of the box (see table below).
- **Fire-and-forget / poll** primitives for background tasks.

## Requirements

- Node.js >= 18
- A running OpenCode server (`opencode serve`) reachable over HTTP,
  e.g. `http://192.168.123.101:49374`

## Install

```bash
git clone <your-repo-url> opencode-http-mcp
cd opencode-http-mcp
# No `npm install` needed — there are no dependencies.
```

## Configuration (environment variables)

| Variable | Default | Description |
|---|---|---|
| `OPENCODE_BASE_URL` | `http://127.0.0.1:49374` | Base URL of the OpenCode server |
| `OPENCODE_SERVER_USERNAME` | `opencode` | Basic-auth username |
| `OPENCODE_SERVER_PASSWORD` | _(empty)_ | Basic-auth password |
| `OPENCODE_AUTO_SERVE` | `false` | Reserved (currently not used) |

> **Security note:** never commit a real `OPENCODE_SERVER_PASSWORD`.
> Set it in your MCP client's `env` block or in your shell environment instead.

## MCP client configuration

Example for a client that reads `mcpServers`:

```json
{
  "mcpServers": {
    "opencode": {
      "command": "node",
      "args": ["/absolute/path/to/opencode-http-mcp/index.js"],
      "env": {
        "OPENCODE_BASE_URL": "http://192.168.123.101:49374",
        "OPENCODE_SERVER_USERNAME": "opencode",
        "OPENCODE_SERVER_PASSWORD": "YOUR_PASSWORD_HERE"
      }
    }
  }
}
```

## Tools

### Basic

| Tool | Description |
|---|---|
| `opencode_health` | Server health + provider count |
| `opencode_session_list` | List all OpenCode sessions |
| `opencode_session_create` | Create a new session |
| `opencode_message_list` | Read all messages in a session |
| `opencode_file_read` | Read a file on the server (via `/api/fs/read`) |
| `opencode_agent_list` | List available agents |
| `opencode_provider_list` | List configured LLM providers |
| `opencode_config` | Read server configuration |
| `opencode_ask` | Send a prompt and poll for the assistant's reply |

### Workflow

| Tool | Description |
|---|---|
| `opencode_setup` | Environment setup (currently a no-op acknowledgement) |
| `opencode_run` | Alias of `opencode_ask` |
| `opencode_fire` | Alias of `opencode_ask` (fire-and-forget) |
| `opencode_wait` | Poll a session/job until it finishes or times out |
| `opencode_check` | Basic session/job status (message counts, optional last message) |
| `opencode_job_list` | List jobs (placeholder — server has no job API yet) |
| `opencode_job_get` | Get a job (placeholder) |
| `opencode_job_cancel` | Cancel a job (placeholder) |
| `opencode_job_input` | Send input to a job (placeholder) |

> The `job_*` tools are placeholders. OpenCode currently does not expose a
> job-management HTTP API; they will be wired to real endpoints once the
> server provides them.

## Run the smoke test

```bash
OPENCODE_BASE_URL=http://192.168.123.101:49374 \
OPENCODE_SERVER_USERNAME=opencode \
OPENCODE_SERVER_PASSWORD=*** \
node test.js
```

The test exercises `tools/list` and a couple of read-only tools
(`opencode_health`, `opencode_session_list`) against a live server.

## How it works (architecture)

```
MCP client (stdio JSON-RPC)
        │  initialize / tools/list / tools/call
        ▼
index.js  ── node:readline  ──► hand-rolled JSON-RPC handler
        │
        └── node:http  ──►  OpenCode server  /api/...  (Basic Auth)
```

- **Protocol layer** (`handle`): parses one JSON-RPC line at a time, answers
  `initialize`, `tools/list`, `tools/call`, and returns the standard
  `content: [{type:'text', text}]` shape.
- **HTTP layer** (`api`): a small promise wrapper around `http.request` with
  a 15 s timeout and JSON parsing; every business call is prefixed with
  `/api/` as OpenCode 2.x/3.x requires.

## License

MIT — see [LICENSE](./LICENSE).
