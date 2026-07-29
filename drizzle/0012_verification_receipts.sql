-- feature 033: ticket-level verification receipt (token-spend problem 2).
-- Nullable jsonb, no backfill: NULL means "no receipt yet"; the column is
-- whole-replaced on each evidence-carrying callback completion and never
-- cleared (sha mismatch self-invalidates). Shape: VerificationReceiptSchema
-- (packages/contracts/src/verification-receipt.schema.ts), architecture.md §3.
ALTER TABLE "tickets" ADD COLUMN "verification" jsonb;
