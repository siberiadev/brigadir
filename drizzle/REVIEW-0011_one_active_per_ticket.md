# Migration Review — `0011_one_active_per_ticket.sql` vs `docs/architecture.md` §3

**Discipline**: same as `REVIEW-0000` … `REVIEW-0009` — the committed SQL is
reviewed line-by-line against the architecture §3 schema before it is considered
done (Constitution governance / CLAUDE.md rule 5).

**Reviewed**: 2026-07-28 · **Migration**: `drizzle/0011_one_active_per_ticket.sql` ·
**Change**: `runs_one_active` tightened from `(ticket_id, agent_id)` to
`(ticket_id)` — one active run per TICKET (SXF-1174 Problem 6).

## Line-by-line vs §3

| SQL | §3 line | Verdict |
|---|---|---|
| `UPDATE runs SET status='cancelled', finished_at=now() WHERE id IN (… rn > 1)` | — (data repair, not schema) | ✓ required: live data may hold cross-agent duplicate actives (the SXF-1174 incident state); `CREATE UNIQUE INDEX` would fail without it |
| `DROP INDEX "runs_one_active"` | replaces the old `(ticket_id, agent_id)` block | ✓ |
| `CREATE UNIQUE INDEX "runs_one_active" ON "runs" ("ticket_id") WHERE status IN ('queued','running','awaiting_human')` | `CREATE UNIQUE INDEX runs_one_active ON runs (ticket_id) WHERE status IN ('queued','running','awaiting_human')` | ✓ match |

## Notes

- Demotion keep-preference: `awaiting_human` first (demoting it would strand its
  open blocking human task — `ResumeService.resolve`'s supersede guard would
  return `not_open`), else the oldest (`created_at ASC, id ASC` — deterministic).
  Demoting `queued`/`running` runs equals dashboard-cancel semantics the worker
  already honors (cancel-poll kills running; `markRunning` drops cancelled
  queued jobs at pickup).
- Strict TIGHTENING of Constitution II layer 3 — no dedup layer removed or
  weakened; the BullMQ level-2 id stays `${ticketId}:${agentId}` (narrower is
  safe; widening would resurrect the retained-job swallow hazard).
- `runs_one_active_setup` (ticketless workspace-setup guard) untouched.
- Covered by `test/integration/migration-0011.spec.ts`: replays the committed
  SQL against a reconstructed pre-0011 index with seeded duplicates and asserts
  the demotion choice + the new uniqueness.
