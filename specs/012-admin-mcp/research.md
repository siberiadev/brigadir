# Research & Decisions: Admin MCP server `brigadir-admin`

## D1 — Thin HTTP client, no DB access

The server holds no drizzle, no schema, no queue. Every tool maps to exactly one
dashboard HTTP call. This mirrors `packages/mcp-server` (the callback MCP) and keeps
the admin plane a pure client of the API the dashboard UI already uses. Rejected:
importing `@brigadir/database` for "convenience" — it would duplicate the API's
validation and violate the single-write-path discipline.

## D2 — Secrets from env only, injected server-side (Constitution V)

Four env vars, read via a fail-fast `requireEnv` (copied from
`packages/mcp-server/src/main.ts`): `BRIGADIR_API_URL`, `BRIGADIR_DASHBOARD_TOKEN`,
`BRIGADIR_JIRA_EMAIL`, `BRIGADIR_JIRA_API_TOKEN`. The bearer goes into the
`Authorization` header of every call; the Jira email/token are injected into the
`POST /api/workspaces` body by the handler. NONE of these appear in any tool input
schema, so the model never sees or passes them. A unit test proves an arg named
`jira_api_token`/`dashboard_token` is ignored. Rejected: accepting creds as tool
args "for flexibility" — a direct Principle V violation.

## D3 — zod 4, input AND output schemas, in contracts

MCP structured output: each tool returns `structuredContent` (validated shape) plus a
text duplicate in `content`. Both schemas live in `packages/contracts/src/admin-tools.schema.ts`
(the single typed source, Constitution I) and are converted with
`z.toJSONSchema(schema, { target: 'draft-7' })` exactly as `packages/mcp-server` does
(iteration 16 pinned draft-07 as the wire dialect — not changed here). `create_team`
REUSES `TeamAgentSchema` from `report.schema` rather than copying it (FR-005).
Refinements (cross-field rules) do not survive JSON Schema conversion, so cross-field
constraints are documented in `.describe(...)` text; the backend returns 422 with
path-qualified issues and the model repairs from those.

## D4 — `create_team` = new atomic endpoint reusing SetupApplyService

The feature-011 `SetupApplyService.acceptTeamReport(runId, report)` couples three
things: (a) run lookup + FR-014 orchestrator/source guard, (b) `validate()`
(names ∪ statuses ∪ executors ∪ triggers, all-or-nothing), (c) `apply()` (insert
agents + review task + guarded run finalize). For the admin endpoint we need (b) and
the agent-insert half of (c) WITHOUT a run and WITHOUT a review task.

Refactor (behavior-preserving):
- Rename `validate` → `validateTeam(workspaceId, agents)` (already run-independent;
  make it usable from a new public method).
- Extract the agent-row build+insert out of `apply()`'s transaction into a private
  `insertTeamAgents(tx, workspaceId, agents, profileByName)` helper. `apply()` keeps
  calling it inside its run-bound transaction (finalize + insert + review task +
  checks) — the run path is byte-for-byte equivalent.
- Add a public `createTeamDirect(workspaceId, agents)` that: resolves profiles,
  validates, and on success inserts the agents in a fresh transaction (NO finalize, NO
  review task). Returns `{kind:'applied', agentsCreated}` | `{kind:'invalid', issues}`.
  A 23505 race degrades to `invalid` just like `apply()`.

The controller (`POST /api/workspaces/:id/team`, DashboardTokenGuard) checks: workspace
exists (404), no worker agents yet (409 `worker_agents_exist`), then calls
`createTeamDirect`; `invalid` → 422 with path-qualified issues (same shape the callback
422 uses). The existing feature-011 integration tests exercise the run path and must
stay green (FR-012).

## D5 — Read tools reuse existing endpoints

- `list_workspaces` → `GET /api/workspaces?page_size=100`, flatten the paginated
  envelope in the handler (v1: a single page of 100 is enough for an internal tool; if
  `total > 100` the handler notes truncation in stderr — documented, not silent).
- `get_workspace` → `GET /api/workspaces/:id`.
- `get_board_statuses` → `GET /api/workspaces/:id/statuses?refresh=true` (the sanctioned
  status-name source; refresh so a freshly-created board is populated).
- `list_executors` → `GET /api/executors?page_size=100`.
- `list_agents` → `GET /api/agents?workspace=:id&page_size=100`.

## D6 — Error posture (mirrors the callback MCP, D9 there)

`postWithRetry`/`getWithRetry` copied from `packages/mcp-server/src/tools.ts`: 4xx is
NEVER retried and surfaces as a tool error with the response body verbatim (the body
carries the lint's path-qualified issues); 5xx/network is retried with bounded backoff
(default 3), then surfaced. `toResult` marks `isError` on any non-2xx and returns both
`structuredContent` (on success) and a text duplicate.

## D7 — No start/pause, no deletion, no executor editing (v1 boundaries)

`create_workspace` output asserts `enabled: false`; there is deliberately no tool to
start a workspace (the feature-011 human gate). No agent/workspace deletion (the
orchestrator is already server-protected; deletion is a dashboard action). No executor
CRUD (executors are platform capacity, managed in the dashboard).
