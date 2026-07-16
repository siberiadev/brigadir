# Migration Review — `0006_human_task_options.sql` vs `docs/architecture.md` §3

**Discipline**: same as `REVIEW-0000` … `REVIEW-0005` — the committed SQL is
reviewed line-by-line against the architecture §3 schema before it is considered
done (Constitution governance / CLAUDE.md rule 5).

**Reviewed**: 2026-07-16 · **Migration**: `drizzle/0006_human_task_options.sql` ·
**Change**: suggested answer options on human tasks (feature 013) — a single
nullable jsonb column on `human_tasks`.

## Generated SQL

```sql
ALTER TABLE "human_tasks" ADD COLUMN "options" jsonb;
```

Fully drizzle-kit generated from the schema delta in
`libs/database/src/schema/human-tasks.ts` (no hand edits);
`meta/0006_snapshot.json` + `_journal.json` produced by the same
`drizzle-kit generate` run.

## Review notes

- **`human_tasks.options jsonb`, nullable, no default** — matches §3 as amended
  by feature 013 in the same change. NULL is the single no-options
  representation: all pre-existing rows, all system-composed tasks (PR review,
  triage-limit, orchestrator failure, team review), and any ask without options
  (spec FR-003/FR-005; research D3/D4).
- **No CHECK constraint / no DB-side JSON validation** — deliberate: the shape
  (`AnswerOption[]`, 1–5 items, bounded fields) is enforced by
  `AnswerOptionsSchema` (zod) at BOTH intake surfaces before either writer
  (`HumanTaskService.createFromRequest`, `RunsService.createHumanTask`)
  persists, matching the repo's jsonb precedent (`runs.report`,
  `agents.behavior`). A SQL CHECK would duplicate the zod contract and drift
  (research D4).
- **No index** — options are only ever read alongside their row (queue list
  select), never filtered on.
- **No backfill** — additive nullable column; metadata-only and instant on our
  data sizes. Existing reads are unaffected byte-for-byte.
- **Scrubbing** — the column only ever receives scrubber-passed text
  (Constitution V): both writers receive options already scrubbed in
  `callback.service.ts`, same guarantee as `title`/`details`.

## Verdict: ✅ MATCHES §3 (as amended by feature 013 in the same change)
