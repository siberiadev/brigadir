# Contract — Executors API & typed config (US4)

Guarded by `DashboardTokenGuard`. Shared error envelope. `snake_case` bodies. Types in
`packages/contracts/src/executor.schema.ts` (new) — the **discriminated-union config schema**
is the single typed source consumed by the backend authority AND the Vue config form
(mirrors feature 005's shared linter). `secrets` are **never** serialized in any response.

Executors are workspace-scoped: `/api/workspaces/:id/executors`.

---

## Typed config (discriminated on `type`)

```ts
// mock
{ type: "mock", concurrency_limit: number }                       // concurrency only

// claude_cli
{ type: "claude_cli",
  model: string,
  cli_path: string,
  repository: string,          // MUST be one of the workspace's settings.repositories[].name
  use_callback_channel: boolean,
  keep_failed_worktrees: boolean,
  max_turns: number,
  concurrency_limit: number }
```
Server validation rejects fields foreign to the type (a `mock` may not carry `max_turns`) and
rejects a `claude_cli.repository` that is not among the workspace's repositories.
**Persistence mapping (no schema change)**: `concurrency_limit` → `executors.concurrency_limit`
(column); every other typed field → `executors.config` (jsonb). `name` and `type` are columns.

---

## GET `/api/workspaces/:id/executors` (FR-020, feeds FR-023)

**200** →
```jsonc
{
  "items": [
    { "id": "uuid", "type": "claude_cli", "name": "claude", "enabled": true,
      "concurrency_limit": 2,
      "config": { "model": "claude-opus-4-8", "cli_path": "claude", "repository": "api",
                  "use_callback_channel": true, "keep_failed_worktrees": false, "max_turns": 40 } },
    { "id": "uuid", "type": "mock", "name": "mock", "enabled": true, "concurrency_limit": 2, "config": {} }
  ]
}
```
The agent form's picker consumes this: shows `name` + a `type` badge, never a raw UUID, never
empty (seeding guarantees ≥1 of each), defaults to the workspace's `claude_cli` executor
(FR-023).

## POST `/api/workspaces/:id/executors` (FR-020)
Body: the typed config union + `name` + optional `secrets` (encrypted at rest, never returned).
- **201** → the created executor (same shape as a list item).
- **409** `{ error: { code: "executor_name_taken" } }` — `executors_workspace_name` unique.
- **422** — config fails the type's schema (foreign field, unknown repository, …).

## PUT `/api/workspaces/:id/executors/:executorId` (FR-020, FR-025)
Full update of `name`/`config`/`concurrency_limit`/`enabled`. Changing `concurrency_limit`
re-applies to the live worker within ~15 s **without a restart** (research R4; the worker's
periodic re-apply sums all rows of the type). **200** → updated executor.

## DELETE `/api/workspaces/:id/executors/:executorId` (FR-024, SC-009)
- **204** when unreferenced.
- **409** `{ error: { code: "executor_in_use", message: "Executor \"claude\" is used by agents: reviewer, migrator" } }`
  when one or more agents reference it — a pre-delete `count` of referencing agents. No
  orphaned agent references result.

---

## Default seeding on workspace create (FR-022, SC-006)

Inside the existing `WorkspacesController.create` path (feature 005), after the workspace row
is inserted, seed **exactly**:
- one `claude_cli` executor named `"claude"` — defaults: sensible `model`, `cli_path`
  (`claude`), `use_callback_channel: true`, `keep_failed_worktrees: false`, `max_turns`,
  `concurrency_limit`; `repository` = the workspace's default repository name when one exists
  (else empty, filled in later via the config form).
- one `mock` executor named `"mock"` — `concurrency_limit` default.

Seeding is insert-if-absent (the `executors_workspace_name` unique index makes a re-run safe).
This closes "a fresh workspace can create an agent immediately" (SC-006) — the picker is never
empty.

**Backfill (checkpoint addition)**: the seeding also runs once for **all existing workspaces**
at backend bootstrap (`OnApplicationBootstrap`), so a workspace created before this feature
with zero executors is seeded too — FR-023's "never present an empty list" holds for every
workspace, not only post-006 ones. Backfill is **type-scoped**, not name-scoped: a default
executor of a type is inserted only when the workspace has no executor of that type at all
(a live workspace with custom-named executors, e.g. `claude-cli`/`mock-exec`, gains nothing —
no duplicate defaults, no inflated per-type concurrency sum). Existing rows are never
modified.

---

## Live concurrency re-apply (FR-025, SC-008) — worker side

Not an HTTP surface: the worker re-reads `sum(executors.concurrency_limit)` per type on a
~15 s interval and sets `worker.concurrency` for that type's live BullMQ `Worker`
(research R4, reusing `applyExecutorConcurrency`). Where multiple executors of one type exist,
the applied concurrency is their **sum** (spec Edge Case "Concurrency re-apply"). A restart is
never required to pick up a limit change.
