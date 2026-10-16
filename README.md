# opencode-http-mcp

A **zero-dependency, pure-JavaScript** stdio MCP server that bridges MCP
clients (WorkBuddy, Claude Desktop, Cursor, any JSON-RPC stdio client) to an
OpenCode 2.x / 3.x server.

It talks **directly** to OpenCode's official `/api/...` HTTP endpoints and
hand-rolls the MCP stdio (JSON-RPC) protocol on top of `node:readline`.
No `@modelcontextprotocol/sdk`, no `zod`, no build step — just Node standard
library.

## Why this exists

The community `opencode-mcp` 3.x package is TypeScript + `@opencode-ai/sdk`
+ zod and must be built before use. Its `OpenCodeClient` routes to whatever
the installed SDK knows about — and the SDK currently only ships 1.x-style
paths, so it does not match a running OpenCode **2.x/3.x** server that moved
every business endpoint behind an `/api/...` prefix. The result: `405`,
the Web UI HTML fallback, or `.map is not a function` crashes.

`opencode-http-mcp` speaks the current `/api/...` contract from the start,
with **full tooling parity** to `opencode-mcp 3.x` (all ~85 tools) grouped
into layered modules, and **honest no-route fallbacks** for the small set of
1.x-only endpoints that a 2.x build does not expose (instead of faking data).

## Architecture (layered, mirrors upstream)

```
Layer 0    src/http.js      OpenCodeClient — HTTP + SSE + { data } unwrap
Layer 0.5  src/helpers.js   formatting / result envelopes / redaction
Layer 0.5  src/registry.js  tool registry
Layer 0.5  src/util.js      arg helpers (dir / req / modelOpts)
Layer 1    src/jobs.js      JobService — session-turn dispatch & observation
Layer 2    src/tools/*.js   grouped tool modules (one per upstream file)
Entry      src/index.js     stdio JSON-RPC MCP entry point
```

Upstream parity map:

| upstream file | module | tools |
|---|---|---|
| session.ts | session.js | 20 |
| message.ts | message.js | 6 |
| file.ts | file.js | 6 |
| config.ts | config.js | 3 |
| provider.ts | provider.js | 6 |
| project.ts | project.js | 3 |
| misc.ts | misc.js | 12 |
| global.ts | global.js | 1 |
| events.ts | events.js | 1 |
| input.ts | input.js | 5 |
| tui.ts | tui.js | 9 |
| workflow.ts | workflow.js | 10 |

Total: **~85 tools**.

## Features

- **Zero dependencies** — only `node:http`, `node:https`, `node:url` from stdlib.
- **No build step** — point your MCP client at `src/index.js` and it runs.
- **Correct `/api/...` routing** for OpenCode 2.x/3.x.
- **Full parity** with `opencode-mcp 3.x` tooling.
- **Honest no-route fallbacks** — for 1.x-only endpoints a 2.x build lacks,
  tools return a clear "unavailable on this build" message instead of 404s.

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
| `OPENCODE_TIMEOUT_MS` | `120000` | Per-request HTTP timeout (ms) |
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
      "args": ["/absolute/path/to/opencode-http-mcp/src/index.js"],
      "env": {
        "OPENCODE_BASE_URL": "http://192.168.123.101:49374",
        "OPENCODE_SERVER_USERNAME": "opencode",
        "OPENCODE_SERVER_PASSWORD": "YOUR_PASSWORD_HERE"
      }
    }
  }
}
```

## Routes pinned (live-verified on OpenCode 2.0.30)

Live 200 endpoints used by real tools:
`/api/session`, `/api/session/{id}`, `/api/session/{id}/message`,
`/api/session/{id}/prompt`, `/api/session/{id}/diff`, `/api/session/{id}/fork`,
`/api/agent`, `/api/command`, `/api/config`, `/api/vcs`, `/api/vcs/status`,
`/api/provider`, `/api/model`, `/api/project`, `/api/skill`, `/api/mcp`,
`/api/integration`, `/api/reference`, `/api/pty`, `/api/event`,
`/global/health`, `/global/event`.

Honest no-route fallbacks (1.x-only, 404 on 2.0.30):
`/api/fs/find` → `opencode_find_text|file|symbol`;
`/api/question`, `/api/permission` → `opencode_question_*`, `opencode_job_input`;
`/api/provider/auth`, `/api/provider/{id}/oauth/*`, `/api/auth/{id}`;
`/api/tui/*` → `opencode_tui_*`;
`/api/path`, `/api/lsp`, `/api/formatter`, `/api/log`,
`/api/instance/dispose`, `/api/project/current`,
`/api/session/{id}/abort|todo|status|share|summarize|revert|unrevert|children`.

## Run the smoke test

```bash
OPENCODE_BASE_URL=http://192.168.123.101:49374 \
OPENCODE_SERVER_USERNAME=opencode \
OPENCODE_SERVER_PASSWORD=*** \
node test.js
```

The test exercises `tools/list` plus a handful of read-only and no-route
tools against a live server.

## License

MIT — see [LICENSE](./LICENSE).
