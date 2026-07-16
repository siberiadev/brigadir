# Contract: Read-only Jira callback tools (all runs)

Three new MCP tools on the existing callback server (`packages/mcp-server`), backed by three new
backend endpoints under the run-token guard. Available to EVERY callback-wired run — worker and
orchestrator, ticketed and setup (FR-008). No write operation exists on this surface (FR-010).

## MCP tools (agent-facing)

Registered in `packages/mcp-server/src/main.ts` — BOTH the `TOOL_DEFS` array and the
`switch(name)` dispatch (hardcoded in two places — keep in sync). Input schemas live in
`packages/contracts/src/callback-tools.schema.ts` (zod → `zodToJsonSchema`, same as the
existing three tools). The wrapper prose (`libs/executors/src/claude-cli/wrapper.ts`,
`callbackToolsSection`) gains a short "reading Jira" paragraph: reporting tools remain the
agent's ONLY voice; read tools are eyes, not voice.

| Tool | Input (zod, `.strict()`) | Backend call |
|------|--------------------------|--------------|
| `get_project_overview` | `{}` | `GET  api/callbacks/runs/:runId/jira/overview` |
| `search_tickets` | `{ text?: ≤200, status?: ≤100, issue_type?: ≤100, max_results?: 1..50 }` | `POST api/callbacks/runs/:runId/jira/search` |
| `get_ticket` | `{ key: ≤50 }` | `GET  api/callbacks/runs/:runId/jira/tickets/:key` |

Transport identical to existing tools: `Authorization: Bearer <run JWT>`, `postWithRetry`
5xx-only retries, 4xx surfaced verbatim to the model as tool errors.

## Backend endpoints

Controller: extends `libs/callback` (`@Controller('api/callbacks/runs/:runId')`,
`@UseGuards(RunTokenGuard)` — token sig + `sub===runId` + DB `status ∈ {running,awaiting_human}`,
re-read per call; nothing new to invent). Jira access via
`JiraClientFactory.forWorkspace(run.workspaceId)` — inherits the workspace rate limiter and
per-issue error taxonomy. **Credentials never leave the backend** (Constitution V).

### `GET …/jira/overview` → 200

```jsonc
{
  "project_key": "PROJ",
  "board_type": "scrum" | "kanban" | null,
  "statuses":   [{ "name": "To Do", "category": "new" }, …],
  "issue_types":[ "Task", "Bug", "Story", … ],
  "active_sprint": { "id": 42, "name": "Sprint 7" } | null   // scrum only, best-effort
}
```

Composed from the workspace row (`board_type`, `project_key`) + `getProjectStatuses` (+ issue
types extracted from the same `/project/{key}/statuses` response) + `getActiveSprintId`.

### `POST …/jira/search` body `{text?, status?, issue_type?, max_results?}` → 200

**The server composes the JQL — raw JQL is never accepted (D6):**
`project = <workspace.jiraProjectKey>` `AND sprint in openSprints()` (scrum boards only,
mirroring poller scope) `AND status = :status` `AND issuetype = :issue_type`
`AND text ~ :text`, `ORDER BY updated DESC`. Executed via the new
`JiraClient.searchIssues(jql, DEFAULT_SEARCH_FIELDS, maxResults ≤ 50)`.

```jsonc
{ "items": [{ "key","summary","status","issue_type","assignee","updated" }, …],
  "truncated": false }
```

### `GET …/jira/tickets/:key` → 200 | 403 | 404

Scope check FIRST: the issue's project key must equal the run workspace's project key —
otherwise `403 {error:'out_of_scope'}` (never leaks whether the issue exists elsewhere).
Served by the new `JiraClient.getIssueDetail(key)`
(`GET /rest/api/3/issue/{key}?fields=summary,description,status,issuetype,labels,issuelinks,comment`).

```jsonc
{
  "key","summary","status","issue_type","labels":[…],
  "description": "…", // ADF→text, ≤4000 chars
  "links": [{ "type":"blocks","direction":"outward","key","status" }, …],
  "comments": [{ "author","created","body" /* ≤1500 */ }, …], // newest first, ≤20
  "truncated": true|false
}
```

## Size bounds (D8, FR-011)

Applied in the backend mappers: description ≤4000 chars, comment body ≤1500, ≤20 comments
(newest first), ≤50 search items. Every truncation sets `truncated:true` and appends
`…[truncated]` to the cut field.

## Error mapping

| Condition | HTTP | Tool result |
|-----------|------|-------------|
| bad/expired token, wrong run | 401 | tool error (as existing tools) |
| run not active | 409 | tool error |
| out-of-scope key | 403 `out_of_scope` | tool error, no data |
| unknown key (in scope) | 404 | tool error |
| Jira 429/5xx | 502-shaped after limiter retries | tool error, agent may retry |

## Tests

Integration (mock Jira layer, `test/integration/mock-jira.ts`): each tool happy path;
out-of-scope 403; truncation flags; guard rejections (foreign token, finished run);
scrum-scope JQL composition vs kanban. Contract tests for the three input schemas.
