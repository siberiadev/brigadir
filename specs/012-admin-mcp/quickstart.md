# Quickstart: `brigadir-admin`

## Build & configure

```bash
pnpm --filter @brigadir/contracts build
pnpm --filter @brigadir/admin-mcp build
```

Claude Code MCP config (`.mcp.json` / `claude mcp add`), no real secrets committed:

```json
{
  "mcpServers": {
    "brigadir-admin": {
      "command": "node",
      "args": ["packages/admin-mcp/dist/main.js"],
      "env": {
        "BRIGADIR_API_URL": "http://localhost:3000",
        "BRIGADIR_DASHBOARD_TOKEN": "<dashboard bearer>",
        "BRIGADIR_JIRA_EMAIL": "bot@acme.com",
        "BRIGADIR_JIRA_API_TOKEN": "<jira bot token>"
      }
    }
  }
}
```

## Scenario A — assemble a team from scratch

1. `list_executors` → note a profile name (agents reference a profile by NAME).
2. `create_workspace { name, jira_site_url, board, expires_at }` → `{ workspace_id,
   project_key, board_type, enabled:false }`. The workspace is PAUSED.
3. `get_board_statuses { workspace_id }` → the real status names for the roster.
4. `create_team { workspace_id, agents:[…] }` → `{ workspace_id, agents_created }`.
   An invalid agent (unknown status, unknown profile, name collision) → 422 with
   path-qualified issues and ZERO created; fix the flagged field and retry.
5. Human reviews the agents in the dashboard and presses Start (not a tool).

## Scenario B — let the orchestrator generate the team

1. `create_workspace …` (paused; a seeded `brigadir` orchestrator is its only agent).
2. `generate_agents { workspace_id }` → `{ run_id }` (202). Second call → 409
   `worker_agents_exist` / `setup_run_active`.
3. Human reviews the generated team and presses Start.

## Verifying

- `pnpm --filter @brigadir/contracts test` — schema contract tests.
- `pnpm --filter @brigadir/admin-mcp test` — handler units (injectable `fetchImpl`).
- `pnpm test:integration` — create_workspace paused, create_team atomic,
  generate_agents 202/409, feature-011 suite still green.
