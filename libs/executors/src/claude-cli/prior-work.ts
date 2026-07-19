import { and, desc, eq, ne } from 'drizzle-orm';
import { type BrigadirDb, schema } from '@brigadir/database';
import {
  normalizeReportArtifacts,
  type AgentReport,
  type NormalizedRepoArtifact,
} from '@brigadir/contracts';
import type { WorktreeRepo } from './worktree';

/**
 * Where the next pipeline stage starts (feature 023).
 *
 * The run branch used to be derived from a naming convention
 * (`<branchPrefix>/<ticketKey>`) and guarded against collisions — which made
 * every stage AFTER a committing stage crash, because reuse was granted only
 * to `rework`/`human-resume` triggers while a normal stage handoff arrives
 * from the Jira poller. The handoff is now explicit: a stage starts from the
 * branch the previous run REPORTED for that repository.
 */

/** How many recent runs to scan for artifacts before giving up. */
const SCAN_WINDOW = 5;

export interface PriorWork {
  /** The run whose report supplied the branches. */
  runId: string;
  /** Normalized artifact entries that actually carry a branch. */
  entries: NormalizedRepoArtifact[];
}

function branchEntries(report: unknown): NormalizedRepoArtifact[] {
  if (!report) return [];
  // normalizeReportArtifacts is the ONE precedence implementation (v2 repos[]
  // wins over the flat v1 form) — never re-derive it here.
  return normalizeReportArtifacts(report as AgentReport).filter(
    (a) => a.branch !== undefined && a.branch.length > 0,
  );
}

/**
 * The prior work this run should continue, if any.
 *
 * Precedence:
 *  1. `preferRunId` — the run a rework / human-resume / triage handoff names.
 *     Loaded WITHOUT a status filter: a `needs_human` or `failed` attempt that
 *     committed and reported a branch is a legitimate continuation point.
 *  2. The latest `succeeded` run on the ticket. A window rather than `limit(1)`
 *     because a successful stage that changed nothing (a reviewer that only
 *     read) reports no artifacts and must not blank the chain — same reasoning
 *     and same constant as `latestArtifacts` in feature-context.ts.
 *  3. Nothing — every repo starts from its default branch.
 *
 * Falling THROUGH from 1 to 2 matters: a run that died before reporting (the
 * ST3-780 reviewer) names no branch, and its rework still belongs on the
 * developer's branch rather than back on the default one.
 *
 * `ticketId` is already workspace-unique via the tickets FK, so no workspace
 * filter is needed; the query is served by the `runs_ticket` index.
 */
export async function getPriorWork(
  db: BrigadirDb,
  opts: { ticketId: string; currentRunId: string; preferRunId?: string },
): Promise<PriorWork | undefined> {
  if (opts.preferRunId !== undefined && opts.preferRunId !== opts.currentRunId) {
    const [row] = await db
      .select({ id: schema.runs.id, report: schema.runs.report })
      .from(schema.runs)
      .where(eq(schema.runs.id, opts.preferRunId))
      .limit(1);
    if (row) {
      const entries = branchEntries(row.report);
      if (entries.length > 0) return { runId: row.id, entries };
    }
  }

  const rows = await db
    .select({ id: schema.runs.id, report: schema.runs.report })
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.ticketId, opts.ticketId),
        eq(schema.runs.status, 'succeeded'),
        ne(schema.runs.id, opts.currentRunId),
      ),
    )
    .orderBy(desc(schema.runs.createdAt))
    .limit(SCAN_WINDOW);

  for (const row of rows) {
    const entries = branchEntries(row.report);
    if (entries.length > 0) return { runId: row.id, entries };
  }
  return undefined;
}

export interface BranchMatch {
  /** Keyed by `WorktreeRepo.name` — the shape `prepareAll` consumes. */
  continueBranches: Record<string, string>;
  /** Reported repo names that matched nothing mounted; observability only. */
  unmatched: string[];
}

/**
 * Map agent-reported artifact entries onto the repos this run mounts.
 *
 * `artifacts.repos[].repo` is unconstrained, secret-scrubbed agent text, so
 * matching is deliberately strict: exact name, then ONE case-insensitive
 * fallback, and nothing else. No fuzzy or substring matching — starting a
 * stage on the WRONG repository is worse than starting it from the default
 * branch.
 *
 * A repo the previous stage never touched simply has no entry and starts from
 * its default branch; that is correct, not a failure. Unmatched reported names
 * are likewise not an error — the agent may legitimately have self-cloned an
 * out-of-scope repo into `.repos/<name>` (feature 020's escape hatch) — but
 * they are surfaced so a human can see them.
 */
export function matchReportedBranches(
  entries: NormalizedRepoArtifact[],
  repos: WorktreeRepo[],
): BranchMatch {
  const continueBranches: Record<string, string> = {};
  const unmatched: string[] = [];
  const byExact = new Map(repos.map((r) => [r.name, r.name]));
  const byLower = new Map(repos.map((r) => [r.name.toLowerCase(), r.name]));

  for (const entry of entries) {
    const branch = entry.branch;
    if (branch === undefined || branch.length === 0) continue;

    let name: string | undefined;
    if (entry.repo === undefined) {
      // Flat v1 form carries no repo name. It is single-repo by definition, so
      // it is attributable only when exactly one repo is mounted; guessing
      // across two would risk basing a stage on the wrong repository.
      if (repos.length === 1) name = repos[0].name;
    } else {
      name = byExact.get(entry.repo) ?? byLower.get(entry.repo.toLowerCase());
    }

    if (name === undefined) {
      unmatched.push(entry.repo ?? branch);
      continue;
    }
    // First entry wins, deterministically — a duplicated repo name in one
    // report is agent error, not a reason to pick unpredictably.
    if (continueBranches[name] === undefined) continueBranches[name] = branch;
  }

  return { continueBranches, unmatched };
}
