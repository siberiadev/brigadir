# Contract: admin tools → HTTP mapping

The `brigadir-admin` stdio MCP server exposes nine tools. Each maps to one dashboard
HTTP call, authenticated with `Authorization: Bearer $BRIGADIR_DASHBOARD_TOKEN`.
stdout is MCP protocol only; logs go to stderr.

## Env (fail-fast `requireEnv`, missing → exit 1)

| Var | Meaning |
|-----|---------|
| `BRIGADIR_API_URL` | backend base URL, e.g. `http://localhost:3000` |
| `BRIGADIR_DASHBOARD_TOKEN` | admin API bearer (header only) |
| `BRIGADIR_JIRA_EMAIL` | Jira bot email, injected into `POST /api/workspaces` body |
| `BRIGADIR_JIRA_API_TOKEN` | Jira bot API token, injected into `POST /api/workspaces` body |

Secrets NEVER appear in a tool input schema or in argv.

## Read tools

```
list_workspaces      GET  /api/workspaces?page_size=100        → { items: [{id,name,project_key,board_type,enabled}] }
get_workspace        GET  /api/workspaces/:id                  → workspace detail (+ enabled)
get_board_statuses   GET  /api/workspaces/:id/statuses?refresh=true → { statuses: [{name,category}] }
list_executors       GET  /api/executors?page_size=100         → { items: [{name,type,model?,enabled}] }
list_agents          GET  /api/agents?workspace=:id&page_size=100 → { items: [{...,is_orchestrator}] }
```

## Write tools

```
create_workspace   POST /api/workspaces
    body = { name, jira_site_url, jira_email(from env), jira_api_token(from env),
             expires_at, board, repositories }
    → 201 { workspace_id, project_key, board_type, enabled:false }

generate_agents    POST /api/workspaces/:id/generate-agents
    → 202 { run_id }
    409 codes: worker_agents_exist | no_orchestrator | setup_run_active

create_team        POST /api/workspaces/:id/team           (NEW endpoint)
    body = { agents: TeamAgent[1..20] }
    → 201 { workspace_id, agents_created }
    409 worker_agents_exist (v1 does not rebuild existing teams)
    422 { error:{ code:'validation_failed', issues:[{path,code,message}] } }  (atomic: ZERO created)

create_agent       POST /api/agents                        → 201 { id, name, is_orchestrator }
update_agent       PUT  /api/agents/:id                    → 200 { id, name, is_orchestrator }
    422 on lintAgent blocking errors (path-qualified issues)
```

## Error handling (mirrors the callback MCP)

- **4xx** → tool error (`isError:true`) with the response body verbatim; NO retry. The
  body carries path-qualified issues so the model can repair its input.
- **5xx / network** → bounded retries (default 3, exp backoff), then a tool error.
- **2xx** → `structuredContent` = the parsed body + a text duplicate in `content`.

## Backend endpoint: `POST /api/workspaces/:id/team`

- Guard: `DashboardTokenGuard` (shared bearer).
- Preconditions: workspace exists (404 `workspace_not_found`); no worker agents
  (409 `worker_agents_exist`).
- Body: `{ agents: TeamAgentSchema[1..20] }`.
- Uses `SetupApplyService.createTeamDirect(workspaceId, agents)`:
  - `validateTeam` (names ∪ existing ∪ statuses via `lintAgent` ∪ executor profiles by
    NAME ∪ intra-proposal trigger collisions) — all-or-nothing.
  - on valid: insert N agents (enabled) in ONE transaction. NO run finalize, NO review
    task (that is the run-bound path).
  - `invalid` → 422 path-qualified issues; `applied` → 201 `{workspace_id, agents_created}`.
- The run-bound `acceptTeamReport` path is unchanged (shares `validateTeam` +
  `insertTeamAgents`).
