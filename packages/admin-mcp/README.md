# `@brigadir/admin-mcp` — the `brigadir-admin` MCP server

A stdio [MCP](https://modelcontextprotocol.io) server that lets a human + Claude Code
**assemble a team** on a BRIGADIR workspace: study a Jira board and/or local code,
create a workspace, and spawn its agents — all through tools, without hand-editing the
dashboard.

It is a **thin HTTP client** of the dashboard admin API (`/api/workspaces*`,
`/api/agents*`, `/api/executors`) — zero direct database access. Secrets live only in
its env and are never tool arguments (Constitution Principle V).

> **Not the callback MCP.** `@brigadir/mcp-server` (`brigadir-mcp`) is for an agent
> INSIDE a run — a short-lived per-run JWT and the callback tools
> (`report_progress` / `request_human` / `complete_task`) + read-only Jira. THIS
> server is the admin plane for a human + Claude OUTSIDE any run — the dashboard
> bearer, and it CREATES workspaces and agents. The two never overlap.

## Configure (Claude Code)

Build the package and point Claude Code at `dist/main.js`. Provide the four env vars —
**no real secrets are committed here**; fill them from your deployment.

```jsonc
{
  "mcpServers": {
    "brigadir-admin": {
      "command": "node",
      "args": ["packages/admin-mcp/dist/main.js"],
      "env": {
        "BRIGADIR_API_URL": "http://localhost:3000",
        "BRIGADIR_DASHBOARD_TOKEN": "<dashboard bearer>",
        "BRIGADIR_JIRA_EMAIL": "bot@acme.com",
        "BRIGADIR_JIRA_API_TOKEN": "<jira bot API token>"
      }
    }
  }
}
```

| Env var | Meaning |
|---------|---------|
| `BRIGADIR_API_URL` | Backend base URL, e.g. `http://localhost:3000`. |
| `BRIGADIR_DASHBOARD_TOKEN` | Admin API bearer (sent only in the `Authorization` header). |
| `BRIGADIR_JIRA_EMAIL` | Jira bot email — injected into the `create_workspace` body. |
| `BRIGADIR_JIRA_API_TOKEN` | Jira bot API token — injected into the `create_workspace` body. |

All four are required; a missing one exits with a stderr message. Secrets NEVER appear
in a tool argument or in argv.

## Tools

Read-only recon:

- `list_workspaces` — `{ items: [{id,name,project_key,board_type,enabled}] }`
- `get_workspace` `{workspace_id}` — full workspace detail incl. `enabled`
- `get_board_statuses` `{workspace_id}` — `{statuses: [{name,category}]}` (the **only**
  sanctioned source of status names for a team proposal)
- `list_executors` — `{items: [{name,type,model,enabled}]}` (agents reference a profile
  by NAME)
- `list_agents` `{workspace_id}` — the roster incl. `is_orchestrator`

Writes (each goes through the existing API validation path — no bypasses):

- `create_workspace` `{name, jira_site_url, board, expires_at, repositories?}` — the
  server injects the Jira email/token from env. Returns
  `{workspace_id, project_key, board_type, enabled:false}`. **A new workspace is created
  PAUSED**; a human presses Start in the dashboard (there is no start tool).
- `generate_agents` `{workspace_id}` — start the orchestrator's setup run; returns
  `{run_id}`. 409 codes: `worker_agents_exist`, `no_orchestrator`, `setup_run_active`.
- `create_team` `{workspace_id, agents:[…1..20]}` — atomically spawn the whole team. An
  invalid agent ⇒ 422 with path-qualified issues and **zero created** (fix the flagged
  field and retry). 409 `worker_agents_exist` if a team already exists.
- `create_agent` / `update_agent` — pointwise agent writes (same server-side lint). No
  deletion tool (the orchestrator is server-protected).

Every tool declares an `inputSchema` AND an `outputSchema` (MCP structured output);
schemas are the zod 4 definitions in `@brigadir/contracts`, converted to draft-07 JSON
Schema. On a 4xx the tool errors with the response body (so the model sees the
path-qualified issues and can repair its input); a 5xx/network error is retried with
bounded backoff.

## Develop

```bash
pnpm --filter @brigadir/contracts build
pnpm --filter @brigadir/admin-mcp build      # emits dist/main.js
pnpm --filter @brigadir/admin-mcp test       # handler units (injectable fetchImpl)
```
