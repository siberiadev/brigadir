import { and, desc, eq, inArray, ne } from 'drizzle-orm';
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

  for (const { entry, branch, repoName } of resolveEntries(entries, repos)) {
    if (repoName === undefined) {
      unmatched.push(entry.repo ?? branch);
      continue;
    }
    // First entry wins, deterministically — a duplicated repo name in one
    // report is agent error, not a reason to pick unpredictably.
    if (continueBranches[repoName] === undefined) continueBranches[repoName] = branch;
  }

  return { continueBranches, unmatched };
}

/**
 * The ONE implementation of "which mounted repo does this artifact entry name?"
 * — shared by the ticket's own prior work and (feature 032) by blocker work, so
 * the two can never drift into different matching rules. Entries without a
 * branch are dropped here, as they always were.
 */
function resolveEntries(
  entries: NormalizedRepoArtifact[],
  repos: WorktreeRepo[],
): { entry: NormalizedRepoArtifact; branch: string; repoName: string | undefined }[] {
  const byExact = new Map(repos.map((r) => [r.name, r.name]));
  const byLower = new Map(repos.map((r) => [r.name.toLowerCase(), r.name]));
  const out: { entry: NormalizedRepoArtifact; branch: string; repoName: string | undefined }[] = [];

  for (const entry of entries) {
    const branch = entry.branch;
    if (branch === undefined || branch.length === 0) continue;

    let repoName: string | undefined;
    if (entry.repo === undefined) {
      // Flat v1 form carries no repo name. It is single-repo by definition, so
      // it is attributable only when exactly one repo is mounted; guessing
      // across two would risk basing a stage on the wrong repository.
      if (repos.length === 1) repoName = repos[0].name;
    } else {
      repoName = byExact.get(entry.repo) ?? byLower.get(entry.repo.toLowerCase());
    }
    out.push({ entry, branch, repoName });
  }
  return out;
}

// --- Feature 032: inheriting a blocker's unmerged work ---

/** One blocker ticket's latest usable reported work. */
export interface BlockerWork {
  /** The blocker's Jira key. */
  key: string;
  /** The blocker run whose report supplied the branches. */
  runId: string;
  entries: NormalizedRepoArtifact[];
}

/** A blocker key that contributed nothing — kept for the missing-branch matrix. */
export interface BlockerMiss {
  key: string;
  /** `no_ticket`: never observed here (other project / not yet polled). */
  reason: 'no_ticket' | 'no_artifacts';
}

/**
 * The work each observed blocker left behind (feature 032, FR-006).
 *
 * Same shape and window as {@link getPriorWork}'s level 2 — the latest
 * `succeeded` run that actually reported a branch — applied to the BLOCKER
 * tickets instead of this one. Keys are returned in the order given; the caller
 * sorts. A key with no ticket row or no usable report is not an error here: the
 * caller decides whether it is quiet (blocker already done) or a human task
 * (blocker still open), which is the whole asymmetry of FR-008.
 */
export async function getBlockerWork(
  db: BrigadirDb,
  opts: { workspaceId: string; blockedByKeys: string[]; currentTicketId: string },
): Promise<{ found: BlockerWork[]; missing: BlockerMiss[] }> {
  const keys = [...new Set(opts.blockedByKeys)].filter((k) => k.length > 0);
  if (keys.length === 0) return { found: [], missing: [] };

  const tickets = await db
    .select({ id: schema.tickets.id, jiraKey: schema.tickets.jiraKey })
    .from(schema.tickets)
    .where(
      and(
        eq(schema.tickets.workspaceId, opts.workspaceId),
        inArray(schema.tickets.jiraKey, keys),
        ne(schema.tickets.id, opts.currentTicketId),
      ),
    );
  const ticketIdByKey = new Map(tickets.map((t) => [t.jiraKey, t.id]));

  const found: BlockerWork[] = [];
  const missing: BlockerMiss[] = [];
  for (const key of keys) {
    const ticketId = ticketIdByKey.get(key);
    if (ticketId === undefined) {
      missing.push({ key, reason: 'no_ticket' });
      continue;
    }
    const rows = await db
      .select({ id: schema.runs.id, report: schema.runs.report })
      .from(schema.runs)
      .where(and(eq(schema.runs.ticketId, ticketId), eq(schema.runs.status, 'succeeded')))
      .orderBy(desc(schema.runs.createdAt))
      .limit(SCAN_WINDOW);
    const hit = rows
      .map((row) => ({ runId: row.id, entries: branchEntries(row.report) }))
      .find((r) => r.entries.length > 0);
    if (hit) found.push({ key, ...hit });
    else missing.push({ key, reason: 'no_artifacts' });
  }
  return { found, missing };
}

/** Where ONE mounted repository starts, and what it inherited (data-model.md §3). */
export interface RepoStartPlan {
  source: 'own' | 'blocker' | 'default';
  /** Absent ⇔ `source === 'default'`. */
  startBranch?: string;
  /** Extra blocker branches merged INTO `startBranch`; only for `source: 'blocker'`. */
  mergeBranches: string[];
  /** Provenance for the timeline events and the wrapper. */
  blockers: { key: string; runId: string; branch: string }[];
}

export interface StartPlan {
  /** Keyed by `WorktreeRepo.name`; every mounted repo has an entry. */
  repos: Record<string, RepoStartPlan>;
  /** Blocker artifacts naming repositories this run does not mount (FR-010). */
  unmounted: { key: string; runId: string; repo: string; branch: string }[];
  /** Unmatched entries from the ticket's OWN prior work — observability only. */
  unmatched: string[];
}

/**
 * Layered per-repository start resolution (feature 032, contracts §2).
 *
 * Per mounted repository the FIRST source that names a branch wins and no
 * merging happens across levels:
 *
 *  1/2. the ticket's own prior work (`own`, produced by {@link getPriorWork} +
 *       {@link matchReportedBranches}) — unchanged feature-023 behaviour;
 *  3.   the blockers' work, in the order given (the caller sorts by key, so the
 *       result is deterministic): the first blocker to name a repo sets its
 *       start branch, later blockers naming the SAME repo are queued as merges;
 *  4.   nothing — the repo starts from its default branch.
 *
 * Own work outranks a blocker per REPOSITORY, not per run: a dependent that
 * already has its own branch in `api` still inherits `web` from its blocker.
 */
export function buildStartPlan(opts: {
  repos: WorktreeRepo[];
  own: BranchMatch;
  blockerWork: BlockerWork[];
}): StartPlan {
  const plan: Record<string, RepoStartPlan> = {};
  for (const repo of opts.repos) {
    const ownBranch = opts.own.continueBranches[repo.name];
    plan[repo.name] = ownBranch
      ? { source: 'own', startBranch: ownBranch, mergeBranches: [], blockers: [] }
      : { source: 'default', mergeBranches: [], blockers: [] };
  }

  const unmounted: StartPlan['unmounted'] = [];
  for (const blocker of opts.blockerWork) {
    for (const { entry, branch, repoName } of resolveEntries(blocker.entries, opts.repos)) {
      if (repoName === undefined) {
        // FR-010: the blocker changed a repository this run does not mount.
        // Silently ignoring it is exactly the failure this feature exists to
        // prevent, so it is surfaced instead of being dropped.
        unmounted.push({ key: blocker.key, runId: blocker.runId, repo: entry.repo ?? branch, branch });
        continue;
      }
      const target = plan[repoName];
      if (target.source === 'own') continue; // own work wins for this repo
      if (target.source === 'default') {
        target.source = 'blocker';
        target.startBranch = branch;
        target.blockers = [{ key: blocker.key, runId: blocker.runId, branch }];
        continue;
      }
      // A second blocker naming the same repo: merged into the start point in
      // this (deterministic) order — never silently ignored, never "last wins".
      if (target.startBranch === branch) continue;
      if (target.mergeBranches.includes(branch)) continue;
      target.mergeBranches.push(branch);
      target.blockers.push({ key: blocker.key, runId: blocker.runId, branch });
    }
  }

  return { repos: plan, unmounted, unmatched: opts.own.unmatched };
}
