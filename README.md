# local-agent-mcp

A local **MCP Agent Hub**: a stdio [Model Context Protocol](https://modelcontextprotocol.io)
server that lets **Claude Code** drive your locally installed, already-logged-in
**Codex CLI** and **OpenCode CLI** as sub-agents.

Claude Code stays the orchestrator. This server exposes four tools — run Codex,
run OpenCode, compare both, and a health check — while enforcing a strict
directory allowlist, read-only-by-default execution, output/concurrency limits,
and secret redaction.

---

## 1. Architecture

```
┌──────────────┐   MCP tool calls    ┌────────────────────────┐   spawn (shell:false)   ┌───────────────┐
│              │  (stdio JSON-RPC)   │    local-agent-mcp      │  ────────────────────►  │  Codex CLI    │
│ Claude Code  │ ──────────────────► │   (this MCP server)     │                          │ (codex exec)  │
│ (MCP client) │ ◄────────────────── │                         │  ────────────────────►  │  OpenCode CLI │
│              │   JSON results      │  • Zod validation       │                          │ (opencode run)│
└──────────────┘                     │  • path allowlist       │                          └───────────────┘
                                     │  • concurrency + locks  │
                                     │  • redaction            │
                                     │  • JSONL/JSON parsing    │
                                     └────────────────────────┘
                                          │ stderr (logs only)
                                          ▼
                                     never pollutes stdout
```

Request flow for a run:

```
tool call → Zod parse → length checks → realpath(cwd) + allowlist check
          → write gate (if writing) → acquire concurrency slot (+ write lock)
          → spawn CLI (shell:false, arg array) → capture (capped) → parse events
          → redact → structured JSON result → release slot
```

Component responsibilities:

| Module | Responsibility |
| --- | --- |
| `src/index.ts` | MCP server bootstrap, stdio transport, tool registration |
| `src/config.ts` | Read & validate environment configuration |
| `src/security.ts` | Path allowlist, realpath/symlink checks, write gating, input limits |
| `src/concurrency.ts` | Global concurrency semaphore + per-directory write lock |
| `src/process-runner.ts` | `spawn` wrapper: shell:false, timeout (SIGTERM→SIGKILL), output cap |
| `src/executable-resolver.ts` | Resolve `codex`/`opencode` to a shell-free spawnable target (Windows `.cmd` fix) |
| `src/redaction.ts` | Mask tokens / API keys / auth headers |
| `src/parsers/codex-parser.ts` | Parse Codex JSONL events |
| `src/parsers/opencode-parser.ts` | Parse OpenCode JSON events |
| `src/tools/*.ts` | The four MCP tool implementations |

---

## 2. Prerequisites

| Requirement | Notes |
| --- | --- |
| **Node.js ≥ 18.17** | ES Modules + modern `spawn`. Tested on Node 24. |
| **Claude Code** | The MCP client. Install per Anthropic docs. |
| **Codex CLI** | Installed and **logged in** (`codex login`). Verify: `codex --version`. |
| **OpenCode CLI** | Installed and **authenticated** (`opencode auth`). Verify: `opencode --version`. |
| **Git** | Optional but recommended; reported by `agent_health`. |

This server does **not** log in for you. Codex and OpenCode must already be
authenticated with your own credentials on the machine.

---

## 3. Install dependencies

```bash
npm install
```

---

## 4. Check that Codex and OpenCode are logged in

Codex:

```bash
codex --version           # should print a version
codex login               # if not already logged in
```

OpenCode:

```bash
opencode --version        # should print a version
opencode auth list        # inspect configured providers
opencode auth login       # if not already authenticated
```

Once this server is registered you can also call the `agent_health` tool from
Claude Code, which reports install status and versions for both CLIs.

---

## 5. Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_ALLOWED_ROOTS` | *(empty)* | **Required.** Comma-separated **absolute** directories agents may access. Empty = nothing allowed. |
| `AGENT_ALLOW_WRITE` | `false` | When `true`, permits `codex_run` `workspace_write` and `opencode_run` `auto_approve`. |
| `AGENT_MAX_OUTPUT_BYTES` | `5000000` | Max combined stdout+stderr bytes captured per run. Excess is truncated. |
| `AGENT_MAX_CONCURRENCY` | `3` | Max simultaneous agent runs. |
| `AGENT_DEBUG` | `false` | When `true`, full prompts are written to the stderr debug log. |

See [`.env.example`](./.env.example).

---

## 6. Build

```bash
npm run build      # compiles TypeScript to ./dist
```

Other scripts:

```bash
npm run dev        # run from source with tsx (no build step)
npm start          # run the compiled server (node dist/index.js)
npm test           # run the vitest suite
npm run typecheck  # type-check only, no emit
npm run lint       # eslint
```

---

## 7. Register with Claude Code (`claude mcp add`)

After building, register the compiled server. Provide the allowlist and any
other config via `--env` flags.

**macOS / Linux:**

```bash
claude mcp add local-agent-hub \
  --env AGENT_ALLOWED_ROOTS=/Users/me/projects,/home/me/work \
  --env AGENT_ALLOW_WRITE=false \
  --env AGENT_MAX_CONCURRENCY=3 \
  -- node /absolute/path/to/local-agent-mcp/dist/index.js
```

**Windows (PowerShell):**

```powershell
claude mcp add local-agent-hub `
  --env AGENT_ALLOWED_ROOTS="C:\Users\me\projects,C:\work" `
  --env AGENT_ALLOW_WRITE=false `
  --env AGENT_MAX_CONCURRENCY=3 `
  -- node "C:\path\to\local-agent-mcp\dist\index.js"
```

Everything after `--` is the command Claude Code will spawn. Use an **absolute
path** to `dist/index.js`.

Verify:

```bash
claude mcp list
```

---

## 8. `.mcp.json` configuration example

To share the server via a project-scoped config, add it to `.mcp.json` (see
[`.mcp.json.example`](./.mcp.json.example)):

```json
{
  "mcpServers": {
    "local-agent-hub": {
      "command": "node",
      "args": ["./dist/index.js"],
      "env": {
        "AGENT_ALLOWED_ROOTS": "C:\\Users\\me\\projects,C:\\work",
        "AGENT_ALLOW_WRITE": "false",
        "AGENT_MAX_OUTPUT_BYTES": "5000000",
        "AGENT_MAX_CONCURRENCY": "3",
        "AGENT_DEBUG": "false"
      }
    }
  }
}
```

> On Windows, JSON requires escaped backslashes (`\\`) in paths. On macOS/Linux
> use ordinary forward-slash paths.

---

## 9. Calling the tools from Claude Code

Once registered, just ask Claude Code in natural language; it will select the
tool and fill parameters. The tools are:

- **`agent_health`** — environment/version/config snapshot.
- **`codex_run`** — run Codex non-interactively.
- **`opencode_run`** — run OpenCode non-interactively.
- **`agent_compare`** — run both (read-only) and return both results.

Example prompts:

> "Use **agent_health** to check whether Codex and OpenCode are installed."

> "With **codex_run**, analyze the code in `/Users/me/projects/api` (read-only)
> and summarize the request-handling flow."

> "Use **agent_compare** on `C:\work\service` to ask both agents how they'd add
> input validation, then tell me where they agree."

### Tool parameters

`codex_run`

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `prompt` | string (req) | — | Instructions for Codex. |
| `cwd` | string (req) | — | **Absolute** path inside an allowed root. |
| `mode` | `read_only` \| `workspace_write` | `read_only` | Maps to Codex `--sandbox read-only` / `workspace-write`. |
| `model` | string | — | Optional model override (`-m`). |
| `timeout_seconds` | number (10–3600) | 300 | Kill after timeout (SIGTERM→SIGKILL). |
| `output_mode` | `final` \| `events` | `final` | `events` also returns raw parsed events. |

`opencode_run`

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `prompt` | string (req) | — | Instructions for OpenCode. |
| `cwd` | string (req) | — | **Absolute** path inside an allowed root. |
| `model` | string | — | `provider/model`. |
| `agent` | string | — | Named OpenCode agent. |
| `session_id` | string | — | Continue an existing `ses_...` session. |
| `auto_approve` | boolean | `false` | Maps to `--auto`; **write** action, requires `AGENT_ALLOW_WRITE=true`. |
| `timeout_seconds` | number (10–3600) | 300 | |
| `output_mode` | `final` \| `events` | `final` | |

`agent_compare`

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `prompt` | string (req) | — | Sent to both agents. |
| `cwd` | string (req) | — | **Absolute** path inside an allowed root. |
| `codex_model` | string | — | Codex model override. |
| `opencode_model` | string | — | OpenCode model override. |
| `timeout_seconds` | number (10–3600) | 300 | Per agent. |
| `parallel` | boolean | `true` | Run both at once or sequentially. |

`agent_compare` is **always read-only** and never judges a winner — it returns
both results verbatim for Claude Code to synthesize.

---

## 10. Path differences: Windows / macOS / Linux

- **Absolute paths are required.** Relative paths are rejected.
- **Windows:** use drive-letter paths, e.g. `C:\Users\me\projects`. In JSON
  (`.mcp.json`) escape backslashes: `C:\\Users\\me\\projects`. Path comparison
  is case-insensitive on Windows.
- **macOS/Linux:** use POSIX paths, e.g. `/Users/me/projects` or
  `/home/me/work`. Comparison is case-sensitive.
- **Symlinks are fully resolved** with `fs.realpath` before the allowlist
  check, on every platform. On macOS note that `/tmp` and `/var` are symlinks;
  the resolved (`/private/...`) path is what gets checked.
- **Windows executable resolution:** npm installs `codex`/`opencode` as `.cmd`
  shims. Node's `spawn` with `shell:false` cannot launch `.cmd` files (a
  security fix, CVE-2024-27980). This server resolves the underlying native
  `.exe` or `node <entry>.js` and spawns that directly — so `shell:false` is
  always preserved and no shell parsing ever happens.

---

## 11. Security notes

- **stdout is protocol-only.** All logs go to **stderr**; nothing else is ever
  written to stdout.
- **Directory allowlist.** Every `cwd` is `realpath`-resolved and must live
  inside an `AGENT_ALLOWED_ROOTS` entry (also realpath-resolved). This blocks
  `../` traversal and symlink escapes.
- **Read-only by default.** Writes require `AGENT_ALLOW_WRITE=true`. Even then,
  `agent_compare` stays read-only.
- **No `shell`, ever.** Processes are spawned with `shell:false` and arguments
  as a discrete array — no string concatenation, so command injection via
  prompt/model/paths is not possible.
- **No arbitrary executables.** Only the fixed `codex`/`opencode` binaries are
  ever launched; user input never chooses the program.
- **No dangerous bypasses.** The server never passes Codex's
  `--dangerously-bypass-approvals-and-sandbox` or `danger-full-access`, and
  exposes no arbitrary-shell tool.
- **Concurrency + write lock.** A global semaphore caps simultaneous runs; at
  most one write task may touch a given directory at a time.
- **Output cap.** Combined stdout+stderr is capped (`AGENT_MAX_OUTPUT_BYTES`).
- **Timeouts.** Runs are killed after `timeout_seconds` (SIGTERM, then SIGKILL
  after a 5s grace period).
- **Input limits.** `prompt`, `cwd`, `model`, `agent`, `session_id` have length
  caps.
- **Redaction.** Bearer tokens, API keys (`sk-…`, `ghp_…`, AWS keys), JWTs, and
  `key=value` secrets are masked in logs and error messages.
- **Prompt privacy.** Full prompts are not logged unless `AGENT_DEBUG=true`.

The server trusts the local, already-authenticated Codex/OpenCode credentials.
Anyone able to call this MCP server can run those CLIs within the allowlist, so
only expose it to trusted clients (Claude Code on your own machine).

---

## 12. Troubleshooting

| Symptom | Cause / Fix |
| --- | --- |
| `agent_health` shows `codexInstalled:false` | `codex` not on PATH for the server process. Confirm `codex --version` in the same shell; reinstall if needed. |
| `codex_not_found` / `opencode_not_found` | Same as above for the run tools. On Windows, ensure the npm global bin dir is on PATH. |
| `no_allowed_roots` | `AGENT_ALLOWED_ROOTS` is empty. Set it to absolute directories. |
| `cwd_not_absolute` | You passed a relative path. Use an absolute one. |
| `cwd_outside_allowed` | The (realpath-resolved) cwd is not inside any allowed root — including symlink targets. |
| `cwd_not_found` | The directory does not exist or is not accessible. |
| `write_not_allowed` | You requested `workspace_write`/`auto_approve` but `AGENT_ALLOW_WRITE` is not `true`. |
| `write_lock_conflict` | Another write task is already running for that directory. Retry after it finishes. |
| `timeout` | The run exceeded `timeout_seconds`. Raise it (max 3600) or narrow the task. |
| Result `truncated:true` | Output exceeded `AGENT_MAX_OUTPUT_BYTES`. Raise it or reduce output. |
| Codex returns a usage-limit error | That's from Codex/your account, surfaced verbatim in `errors`. |
| Nothing happens / client can't connect | Ensure you built (`npm run build`) and pointed the client at the absolute `dist/index.js`. Check the server's stderr. |
| Want to see prompts in logs | Set `AGENT_DEBUG=true` (logs to stderr only). |

---

## 13. Uninstall / remove the MCP server

Remove it from Claude Code:

```bash
claude mcp remove local-agent-hub
```

Or delete the `mcpServers.local-agent-hub` entry from your `.mcp.json`.

Then optionally delete this project directory. Removing this server does **not**
affect your Codex or OpenCode installations or their logins.

---

## Public demo evidence

[`public-demo/demo-manifest.json`](./public-demo/demo-manifest.json) is generated
from one real local, read-only Codex and OpenCode run against the fixed
[`fixtures/public-demo`](./fixtures/public-demo) scenario. The companion
[`publication-receipt.json`](./public-demo/publication-receipt.json) binds the
manifest's SHA-256 digest to the complete publication audit.

The two model outputs are shown without ranking and are not benchmark scores.
They are review evidence for the same small input-validation fixture.

## Privacy boundary

When deployed, the portfolio imports these two reviewed JSON files as a static
replay. It cannot call Codex or OpenCode, spawn a CLI, accept a prompt, proxy a
request, or access local Agent credentials. Real execution remains on the local
machine.

The publication audit rejects write-enabled policy, absolute paths, local
usernames, credential-shaped values, auth headers, session/thread identifiers,
raw stderr, unreviewed prompts, failed Agent runs, and incomplete verification.

## Verification

Run the complete local quality gate:

```bash
npm run check
```

To verify only the committed replay bundle:

```bash
npm run demo:audit
```

`demo:audit` validates the schema, privacy boundary, read-only policy, complete
test totals, receipt checks, and manifest hash without requiring either Agent
login. CI runs this offline audit and never invokes `demo:record`.

---

## License

MIT
