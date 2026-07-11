# Migration Review — `0001_jira_board.sql` vs `docs/architecture.md` §3

**Discipline**: same as iteration 1's `REVIEW-0000_init.md` / task T014 — the
committed SQL is reviewed line-by-line against the architecture §3 schema
before it is considered done (Constitution governance / CLAUDE.md rule 5).

**Reviewed**: 2026-07-11 · **Migration**: `drizzle/0001_jira_board.sql` ·
**Task**: T038 (feature 002-jira-core)

## Generated SQL

```sql
ALTER TABLE "workspaces" ADD COLUMN "jira_board_id" integer;
ALTER TABLE "workspaces" ADD COLUMN "jira_board_type" text;
```

## §3 reference (docs/architecture.md, `CREATE TABLE workspaces`)

```
jira_board_id   int,                         -- миграция итерации 2: привязка к борде
jira_board_type text,                        -- kanban | scrum (определяется через Agile API при подключении)
```

## Verdict: ✅ MATCHES §3

| Item | §3 | Migration | Match |
|---|---|---|---|
| `jira_board_id` type | `int` | `integer` | ✅ (Postgres `int` = `integer`) |
| `jira_board_id` nullability | nullable (no `NOT NULL`) | nullable | ✅ |
| `jira_board_type` type | `text` | `text` | ✅ |
| `jira_board_type` nullability | nullable | nullable | ✅ |
| Other columns | unchanged | untouched | ✅ (only two `ADD COLUMN`) |

## Notes (non-deviations)

- **Column position**: §3 lists the two columns between `jira_project_key` and
  `jira_auth_type`; `ALTER TABLE ADD COLUMN` appends them at the physical end of
  `workspaces`. Column ordering is not semantically meaningful in Postgres and
  §3's ordering is a documentation convenience — no functional difference. The
  Drizzle schema (`libs/database/src/schema/workspaces.ts`) lists them in the
  §3 position for readability.
- **Nullable on purpose**: both columns are nullable so `0001` applies cleanly
  to the pre-existing `workspaces` row; the seeder sets `jira_board_id` and the
  connect-time introspection (T049) sets `jira_board_type`. This matches §3,
  where neither column is `NOT NULL`.
- **`scope_jql` / `branch_prefix` / `repositories[]` / `active_sprint_id` /
  high-water mark**: per §3 these live in `settings jsonb`, **not** as columns —
  so they are intentionally absent from this migration (data-model.md).
- `drizzle/0000_init.sql` is unmodified; only `0001_jira_board.sql`,
  `meta/0001_snapshot.json`, and `meta/_journal.json` were added/updated.
