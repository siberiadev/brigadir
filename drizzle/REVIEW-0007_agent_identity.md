# Migration Review — `0007_agent_identity.sql` vs `docs/architecture.md` §3

**Discipline**: same as `REVIEW-0000` … `REVIEW-0006` — the committed SQL is
reviewed line-by-line against the architecture §3 schema before it is considered
done (Constitution governance / CLAUDE.md rule 5).

**Reviewed**: 2026-07-16 · **Migration**: `drizzle/0007_agent_identity.sql` ·
**Change**: separate an agent's identity (`id`) from its handle (`key`) and its
presentation (`name` + new `role`) — feature 014. Adds `role` (nullable) and
`key` (NOT NULL, workspace-unique), drops `UNIQUE(workspace_id, name)`.

## Structure vs backfill

The DDL (drop constraint, add columns, add unique constraint) was produced by
`drizzle-kit generate` from the schema delta in
`libs/database/src/schema/agents.ts`; `meta/0007_snapshot.json` + `_journal.json`
came from the same run. The generated `ADD COLUMN "key" text NOT NULL` was
hand-split into `ADD COLUMN "key" text` → backfill → `ALTER COLUMN "key" SET NOT
NULL` so the NOT NULL lands only after every existing row has a value (a NOT
NULL add on a populated table is otherwise impossible). The backfill `DO` block
is the only hand-written portion.

## Review notes

- **`agents.role text`, nullable, no default** — matches §3 as amended in this
  change. Workers backfill to NULL (their pre-feature names encode a function,
  but parsing it in SQL is guesswork — role is editable later); the orchestrator
  backfills to `'teamlead'`. Nothing in the system requires a non-null role
  (spec assumptions; research D3).
- **`agents.key text NOT NULL`** — matches §3. Generated once at creation and
  immutable thereafter; the DB constraint below is the final uniqueness guard.
- **`UNIQUE (workspace_id, key)` replaces `UNIQUE (workspace_id, name)`** — the
  identity constraint moves from name to key (spec FR-002). `name` may now
  repeat within a workspace; `id` remains the PK and the only internal reference.
- **Orchestrator backfill** (`WHERE is_orchestrator = true`) — `role='teamlead'`,
  `key='brigadir'`. Keyed on the flag, NOT the name, so an operator-renamed
  orchestrator persona still backfills correctly (data-model.md orchestrator row;
  research D1).
- **Worker backfill slug** — `nullif(trim(both '-' from regexp_replace(lower(name),
  '[^a-z0-9]+', '-', 'g')), '')` reproduces `slugifyAgentKey` exactly: lowercase,
  every non-`[a-z0-9]` run → `-`, trim edges; empty (e.g. a non-Latin name) →
  fallback `'agent'`. Role is NULL at backfill, so the name-only slug is used —
  identical to `slugifyAgentKey(name, null)`.
- **Collision resolution** — the `DO` block walks each workspace's workers in
  `id` order, keeping a `taken` array seeded with the reserved `'brigadir'`, and
  assigns the smallest free `base`, `base-2`, `base-3`, … This is a faithful,
  deterministic port of `ensureUniqueAgentKey` (reserved-key-aware). Parity with
  the TS functions on the same inputs is asserted by an integration test (T018),
  so the unavoidable one-time duplication of the rule is a *checked* equivalence.
- **Determinism** — `ORDER BY id` throughout; no `random()`/`now()`; re-running on
  the same data yields identical keys (spec US4; research D3).
- **No data loss / reference breakage** — additive columns + a constraint swap;
  `runs.agent_id`, `human_tasks.target_agent_id`, `run_events`, and the
  idempotency index (`runs_one_active` on `(ticket_id, agent_id)`) all reference
  `id` and are untouched (data-model.md invariants; spec FR-020).
- **Idempotency of the migration** — applied once via the drizzle journal
  (`__drizzle_migrations`); the `DO` block is not written to be re-runnable on
  its own (it is not meant to be), matching the repo's one-shot migration model.
