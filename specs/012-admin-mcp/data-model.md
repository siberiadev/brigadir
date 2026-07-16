# Data Model: Admin MCP server `brigadir-admin`

No new persistence. This feature adds tool schemas (contracts) and one HTTP endpoint;
the only rows it writes are `agents` (via the existing insert path). Below is the tool
surface — input/output zod schemas authored in
`packages/contracts/src/admin-tools.schema.ts`, exported as `AdminTools`.

## Shared value objects

- `WorkspaceSummary` — `{ id, name, project_key, board_type: 'kanban'|'scrum'|null, enabled }`.
- `BoardStatusSummary` — `{ name, category: 'new'|'indeterminate'|'done' }`.
- `ExecutorSummary` — `{ name, type, model: string|null, enabled }`.
- `AgentSummary` — the roster line incl. `is_orchestrator` (subset of `AgentResponse`).
- `RepositoryInput` — `{ name, git_url, default_branch? }` (reuses `WorkspaceRepositorySchema`).

## Tools

| Tool | Input | Output | HTTP |
|------|-------|--------|------|
| `list_workspaces` | `{}` | `{ items: WorkspaceSummary[] }` | GET `/api/workspaces?page_size=100` |
| `get_workspace` | `{ workspace_id: uuid }` | `WorkspaceDetail` (+ `enabled`) | GET `/api/workspaces/:id` |
| `get_board_statuses` | `{ workspace_id: uuid }` | `{ statuses: BoardStatusSummary[] }` | GET `/api/workspaces/:id/statuses?refresh=true` |
| `list_executors` | `{}` | `{ items: ExecutorSummary[] }` | GET `/api/executors?page_size=100` |
| `list_agents` | `{ workspace_id: uuid }` | `{ items: AgentSummary[] }` | GET `/api/agents?workspace=:id&page_size=100` |
| `create_workspace` | `{ name, jira_site_url(url), board, expires_at(iso), repositories? }` | `{ workspace_id, project_key, board_type, enabled(false) }` | POST `/api/workspaces` (server injects email/token) |
| `generate_agents` | `{ workspace_id: uuid }` | `{ run_id }` | POST `/api/workspaces/:id/generate-agents` |
| `create_team` | `{ workspace_id: uuid, agents: TeamAgent[1..20] }` | `{ workspace_id, agents_created }` | POST `/api/workspaces/:id/team` |
| `create_agent` | `AgentWriteInput` | `{ agent_id, name, is_orchestrator }` | POST `/api/agents` |
| `update_agent` | `{ agent_id } & AgentWriteInput` | `{ agent_id, name, is_orchestrator }` | PUT `/api/agents/:id` |

### Field notes (every field carries `.describe(...)`)

- `create_workspace.board` — a numeric board id OR a Jira board URL; the backend
  extracts the id (`board_unparseable`/`board_forbidden` → 422).
- `create_workspace.expires_at` — the Jira token's expiry (ISO 8601), used for the
  credential-status badge; NOT the server's own token.
- `create_workspace` output `enabled` is a `z.literal(false)` — the backend creates
  workspaces PAUSED (feature 011); Start stays with the human.
- `create_team.agents` — `z.array(TeamAgentSchema).min(1).max(20)` (reused). Each
  `TeamAgent` names board statuses (from `get_board_statuses`) and an executor profile
  (from `list_executors`). Cross-field rule (statuses must exist on the board, names
  unique, no trigger collisions) is validated server-side → 422 path-qualified issues.
- `create_agent`/`update_agent` input mirrors `AgentWriteRequestSchema` fields the
  admin plane needs (`workspace_id`, `name`, `instruction`, `executor_id`,
  `trigger_status`, `status_success`, `status_failure`, optional `description`,
  `status_running`, `trigger_jql`, `timeout_minutes`, `max_budget_usd`, `max_attempts`,
  `enabled`). The backend runs `lintAgent` and returns 422 on blocking errors.

## Output-shape rule (MCP structured output)

Each handler returns `{ content: [{type:'text', text: JSON.stringify(body)}],
structuredContent: body }` on success, and `{ content:[...], isError:true }` (no
`structuredContent`) on a non-2xx, with the body carried verbatim.
