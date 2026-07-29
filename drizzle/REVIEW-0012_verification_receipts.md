# Migration Review — `0012_verification_receipts.sql` vs `docs/architecture.md` §3

**Discipline**: same as `REVIEW-0000` … `REVIEW-0011` — the committed SQL is
reviewed line-by-line against the architecture §3 schema before it is considered
done (Constitution governance / CLAUDE.md rule 5).

**Reviewed**: 2026-07-29 · **Migration**: `drizzle/0012_verification_receipts.sql` ·
**Change**: one nullable jsonb column on `tickets` — feature 033 (ticket-level
verification receipts, token-spend problem 2).

## Line-by-line vs §3

| SQL | §3 line | Verdict |
|---|---|---|
| `ADD COLUMN "verification" jsonb` | `verification jsonb` — sha-якорная квитанция (VerificationReceiptSchema); whole-replace на callback-complete, не очищается; NULL = квитанции нет | ✓ match (nullable by default — §3 has no NOT NULL) |

## Notes

- Pure additive DDL (schema delta in `libs/database/src/schema/tickets.ts`);
  `meta/0012_snapshot.json` + `_journal.json` entry authored in the same
  commit. No backfill: NULL is the correct initial value for every existing
  row ("no receipt recorded yet"), same self-healing pattern as `blocked_by`.
- Shape is enforced in code, not DDL (`VerificationReceiptSchema`,
  `packages/contracts/src/verification-receipt.schema.ts`) — house style, like
  `runs.status` / `blocked_state` enums. Readers always `safeParse`; corrupt
  or legacy values degrade to "no receipt", never crash prepare.
- The column is observation semantics: written only from a measured
  `x-brigadir-observed-heads` completion (evidence-based); exit-time/outbox
  finalization paths carry no evidence and never write it.
- No index: the receipt is read by ticket PK during run prepare (same access
  path as `blocked_by`).
- No dedicated migration replay spec: trivial additive nullable column,
  precedent `0008_sprint_sequencing` (contrast `0011`, which mutated data).
