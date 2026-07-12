# Data Model: Workspace & Agents UI (Feature 005)

**Branch**: `005-workspace-agents-ui` | **Date**: 2026-07-12

## Migration verdict (checked against architecture §3 FIRST)

> **NO DDL migration is due this iteration.** The columns this feature needs already
> exist in `docs/architecture.md §3` and in the implemented Drizzle schema. CLAUDE.md
> rule 5 (schema change ⇒ update §3 + review SQL) is therefore **not triggered**: §3 is
> unchanged, no new file lands in `drizzle/`.

Evidence (both agree, as-is):

| Need | Column | Source | Status |
|------|--------|--------|--------|
| Encrypted credentials at rest | `workspaces.jira_credentials bytea NOT NULL` | `workspaces.ts:18`, §3 | **exists** — format flips plaintext→AES-GCM inside the bytea; no column change |
| Credential expiry (FR-021) | `workspaces.jira_credential_expires_at timestamptz` | `workspaces.ts:19`, §3 | **exists** — the amendment (commit a491c61) already added it; user-entered value |
| Board binding | `workspaces.jira_board_id int`, `jira_board_type text` | `workspaces.ts:16-17`, §3 | **exists** (migration 0001) |
| Repositories, scope_jql, branch_prefix, sprint, HWM | `workspaces.settings jsonb` | `workspaces.ts:20`, §3 | **exists** — jsonb blob, no column change |
| Executor type/config/concurrency | `executors.*` | `executors.ts`, §3 | **exists** |
| Full agent field set | `agents.*` incl. `behavior jsonb` | `agents.ts`, §3 | **exists** |

The only migration-shaped work is a **data migration in code** (re-encrypt legacy
plaintext credential blobs at boot — see `research.md` R2); it changes bytes inside an
existing `bytea`, not the schema.

## Entities (as used this iteration)

### Workspace (`workspaces`)
Root object; one Jira project/board connection.

- **Columns (existing):** `id`, `name`, `jira_site_url`, `jira_project_key`,
  `jira_board_id`, `jira_board_type` (`kanban`|`scrum`), `jira_auth_type`
  (`api_token`), `jira_credentials` (bytea, **now AES-256-GCM**), 
  `jira_credential_expires_at`, `settings` (jsonb), `created_at`, `updated_at`.
- **`settings` jsonb shape** (typed by `WorkspaceSettingsSchema`, extended this
  iteration — a **contracts/zod** change, not DDL):
  - `repositories: { name: string; git_url: string; default_branch: string }[]` — **new**,
    ordered, **first = default** (FR-004/FR-008). Empty agent `repository` inherits index 0.
  - `scope_jql?`, `branch_prefix?` (workspace default inherited by agents),
    `reconcile: { high_water_mark?, active_sprint_id? }` — all existing.
- **Validation:** name non-empty; `jira_site_url` a URL; `expires_at` user-entered,
  defaulted +1 year (Atlassian max), accepted even if past/near (badged immediately).
  Board id extracted from a URL when a URL is supplied (FR-006).
- **Lifecycle / pause (FR-025):** only if it is a genuine one-field flip. §3's
  `workspaces` table has **no `enabled` column** (only `executors`/`agents` do), so a
  workspace-level pause is **NOT a one-field flip** → **deferred** (spec: "only if"). A
  paused-workspace control that needs new schema is out of scope.

### Executor (`executors`)
- **Columns (existing):** `id`, `workspace_id`, `type`, `name`, `config` (jsonb),
  `secrets` (bytea, nullable), `concurrency_limit`, `enabled`, `UNIQUE(workspace_id,name)`.
- **This iteration:** selectable `type` limited to `claude_cli` (+ `mock` for tests);
  the executor-type **registry** (`EXECUTOR_TYPES`) — not the yaml — drives both the
  model options and the provisioned `run.<type>` queue set (FR-018).

### Agent (`agents`)
- **Columns (existing):** `id`, `workspace_id`, `executor_id`, `name`, `instruction`,
  `trigger_status`, `trigger_jql`, `status_running`, `status_success`, `status_failure`,
  `behavior` (jsonb), `timeout_minutes`, `max_budget_usd`, `max_attempts`, `enabled`,
  `UNIQUE(workspace_id,name)`.
- **Status binding by id + name (FR-010).** The columns store the status **name** (the
  poller/pipeline diff by name — Jira is source of truth). To also bind by **id**
  (FR-010, stale-status detection), the selected status **id** is carried in `behavior`
  as `status_ids: { trigger?, running?, success?, failure? }` (jsonb — no column
  change). The linter checks names against the live flat status list; ids let the form
  detect a renamed status.
- **`behavior` jsonb** (typed by `AgentBehaviorSchema`, existing fields):
  `branch_prefix?` (empty inherits workspace), `allowed_tools?`, `required_checks?`,
  plus this iteration's `use_callback_channel?` toggle and `status_ids?` (above).
- **Delete semantics (FR-015):** soft-delete = `enabled=false` when the agent has ≥1
  run (any status); hard-delete (`DELETE`) only when it has **zero** runs. Determined by
  a `runs` existence check at delete time.

### Board status (transient, not persisted)
Flat `{ id, name, statusCategory }[]` from `getProjectStatuses(projectKey)`
(research R3). Cached in-memory per workspace (5-min TTL, force-refreshable). Feeds the
agent-form selects and the linter's existence check. Never written to Postgres.

### Jira credentials (inside `workspaces.jira_credentials`)
`{ email, api_token }` (`JiraCredentialsSchema`), serialized then AES-256-GCM-sealed
into the `bytea` envelope (`0x01 || iv || tag || ciphertext`, research R2). Decrypted
only to build a `BasicAuthJiraClient`. `expires_at` recorded alongside at store time.

## Relationships & invariants (unchanged, restated)

- `executors.workspace_id → workspaces.id` (cascade); `agents.executor_id →
  executors.id`, `agents.workspace_id → workspaces.id` (cascade).
- Idempotency indexes (`runs_one_active`, webhook uniqueness) — untouched (features
  002–004 own runs; not modified here).
- **DB-wins invariant (FR-016/FR-017):** once a `workspaces`/`executors`/`agents` row
  exists, the yaml importer never updates it (insert-if-absent). UI edits are the sole
  post-import mutation channel.

## Linter data (server authority, FR-012)

Pure function over `(agentsInWorkspace, boardStatuses, candidateAgent)`:
- **error** `status_absent` — any of trigger/running/success/failure names ∉ board.
- **error** `duplicate_trigger` — `trigger_status` equals another **enabled** agent's,
  with equal-or-absent `trigger_jql`.
- **warning** `status_cycle` — A.success → B.trigger and B.success → A.trigger.

Error shape (path-qualified, attachable to a form field) is specified in
`contracts/dashboard-api.md`.
