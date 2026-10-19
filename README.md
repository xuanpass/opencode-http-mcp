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
with **full tooling parity** to `opencode-mcp 3.x` — every one of the
upstream's 87 unique tool names (92 locally, incl. 5 extras), grouped into
layered modules — and **honest no-route fallbacks** for the small set of
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

## Upstream parity map (opencode-mcp 3.x → opencode-http-mcp)

### Tool-surface parity — 100% of upstream names, plus 5 extras

| upstream file | module | upstream tools | local tools | delta |
|---|---|---:|---:|---|
| session.ts | session.js | 20 | 20 | — |
| message.ts | message.js | 6 | 6 | — |
| file.ts | file.js | 6 | 6 | — |
| config.ts | config.js | 3 | 3 | — |
| provider.ts | provider.js | 6 | 6 | — |
| project.ts | project.js | 3 | 3 | — |
| misc.ts | misc.js | 12 | 16 | +integration/pty/reference/skill_list (2.x routes upstream doesn't wrap) |
| global.ts | global.js | 1 | 1 | — |
| events.ts | events.js | 1 | 1 | — |
| input.ts | input.js | 6 | 4 | job tools moved to workflow.js |
| tui.ts | tui.js | 9 | 9 | — |
| workflow.ts | workflow.js | 13 | 17 | +job_list/get/cancel/update (JobService tools live here) |
| **total** | | **86 registrations → 87 unique names** | **92 unique names** | **0 missing, 5 extra** |

- **0 missing**: every `opencode_*` tool name upstream registers exists locally,
  verified by name-level diff (`comm`), no duplicate registrations.
- **5 extra**: `opencode_integration_list`, `opencode_pty_list`,
  `opencode_reference_list`, `opencode_skill_list` (wrap 2.x routes upstream
  ignores), plus `opencode_job_update` as an alias of upstream's
  `opencode_job_input` (kept for existing callers).
- `opencode_job_input` ≡ `opencode_job_update` — same implementation, two names.

### `opencode_run` dual entry (upstream design, simplified here)

Upstream has **two entry points to the same `JobService.start()`**:

1. **Legacy path (always available):** the MCP client calls the
   `opencode_run` **tool** → `tools/workflow.ts` → `jobs.start()` + observe.
   Works on any MCP protocol version.
2. **Modern path (`task-transport.ts` interceptor):** if the connection is a
   2026-07-28+ "modern" session **and** the client advertised the Tasks
   extension capability, the interceptor *hijacks* the `opencode_run` tool
   call before it reaches the tool layer and converts it into a `tasks/*`
   JSON-RPC extension request (`tasks/get` / `tasks/update` / `tasks/cancel`
   become the observation channel instead of repeated `tools/call`s).
   Otherwise (-32021/-32022 errors) it falls through to the legacy path.

**opencode-http-mcp implements only the legacy path.** The interceptor is a
transport-level concern that requires the Tasks extension handshake, which
this bridge does not advertise (`capabilities: { tools: {} }`). Behavior is
identical for every non-Tasks client — which is all stdio JSON-RPC clients
today, including WorkBuddy.

### Short-task tools vs long-task tools — sibling layers

```
OpenCodeClient (http.js)                ← Layer 0: single HTTP round-trip
   ▲                    ▲
   │                    │
short-task tools     JobService (jobs.js) ← Layer 1: multi-call state machine
(ask/reply/file/*)   start() → get() → update()/cancel()   + persistence
   │                    │
   └── BOTH dispatch one-shot tools through JobService when the route is
       fire-and-forget (2.x /prompt returns immediately), then observe via
       waitForSnapshot() until terminal — so the caller gets the AI reply,
       not an echo of its own prompt.
```

- **Short tools** (`opencode_file_read`, `opencode_provider_list`, …): one
  request → format → return. They call `OpenCodeClient` directly.
- **Long tools** (`opencode_run` / `fire` / `check` / `wait` / `job_*`):
  `jobs.start()` submits once and persists a durable `jobId`; observation is
  a *separate* read (`jobs.get` per poll — no self-polling loop inside the
  job record); `waitForSnapshot()` in `workflow.js` owns the wait loop.
- **Neither layer calls the other**: short tools and JobService are siblings
  under `OpenCodeClient`. The one crossing point is the one-shot tools
  (`ask`/`reply`/`provider_test`/`message_send`), which route *through*
  `jobs.start()` + `waitForSnapshot()` purely to observe fire-and-forget
  prompt submissions.

### Feature parity beyond tools

| capability | upstream | opencode-http-mcp |
|---|---|---|
| Tools | 87 unique names | 92 (100% of upstream + 5) |
| Persistent JobService (store/lock/recover/TTL) | ✅ jobs.ts | ✅ jobs.js (ported, live-tested) |
| MCP **prompts** (6 templates) | ✅ prompts.ts | ✅ implemented |
| MCP **resources** (11 `opencode://` URIs) | ✅ resources.ts | ✅ implemented |
| Tasks extension (`task-transport`, `tasks/*`) | ✅ | ✅ implemented (handlers for tasks/get/update/cancel) |
| Server auto-spawn (`opencode serve`) | ✅ server-manager.ts | ✅ implemented (enabled via OPENCODE_AUTO_SERVE=true) |
| MCP form elicitation for pending inputs | ✅ task-input.ts | ✅ text fallback (relies on client-side input via job_input) |
| Test suite | ✅ vitest | ✅ `test.js` + live smoke (extended unit tests) |
| CacheHints | ✅ (cacheHints in initialize) | ✅ implemented (tools/list, prompts/list, resources/list, resources/templates/list, resources/read) |
| Build / dependencies | TS + sdk + zod, build step | zero-dep, no build |

## Features

- **Zero dependencies** — only `node:http`, `node:https`, `node:url` from stdlib.
- **No build step** — point your MCP client at `src/index.js` and it runs.
- **Correct `/api/...` routing** for OpenCode 2.x/3.x.
- **Full tool parity** — all 87 upstream `opencode_*` tool names (92 local).
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
| `OPENCODE_MCP_STORE_ROOT` | platform state dir | Job store root; `""` = in-memory only |
| `OPENCODE_MCP_SCOPE` | `default` | Store partition (sha256 of baseUrl+scope) |
| `OPENCODE_MCP_TTL_MS` | `86400000` | Durable job TTL (24h) |
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

## Routes pinned (live-verified on OpenCode 2.0.31)

Live 200 endpoints used by real tools:
`/api/session`, `/api/session/{id}`, `/api/session/{id}/message`,
`/api/session/{id}/prompt`, `/api/session/{id}/diff`, `/api/session/{id}/fork`,
`/api/agent`, `/api/command`, `/api/config`, `/api/vcs`, `/api/vcs/status`,
`/api/provider`, `/api/model`, `/api/project`, `/api/skill`, `/api/mcp`,
`/api/integration`, `/api/reference`, `/api/pty`, `/api/event`,
`/api/fs/list`, `/api/fs/find`, `/api/info`,
`/global/health`, `/global/event`.

Response shapes worth knowing (all verified against 2.0.31):
- **Bare arrays** (no `{data}` envelope): `/api/session`, `/api/project`,
  `/api/config`. `src/http.js` unwraps `.data` only for non-array objects, so
  the array is passed through unchanged — callers must do their own
  `Array.isArray` check.
- **Nested object where 1.x had a scalar**: `/api/vcs` returns
  `{"branch":{}}` outside a git worktree, and `/api/mcp` returns
  `{"status":{"status":"connected"}}`. `helpers.js:displayScalar()` is the
  one place that turns such values into text (or `null`).
- **Field renames**: project rows use `canonical`, not `worktree`; provider
  rows have `activation`/`methods`/`connections`, not `env`/`configured`.
- `/global/health` returns the SPA HTML on 2.x — the version lives in
  `/api/info`. `opencode_health` falls back automatically; so do
  `opencode_setup` and `opencode_status`.

Honest no-route fallbacks (1.x-only, 404 on 2.0.31):
`/api/question`, `/api/permission` → `opencode_question_*`, `opencode_job_input`;
`/api/provider/auth`, `/api/provider/{id}/oauth/*`, `/api/auth/{id}`;
`/api/tui/*` → `opencode_tui_*`;
`/api/path`, `/api/lsp`, `/api/formatter`, `/api/log`,
`/api/instance/dispose`, `/api/project/current`,
`/api/session/{id}/abort|todo|share|summarize|revert|unrevert|children`.

Semi-available (not a clean 404, but not usable either):
- `/api/session/status` — GET answers `400 InvalidRequestError`
  ("Expected a string starting with \"ses\"") and POST answers 404.
  `opencode_session_status` derives the same view from `/api/session`
  rows (`outcome` absent ⇒ still running).
- `/api/fs/find?query=` — 200, honours `query`, `type` and `limit`, but
  ignores `offset`, `directory` and `searchDirectory` (the search always
  covers the whole project root). Backs `opencode_find_text|file|symbol`.
- `/api/event` — SSE long connection, so it never "returns" on its own;
  `opencode_events_poll` reads it within a bounded window.
- `/api/provider/auth` — 404 whose body is `ProviderNotFoundError`
  (`providerID: "auth"`), which is easy to mistake for a real provider
  lookup failure.

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
