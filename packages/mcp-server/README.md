# Agent Player MCP server

An MCP server (stdio) that lets a large coding agent — Claude Code, Codex or
any other MCP client — hand **light subtasks** to the Agent Player **small
local agent** (a local Qwen model through Ollama). The large agent keeps the
heavy work; the small agent is free, private and always on.

```
Claude Code / Codex ──stdio──> agent-player-mcp ──HTTP (loopback only)──> Agent Player backend
                                                                           └─ small-local-agent (ollama, qwen3.8:27b)
                                                                              durable task run (CORE-08)
```

Built on the official MCP TypeScript SDK (`@modelcontextprotocol/sdk`,
low-level `Server` + `StdioServerTransport`).

## Tools

| Tool | Input | Returns |
|---|---|---|
| `spawn_small_agent` | `task` (required, ≤ 8000 chars, self-contained), `kind` (`lookup` \| `summary` \| `classification` \| `draft` \| `other`, default `other`), `tools` (subset of `memory_search`, `storage_search`, `read`; default `memory_search` + `storage_search`), `drawers` (e.g. `owner`, `experience`, `project:alpha`, `task:<id>`, `people:<id>`; default none), `max_steps` (default and upper limit 15) | run id, granted tools, opened drawers, budget, model, warnings, capacity |
| `get_result` | `run_id`, `wait_seconds` (0–60, default 0) | result card |
| `list_runs` | `status`, `limit` (default 20) | recent runs + capacity (`active`, `running`, `queued`, `waiting`, `limit`, `available`, `queue_length`) |
| `list_handoffs` | `agent_id`, `kind` (`conversation` \| `task`), `limit` (default 50) | newest done / left / next note of every chat and board task |
| `read_handoff` | `kind`, `scope_id`, `agent_id` (all required) | the note and its earlier versions |
| `edit_handoff` | `kind`, `scope_id`, `agent_id` (required), `done`, `left`, `next`, `questions` (lists you leave out stay) | the new version (source `owner`); the agent's next session starts from it |

The handoff tools use the owner-only `/api/handoffs` routes: a session that is
not the owner account is refused.

Each tool answers with a short Markdown text, the same data as JSON text, and
`structuredContent`.

## Result card

```json
{
  "run_id": "…", "status": "completed", "kind": "lookup",
  "summary": "Release is on Friday.",
  "outputs": [{ "type": "text", "text": "Release is on Friday.\nFound in the project notes." }],
  "steps_used": 3, "max_steps": 15, "duration_ms": 1234, "max_duration_ms": 300000,
  "model": "qwen3.8:27b", "agent": "small-local-agent",
  "tools_granted": ["memory_search"], "tools_used": ["memory_search"], "drawers": ["project:alpha"],
  "needs_review": false, "review_reason": null,
  "warnings": [], "created_at": "…", "finished_at": "…"
}
```

Markdown form (what the model reads first):

```
### Small agent: completed

**Summary:** Release is on Friday.

- run: `…` (lookup)
- model: qwen3.8:27b
- steps: 3/15, time: 1.2 s of 300.0 s
- tools granted: memory_search; used: memory_search
- memory drawers: project:alpha
- needs_review: false
```

`needs_review` is **false only** for a completed run of an informational kind
(`lookup`, `summary`, `classification`) with no warnings. It is **true** for
drafts and `other`, for unfinished, failed or cancelled runs, and whenever
something unusual happened: a tool step failed, the model asked for a tool it
was not given (refused), the agent used `read` (workspace files may be
quoted), the output was cut, or it was empty. A large agent must check those
outputs before using them or passing them on (D-HYBRID).

## Routing rules (what to delegate)

Delegate to the small agent:

- **Lookups** in Agent Player memory and storage ("what did the owner decide about X?").
- **Summaries** of text you pass in the task (logs, notes, long replies).
- **Classification / tagging / triage** with a fixed label set you give.
- **First drafts** of short texts (posts, replies, descriptions) — always reviewed.
- Repetitive light work that would cost large-model tokens for little gain.

Keep for the large agent:

- Writing or changing code, reviews, debugging, architecture.
- Security, permissions, money, legal or health decisions.
- Anything with side effects: sending, paying, deleting, installing, running
  commands (the small agent cannot do these anyway).
- Tasks that need your context, multi-step reasoning, or high accuracy.
- Anything urgent when `list_runs` shows no free slot.

Write the task so it stands alone (the small agent cannot see your
conversation), say what output you want, pick the right `kind`, and open only
the memory drawers it needs.

## Safety

- **Owner only.** The server uses the token saved by `agent-player login`
  (CLI-03, file `auth.json` in the CLI config directory, mode 0600). Files
  readable by others are refused. The backend endpoints
  `/api/small-agent/*` accept only the owner account.
- **Local backend only.** `AGENT_PLAYER_URL` / `BACKEND_URL` / the saved URL
  must point to `127.0.0.1`, `::1` or `localhost` (default
  `http://127.0.0.1:41522`); redirects are refused. The token is never
  printed, logged or put in an error message.
- **Backend identity is checked before the token is sent.** At startup the
  backend writes a per-install id and secret to `instance.json` next to
  `auth.json` (mode 0600; the backend's own copy lives in
  `packages/backend/.data/instance.json`). Before every request the MCP
  server sends a random nonce to the public `GET /api/instance?nonce=…` and
  checks the answer `HMAC-SHA256(secret, "agent-player-instance-v1:<id>:<nonce>")`
  in constant time. Only on a match is the token sent; another local program
  that took the port cannot answer, and gets nothing. If `instance.json` is
  missing, start the backend once. Both files must not be readable by others.
- **File reading is sandboxed.** `read` only works inside the small agent's own
  workspace (`.data/workspaces/small-local-agent/`) or inside one absolute
  directory you pass as `read_dir`. `read_dir` is off by default: the owner
  must list the allowed folders in `SMALL_AGENT_READ_ROOTS` (path-list, e.g.
  `/Users/me/Projects`) in the backend environment. Even inside an allowed
  folder, `read_dir` may never be or contain the Agent Player backend, data
  folder, CLI config folder (token + instance secret), `~/.config`, `~/.aws`,
  `~/.kube`, `~/.docker`, `~/.gnupg`, `~/.ssh`, `~/Library`, `~/.claude*`,
  `~/.codex`, `/etc`, the home folder itself or `/`; `.env*`, keys, databases,
  `.git`, `auth.json`, `instance.json` and credential files stay blocked.
- **Secrets are redacted** from result cards (API keys, tokens, passwords,
  private keys); a card with redactions is marked `needs_review`.
- **Fixed small-agent settings.** The backend always runs the small agent with
  its built-in prompt, the `SMALL_AGENT_MODEL`/default model and fixed
  sampling, whatever the `small-local-agent` row in `agents_config` says. Only
  the owner may edit or delete that agent; an edited row makes every card
  `needs_review`.
- **Delegation never expands permissions.** Granted tools =
  requested ∩ {`memory_search`, `storage_search`, `read`} ∩ the small agent's
  own grants (the owner can narrow them in the grants API), and never an
  exec-class or approval-gated tool. The check is repeated on every attempt
  of the run. Tools the model asks for anyway are refused and reported.
- **Memory drawers** only as requested and allowed for an owner turn
  (`selectDrawers`: at most one project, one task and ten people drawers).
  No drawers requested → the run reads no memory.
- **Budget**: 15 steps / 5 minutes by default (`SMALL_AGENT_MAX_STEPS`,
  `SMALL_AGENT_MAX_DURATION_MS`); a larger `max_steps` is lowered, never raised.
- **Capacity is measured**: at most `SMALL_AGENT_MAX_CONCURRENT` (default 2)
  active runs; further spawns are refused with the current capacity, not
  queued silently. `list_runs` shows the queue.
- The task text is stored only encrypted in the durable run; runs survive a
  backend restart (CORE-08). Cancel with `POST /api/task-runs/:id/cancel`.

Backend settings (environment of the backend): `SMALL_AGENT_MODEL` (default
`DEFAULT_MODEL` / `qwen3.8:27b`), `SMALL_AGENT_MAX_CONCURRENT`,
`SMALL_AGENT_MAX_STEPS`, `SMALL_AGENT_MAX_DURATION_MS`, `OLLAMA_URL`.

## Setup

1. Agent Player backend running locally; Ollama running with the Qwen model.
2. Sign in as the owner once: `agent-player login`.
3. Build the server: `npx tsc -p packages/mcp-server` (from the repo root;
   output in `packages/mcp-server/dist/`).
4. Register it in your MCP client (examples below; replace the path).

### Claude Code

Command line:

```sh
claude mcp add agent-player -- node /path/to/agent_player/packages/mcp-server/dist/index.js
```

or a project `.mcp.json`:

```json
{
  "mcpServers": {
    "agent-player": {
      "command": "node",
      "args": ["/path/to/agent_player/packages/mcp-server/dist/index.js"]
    }
  }
}
```

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.agent-player]
command = "node"
args = ["/path/to/agent_player/packages/mcp-server/dist/index.js"]
```

Optional environment for either client: `AGENT_PLAYER_URL` (loopback only),
`AGENT_PLAYER_CONFIG_DIR` (where `auth.json` lives).

## Tests

```sh
node --import tsx --test packages/mcp-server/test/*.test.mjs
```

The tests start the real server in a child process and speak MCP JSON-RPC
over stdio against an in-process fake backend (no port, no network).
