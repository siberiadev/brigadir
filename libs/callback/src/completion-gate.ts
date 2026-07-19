import { z } from 'zod';
import type { NormalizedRepoArtifact } from '@brigadir/contracts';

/**
 * Completion gate for unreported work (feature 024, US3;
 * contracts/completion-gate.md). Pure decision logic + a lenient header
 * parser — no HTTP, no DB. The CallbackService supplies the start-ref
 * baseline and the normalized report artifacts; this module decides whether a
 * completion may proceed.
 *
 * The 023 design left the handoff resting on the agent reporting honestly. If
 * an agent pushes commits but names no branch, the next stage silently starts
 * from the default branch and can "succeed" on an empty diff — the exact
 * false-success mode 023's loud-crash rule exists to prevent, arriving through
 * the front door. This gate makes the check deterministic: a completion that
 * omits a repository whose worktree HEAD has moved past its recorded start
 * commit is rejected before the run finalizes.
 */

const SHA = /^[0-9a-f]{40}$/;
const MAX_REPOS = 20; // mirrors ReportArtifactsSchema.repos.max(20)

const ObservedHeadsSchema = z
  .record(z.string().min(1).max(200), z.string().regex(SHA))
  .refine((m) => Object.keys(m).length <= MAX_REPOS);

/**
 * Parse the `x-brigadir-observed-heads` header value. Invalid or absent ⇒
 * null (evidence-absent — the gate then never rejects). Never throws.
 */
export function parseObservedHeads(header: string | undefined | null): Record<string, string> | null {
  if (!header) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(header);
  } catch {
    return null;
  }
  const result = ObservedHeadsSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

export interface HandoffViolation {
  repo: string;
  startSha: string;
  observedHead: string;
}

/**
 * The repos whose completion must be rejected: HEAD moved past the recorded
 * start commit AND the report names no branch for them.
 *
 * Evidence-absent cases never yield a violation — a repo missing from
 * `observed`, an unmoved HEAD, or an empty `startRefs`/null `observed`.
 * Attribution follows feature 023 D5: a v2 entry matches by exact repo name;
 * a legacy flat (v1) report — which carries no repo name — is attributed to
 * the single mounted repo only when exactly one repo is mounted (with several,
 * the flat form cannot vouch for any specific one).
 */
export function detectHandoffViolations(
  startRefs: Map<string, string>,
  observed: Record<string, string> | null,
  artifacts: NormalizedRepoArtifact[],
  mountedCount: number,
): HandoffViolation[] {
  if (!observed) return [];
  const flatAttributed =
    mountedCount === 1 && artifacts.length > 0 && artifacts[0].repo === undefined;

  const violations: HandoffViolation[] = [];
  for (const [repo, startSha] of startRefs) {
    const observedHead = observed[repo];
    if (observedHead === undefined) continue; // no evidence for this repo
    if (observedHead === startSha) continue; // HEAD did not move
    const reported = flatAttributed || artifacts.some((a) => a.repo === repo);
    if (!reported) violations.push({ repo, startSha, observedHead });
  }
  return violations;
}
