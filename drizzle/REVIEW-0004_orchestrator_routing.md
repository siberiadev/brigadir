# Migration Review — `0004_orchestrator_routing.sql` vs `docs/architecture.md` §3

**Discipline**: same as `REVIEW-0000` … `REVIEW-0003` — the committed SQL is
reviewed line-by-line against the architecture §3 schema before it is considered
done (Constitution governance / CLAUDE.md rule 5).

**Reviewed**: 2026-07-15 · **Migration**: `drizzle/0004_orchestrator_routing.sql` ·
**Change**: orchestrator-based blocked-ticket routing (feature 010) — `agents`
gains a roster `description` and an `is_orchestrator` marker; a new platform-global
`global_settings` key-value table backs the General-settings section.

## Generated SQL

```sql
CREATE TABLE "global_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "agents" ADD COLUMN "description" text;
ALTER TABLE "agents" ADD COLUMN "is_orchestrator" boolean DEFAULT false NOT NULL;
```

Fully drizzle-kit generated from the schema deltas in
`libs/database/src/schema/agents.ts` and `libs/database/src/schema/global-settings.ts`
(no hand edits); `meta/0004_snapshot.json` + `_journal.json` produced by the same
`drizzle-kit generate` run.

## Verdict: ✅ MATCHES §3

| Item | Assessment |
|---|---|
| `agents.description` | New `text` column, **nullable**, no default — a roster line the orchestrator sees in the handoff (FR-020). Existing rows read `NULL`; no backfill needed. |
| `agents.is_orchestrator` | New `boolean NOT NULL DEFAULT false` — marks the per-workspace "brigadir" row (FR-018/019). Default `false` means every existing agent is correctly a worker; the orchestrator row is created `true` by the seeding/backfill service (D10), never by this migration. Explicit column (not a `behavior` JSON flag) so it is queryable in the roster filter, the delete guard, and the completion branch (D2). |
| `agents` other columns / `agents_workspace_name` UNIQUE | Untouched. `UNIQUE(workspace_id, name)` already guarantees one `brigadir` per workspace — no new constraint required (data-model §1.1). |
| `global_settings` table | New platform-global k/v store: `key text PRIMARY KEY`, `value jsonb NOT NULL`, `updated_at timestamptz NOT NULL DEFAULT now()`. No workspace FK — it is platform config, not workspace-owned (D9). First key `default_orchestrator_instruction` (a JSON string). Forward-extensible for the growing "General" section. |
| `is_orchestrator` backfill | None in SQL — orchestrator rows (and their default instruction) are created by the seeding/backfill service, which needs to compute the `global_settings` fallback dynamically (D10). A migration cannot do per-workspace business seeding. |
| `rework_max` | No DDL — lives in `workspaces.settings` JSONB via a typed accessor (data-model §1.3). |
| Data loss | None — two additive columns (one nullable, one defaulted) and one new table. No drops, no rewrites. |
| Other tables | Untouched. `0000`–`0003` files unmodified; only `0004_orchestrator_routing.sql`, `meta/0004_snapshot.json`, and `meta/_journal.json` added/updated. |

## Notes (non-deviations)

- The orchestrator's `status_success`/`status_failure` remain `NOT NULL` (unchanged
  schema); the seeder stores inert placeholder statuses to satisfy the constraint
  (FR-007) — a data concern, not a schema change.
- The delete guard for orchestrator rows is enforced in the API
  (`agents.controller.ts` → 409), **not** a DB constraint, so instruction/enabled/
  timeout edits stay possible (FR-019, data-model §1.1).
