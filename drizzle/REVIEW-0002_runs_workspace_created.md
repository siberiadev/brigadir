# Migration Review — `0002_runs_workspace_created.sql` vs `docs/architecture.md` §3

**Discipline**: same as `REVIEW-0000_init.md` / `REVIEW-0001_jira_board.md` — the
committed SQL is reviewed line-by-line against the architecture §3 schema before
it is considered done (Constitution governance / CLAUDE.md rule 5).

**Reviewed**: 2026-07-12 · **Migration**: `drizzle/0002_runs_workspace_created.sql` ·
**Task**: T031 (feature 006-runs-human-queue)

## Generated SQL

```sql
CREATE INDEX "runs_workspace_created" ON "runs" USING btree ("workspace_id","created_at" DESC NULLS LAST);
```

## Verdict: ✅ ADDITIVE INDEX ONLY — no §3 table/column change

| Item | Assessment |
|---|---|
| Kind | `CREATE INDEX` — **non-structural** (an index, not a column/constraint). |
| Table `runs` columns | Unchanged (no `ALTER TABLE`). architecture §3's `runs` definition stands as-is. |
| Columns indexed | `(workspace_id, created_at DESC)` — both pre-existing columns. |
| New tables / columns | None. |

## Rationale (data-model.md, additive item 1)

The runs-table read (feature 006 US3) is **workspace-scoped**, ordered
`created_at desc`, paginated, and filtered by agent/status + a ticket-key
substring join. The existing indexes are `runs_one_active` (partial, active
statuses only) and `runs_ticket` `(ticket_id, created_at desc)` — neither serves
a `workspace_id`-scoped, time-ordered scan. The workspace cost period-sum reuses
the same index over the `created_at` window.

## Notes (non-deviations)

- **`DESC NULLS LAST`**: `created_at` is `NOT NULL DEFAULT now()`, so `NULLS LAST`
  never changes results; it is drizzle-kit's canonical rendering of `.desc()`.
- Architecture §3 documents no index list for `runs` beyond the invariants
  captured in the Drizzle schema; the spec Assumptions explicitly permit a
  supporting index for a read query as an implementation detail. No §3 text
  changes.
- `0000_init.sql` / `0001_jira_board.sql` are unmodified; only
  `0002_runs_workspace_created.sql`, `meta/0002_snapshot.json`, and
  `meta/_journal.json` were added/updated.
```
