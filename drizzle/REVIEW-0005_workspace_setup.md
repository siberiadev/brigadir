# Migration Review — `0005_workspace_setup.sql` vs `docs/architecture.md` §3

**Discipline**: same as `REVIEW-0000` … `REVIEW-0004` — the committed SQL is
reviewed line-by-line against the architecture §3 schema before it is considered
done (Constitution governance / CLAUDE.md rule 5).

**Reviewed**: 2026-07-16 · **Migration**: `drizzle/0005_workspace_setup.sql` ·
**Change**: workspace setup by the orchestrator (feature 011) — ticketless
workspace-setup runs and their human tasks; `runs.ticket_id` and
`human_tasks.ticket_id` become nullable, with a companion partial unique index
guarding "one active ticketless run per workspace".

## Generated SQL

```sql
ALTER TABLE "runs" ALTER COLUMN "ticket_id" DROP NOT NULL;
ALTER TABLE "human_tasks" ALTER COLUMN "ticket_id" DROP NOT NULL;
CREATE UNIQUE INDEX "runs_one_active_setup" ON "runs" USING btree ("workspace_id")
  WHERE status IN ('queued', 'running', 'awaiting_human') AND ticket_id IS NULL;
```

Fully drizzle-kit generated from the schema deltas in
`libs/database/src/schema/runs.ts` and `libs/database/src/schema/human-tasks.ts`
(no hand edits); `meta/0005_snapshot.json` + `_journal.json` produced by the same
`drizzle-kit generate` run.

## Review notes

- **`runs.ticket_id` DROP NOT NULL** — FK to `tickets(id)` retained (now
  nullable). Matches §3 as amended by feature 011 (spec FR-005, plan D2):
  every read path left-joins tickets; ticketed rows are unaffected byte-for-byte.
- **`human_tasks.ticket_id` DROP NOT NULL** — FK retained. Backs ticketless
  review/failure/question tasks produced by setup runs.
- **`runs_one_active_setup`** — partial UNIQUE on `(workspace_id)` where the run
  is active AND ticketless. Required because unique-index NULLs are distinct in
  Postgres, so the existing `runs_one_active (ticket_id, agent_id)` guard cannot
  cover NULL-ticket rows (plan D3). Predicate's status set is identical to
  `runs_one_active` — the two indexes partition the active-run space by
  `ticket_id IS NULL`.
- **No backfill** — historical rows keep their tickets (spec assumption);
  the migration is metadata-only and instant on our data sizes.
- **Idempotency contract** — `RunTriggerService.trigger` treats `23505` from
  either index identically (`{deduplicated:true}`), preserving Constitution II.

## Verdict: ✅ MATCHES §3 (as amended by feature 011 in the same change)
