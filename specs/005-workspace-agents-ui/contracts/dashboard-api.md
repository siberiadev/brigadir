# Contract: Dashboard REST API (Feature 005)

**Base**: `/api` · **Auth**: `Authorization: Bearer <BRIGADIR_DASHBOARD_TOKEN>` on
**every** route below (`DashboardTokenGuard`, research R5). Missing/invalid → `401`.
Distinct from `/api/callbacks/*` (`RunTokenGuard`, per-run JWT). All request/response
bodies are typed in `packages/contracts` (single source; consumed by backend + web).

Errors use the shared shape in **`### Error shape`** at the bottom. `422` is used for
validation/linter failures so the wizard/form can attach each issue to its field.

---

## Workspaces

### `GET /api/workspaces`
List. `200` → `Workspace[]` (credentials **never** serialized; `expires_at`,
`board_type`, `project_key`, repository count included). Adds a derived
`credential_status: "ok" | "warn_30" | "warn_7" | "expired"` for the badge (FR-021).

### `POST /api/workspaces/verify`  *(pre-persist Verify — FR-005)*
Live-validates candidate credentials + board **without persisting** (uses a throwaway
client from `JiraClientFactory`, research R6).

Request:
```jsonc
{ "jira_site_url": "https://acme.atlassian.net",
  "jira_email": "bot@acme.com",
  "jira_api_token": "…",
  "board": "https://acme.atlassian.net/…/RapidBoard.jspa?rapidView=42  |  42" }
```
`200`:
```jsonc
{ "bot_display_name": "BRIGADIR Bot",   // from GET /myself
  "project_key": "BRIG",                 // from board.location
  "board_id": 42,                        // extracted from URL or echoed
  "board_type": "kanban" }               // GET /rest/agile/1.0/board/{id}
```
Failures (`422`, path-qualified so the wizard pins them inline):
- bad/expired token → issue at `jira_api_token`, `code: "token_invalid"`.
- token ok, board inaccessible → issue at `board`, `code: "board_forbidden"` (distinct
  from token failure — Acceptance US1 #4).
- board id not extractable from URL → issue at `board`, `code: "board_unparseable"`
  (FR-006).

### `POST /api/workspaces`  *(create — FR-007/FR-008)*
Server **re-runs Verify** (never trusts the client result) before writing.
Request:
```jsonc
{ "name": "Acme",
  "jira_site_url": "…", "jira_email": "…", "jira_api_token": "…",
  "expires_at": "2027-07-12T00:00:00Z",     // user-entered, default +1y
  "board": "42",
  "repositories": [ { "name": "api", "git_url": "git@…", "default_branch": "main" } ] }
```
`201` → `Workspace` (persisted: name, site, project_key, board_id, board_type,
**encrypted** credentials, `expires_at`, ordered `repositories` first=default). Re-
validation failure → `422` (workspace **not** created — edge "Verify ok, persist fails").

### `PUT /api/workspaces/:id/jira-connection`  *(rotate — FR-024)*
Re-verifies live, replaces encrypted credentials + `expires_at`, and **invalidates the
memoized Jira client** (research R6 seam). Request: `{ jira_email, jira_api_token,
expires_at }`. `200` → `Workspace`. `422` on re-verify failure (old creds retained).

### `PUT /api/workspaces/:id/settings`  *(FR-024)*
Request (all optional): `{ scope_jql?, branch_prefix?, repositories? }`. `200` →
`Workspace`. Takes effect next poller pass, no restart (FR-026).

### `GET /api/workspaces/:id/statuses`  *(FR-011)*
Flat board status list. Query `?refresh=true` forces a Jira re-fetch (agent form open).
`200` → `{ statuses: { id, name, statusCategory: "new"|"indeterminate"|"done" }[] }`.
Unavailable upstream → `502 { code: "statuses_unavailable" }` (form blocks status
editing rather than showing empty/stale — spec edge case).

---

## Agents

### `GET /api/agents?workspace=:id`
`200` → `Agent[]` (full field set incl. `behavior`).

### `POST /api/agents`  ·  `PUT /api/agents/:id`  *(FR-009/FR-012/FR-013)*
Request = full agent field set:
```jsonc
{ "workspace_id": "…", "name": "Implementer", "instruction": "…",
  "executor_id": "…", "model": "claude-…",
  "trigger_status": "Ready for Dev", "trigger_jql": null,
  "status_running": "In Progress", "status_success": "In Review", "status_failure": "Blocked",
  "status_ids": { "trigger": "10001", "running": "3", "success": "10002", "failure": "10003" },
  "timeout_minutes": 45, "max_budget_usd": 5.0, "max_attempts": 2,
  "repository": null,                       // null = workspace default (index 0)
  "behavior": { "branch_prefix": null, "allowed_tools": ["Read","Edit","Bash"],
                "required_checks": ["build"], "use_callback_channel": true } }
```
`201`/`200` → `Agent`. **Server runs the mini-linter** (below) before writing:
- blocking errors → `422` with `linter` issues; nothing written.
- non-blocking `status_cycle` warning → still `201`/`200`, `warnings[]` in the body.

### `DELETE /api/agents/:id`  *(FR-015)*
Agent with ≥1 run → **soft** (`enabled=false`), `200 { soft_deleted: true }`. Agent with
0 runs → **hard** delete, `200 { soft_deleted: false }`.

### `POST /api/agents/:id/test-run`  *(FR-014)*
Request `{ ticket_key: "BRIG-123" }`. Reuses the existing manual-run path
(`RunTriggerService`, `triggerEvent.source = "manual"`) → honors the 3-level dedup
(spec Assumption). `202 { run_id }` or `200 { deduplicated: true, existing_run_id }`.

---

## Mini-linter (server = authority, client mirrors — FR-012)

Pure function `lint(candidate, agentsInWorkspace, boardStatuses)` in a lib, exported to
both backend (authority) and `apps/web` (immediate feedback). Rules & codes:

| Code | Level | Rule (spec) | Attaches to field |
|------|-------|-------------|-------------------|
| `status_absent` | error | any status name ∉ board flat list (FR-012a) | the offending status field |
| `duplicate_trigger` | error | `trigger_status` == another **enabled** agent's, `trigger_jql` equal/absent (FR-012b) | `trigger_status` |
| `status_cycle` | warning | A.success→B.trigger and B.success→A.trigger (FR-012c) | `status_success` (non-blocking) |

Disabled agents never cause `duplicate_trigger` (edge case); enabling one later re-runs
the linter.

## Error shape (`4xx`/`5xx`, path-qualified — FR-013/SC-009)

```jsonc
{ "error": { "code": "validation_failed",
    "message": "Agent could not be saved.",
    "issues": [
      { "path": ["status_success"], "code": "status_absent",
        "message": "\"Done Done\" is not a status on this board.",
        "value": "Done Done", "level": "error" }
    ],
    "warnings": [
      { "path": ["status_success"], "code": "status_cycle",
        "message": "This may form a status cycle with agent \"QA\".", "level": "warning" }
    ] } }
```
`path` is a JSON-pointer-style array so the form maps each issue to its input. No raw
stack traces (SC-009). `verify`/create reuse the same shape with `path` rooted at
`jira_api_token` / `board`.
