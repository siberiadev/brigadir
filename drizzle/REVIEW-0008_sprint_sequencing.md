# Migration Review — `0008_sprint_sequencing.sql` vs `docs/architecture.md` §3

**Discipline**: same as `REVIEW-0000` … `REVIEW-0007` — the committed SQL is
reviewed line-by-line against the architecture §3 schema before it is considered
done (Constitution governance / CLAUDE.md rule 5).

**Reviewed**: 2026-07-18 · **Migration**: `drizzle/0008_sprint_sequencing.sql` ·
**Change**: four nullable diff-cache columns on `tickets` — feature 022
(sprint-sequencing): `priority_id int`, `priority_name text`, `blocked_by
jsonb`, `blocked_state text`.

## Line-by-line vs §3

| SQL | §3 line | Verdict |
|---|---|---|
| `ADD COLUMN "priority_id" integer` | `priority_id int` — кэш Jira priority.id; ASC = важнее; NULL = без приоритета | ✓ match (nullable by default — §3 has no NOT NULL) |
| `ADD COLUMN "priority_name" text` | `priority_name text` — кэш имени приоритета для дашборда | ✓ match |
| `ADD COLUMN "blocked_by" jsonb` | `blocked_by jsonb` — кэш открытых blocked-by ключей; NULL = не ждёт | ✓ match |
| `ADD COLUMN "blocked_state" text` | `blocked_state text` — waiting \| cycle \| dead_end \| out_of_scope; NULL = не ждёт | ✓ match (enum enforced in code like `runs.status`, per house style) |

## Notes

- Pure additive DDL from `drizzle-kit generate` (schema delta in
  `libs/database/src/schema/tickets.ts`); `meta/0008_snapshot.json` +
  `_journal.json` from the same run. No backfill: NULL is the correct initial
  value for every existing row ("not observed / not waiting").
- All four columns are diff-cache semantics (like `last_seen_status`): written
  only from observed Jira data, never authoritative (Constitution Principle I).
  §3 comment says so explicitly.
- No index added: the waiting set is filtered by `workspace_id` (covered by the
  existing unique `(workspace_id, jira_key)` btree prefix) and expected < 50
  rows per workspace; the fast-path `blocked_by @> ?` containment scan is
  bounded by the same workspace filter.
