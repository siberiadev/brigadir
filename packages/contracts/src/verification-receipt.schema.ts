import { z } from 'zod';
import type { AgentReport } from './report.schema';

/**
 * Ticket-level verification receipt (feature 033, token-spend problem 2).
 *
 * Written by the callback complete path into `tickets.verification` when a run
 * finalizes with measured worktree heads; injected by the executor into the
 * NEXT run's wrapper so it does not re-run gates already verified at the exact
 * same workspace state. Semantics:
 *
 * - Whole-workspace: `repos` records the head of EVERY mounted repository at
 *   completion (the observed-heads header covers untouched repos too), because
 *   report checks are run-level — per-repo attribution would fabricate
 *   precision the report does not carry.
 * - Whole-replace, never cleared: each new receipt captures the complete
 *   current state; a stale receipt self-invalidates by sha mismatch.
 * - Advisory: consumers word it as "reported passing"; the agent may
 *   re-verify with a stated reason.
 */

const SHA = /^[0-9a-f]{40}$/;
/** Mirrors ReportArtifactsSchema.repos.max(20) / the observed-heads cap. */
const MAX_REPOS = 20;

export const VERIFICATION_RECEIPT_MAX_GATES = 10;
export const VERIFICATION_RECEIPT_MAX_GATE_NAME = 120;

export const VerificationReceiptSchema = z
  .object({
    version: z.literal(1),
    /** Run whose completion produced this receipt. */
    runId: z.string().min(1).max(64),
    /** agents.role of that run's agent; null when the agent has no role. */
    agentRole: z.string().max(200).nullable(),
    agentName: z.string().max(200).nullable(),
    outcome: z.string().min(1).max(50),
    recordedAt: z.string().min(1).max(64),
    gates: z
      .array(z.string().min(1).max(VERIFICATION_RECEIPT_MAX_GATE_NAME))
      .min(1)
      .max(VERIFICATION_RECEIPT_MAX_GATES),
    repos: z
      .record(z.string().min(1).max(200), z.string().regex(SHA))
      .refine((m) => {
        const n = Object.keys(m).length;
        return n >= 1 && n <= MAX_REPOS;
      }),
  })
  .strict();

export type VerificationReceipt = z.infer<typeof VerificationReceiptSchema>;

export interface VerificationReceiptRunMeta {
  runId: string;
  agentRole: string | null;
  agentName: string | null;
  /** ISO timestamp supplied by the caller (the schema does not read clocks). */
  recordedAt: string;
}

function truncateGateName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length <= VERIFICATION_RECEIPT_MAX_GATE_NAME) return trimmed;
  return `${trimmed.slice(0, VERIFICATION_RECEIPT_MAX_GATE_NAME - 1)}…`;
}

/**
 * Build a receipt from an (already scrubbed) report and the measured observed
 * heads. Returns undefined when there is nothing worth recording: no measured
 * heads, or no passing checks. Only `status='pass'` checks become gates,
 * name-deduped and capped — a prompt is a budget (feature-026 discipline).
 * The result is re-validated through the schema; any inconsistency (e.g. a
 * malformed sha) degrades to undefined rather than persisting garbage.
 */
export function buildVerificationReceipt(
  report: Pick<AgentReport, 'outcome' | 'checks'>,
  observedHeads: Record<string, string> | null,
  meta: VerificationReceiptRunMeta,
): VerificationReceipt | undefined {
  if (!observedHeads || Object.keys(observedHeads).length === 0) return undefined;

  const gates: string[] = [];
  const seen = new Set<string>();
  for (const check of report.checks) {
    if (check.status !== 'pass') continue;
    const name = truncateGateName(check.name);
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    gates.push(name);
    if (gates.length >= VERIFICATION_RECEIPT_MAX_GATES) break;
  }
  if (gates.length === 0) return undefined;

  const candidate = {
    version: 1 as const,
    runId: meta.runId,
    agentRole: meta.agentRole,
    agentName: meta.agentName,
    outcome: report.outcome,
    recordedAt: meta.recordedAt,
    gates,
    repos: observedHeads,
  };
  const parsed = VerificationReceiptSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Decide whether a stored receipt applies to a freshly prepared workspace.
 * Whole-workspace match: the receipt's repo set must EQUAL the mounted set and
 * every sha must match the prepared worktree's start sha. Any mismatch,
 * missing repo, or extra repo ⇒ undefined (the receipt vouches for a complete
 * workspace state, never a subset). Garbage jsonb safeParses to undefined —
 * prepare never crashes on a legacy or corrupt value.
 */
export function matchVerificationReceipt(
  raw: unknown,
  startShas: Record<string, string>,
): VerificationReceipt | undefined {
  if (raw === null || raw === undefined) return undefined;
  const parsed = VerificationReceiptSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const receipt = parsed.data;

  const mounted = Object.keys(startShas);
  if (mounted.length === 0) return undefined;
  if (Object.keys(receipt.repos).length !== mounted.length) return undefined;
  for (const repo of mounted) {
    if (receipt.repos[repo] !== startShas[repo]) return undefined;
  }
  return receipt;
}
