import type { JiraIssue, JiraIssueLink } from '@brigadir/contracts';

/**
 * Dependency gate (research D10, FR-034/035).
 *
 * A ticket is BLOCKED iff it has ≥1 inward "is blocked by" issue link whose
 * linked (blocker) issue has not reached the release threshold. ONLY inward
 * "is blocked by" links gate — outward "blocks" and "relates to" never do. The
 * linked issue's status comes straight from the `issuelinks[].inwardIssue`
 * that the poller's search returns (no extra fetch).
 *
 * Feature 032: the threshold is configurable per workspace. `releaseStatus` is
 * `workspaces.settings.dependency_release_status` — a Jira status NAME. A link
 * is satisfied when the blocker's status name matches it (trimmed,
 * case-insensitive) OR its category is `done`. The done-category arm is kept
 * unconditionally so a blocker that jumps straight past the configured status
 * still releases its dependents. Option ABSENT ⇒ the comparison never runs and
 * the predicate is byte-identical to the pre-032 done-only rule (FR-016).
 */

const IS_BLOCKED_BY = 'is blocked by';

export interface DependencyGateOptions {
  /** Workspace's `dependency_release_status`; absent ⇒ done-category rule only. */
  releaseStatus?: string;
}

/** Is this link an inward "is blocked by" (the only kind that can gate)? */
function isBlockedByLink(link: JiraIssueLink): boolean {
  return link.inwardIssue !== undefined && link.type.inward.toLowerCase() === IS_BLOCKED_BY;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/** The unresolved blocking links (inward "is blocked by", blocker below threshold). */
function blockingLinks(issue: JiraIssue, opts: DependencyGateOptions = {}): JiraIssueLink[] {
  const wanted = opts.releaseStatus !== undefined ? normalize(opts.releaseStatus) : undefined;
  const links = issue.fields.issuelinks ?? [];
  return links.filter((link) => {
    if (!isBlockedByLink(link)) return false;
    const status = link.inwardIssue!.fields.status;
    if (status.statusCategory.key === 'done') return false;
    // An unknown / never-reached configured status simply never matches, which
    // leaves exactly the done-category rule standing (spec: degrade, don't refuse).
    if (wanted !== undefined && wanted.length > 0 && normalize(status.name) === wanted) return false;
    return true;
  });
}

/** Keys of the open blockers (for logging which ticket gates the trigger). */
export function blockingKeys(issue: JiraIssue, opts: DependencyGateOptions = {}): string[] {
  return blockingLinks(issue, opts).map((link) => link.inwardIssue!.key);
}

export function evaluateDependencyGate(
  issue: JiraIssue,
  opts: DependencyGateOptions = {},
): 'clear' | 'blocked' {
  return blockingLinks(issue, opts).length > 0 ? 'blocked' : 'clear';
}

/**
 * Feature 032: ALL inward "is blocked by" keys as observed on this issue,
 * regardless of blocker status — the observation persisted into
 * `tickets.blocked_by`. Distinct from {@link blockingKeys}, which answers "what
 * still gates?"; this answers "what is this ticket chained to?", which is what
 * branch inheritance needs long after the blockers have been released.
 * `tickets.blocked_state` remains the only waiting signal.
 */
export function allBlockedByKeys(issue: JiraIssue): string[] {
  return (issue.fields.issuelinks ?? []).filter(isBlockedByLink).map((link) => link.inwardIssue!.key);
}

/**
 * Feature 032 (FR-015): did any link clear ONLY because of the configured
 * status name — i.e. would this ticket still be blocked under the plain
 * done-category rule? Drives the early-release timeline annotation. Returns the
 * blocker keys + the status name that matched, empty when the release was a
 * plain done-category one (today's shape stays clean).
 */
export function earlyReleaseBlockers(
  issue: JiraIssue,
  opts: DependencyGateOptions = {},
): { key: string; status: string }[] {
  const wanted = opts.releaseStatus !== undefined ? normalize(opts.releaseStatus) : undefined;
  if (wanted === undefined || wanted.length === 0) return [];
  return (issue.fields.issuelinks ?? [])
    .filter(
      (link) =>
        isBlockedByLink(link) &&
        link.inwardIssue!.fields.status.statusCategory.key !== 'done' &&
        normalize(link.inwardIssue!.fields.status.name) === wanted,
    )
    .map((link) => ({ key: link.inwardIssue!.key, status: link.inwardIssue!.fields.status.name }));
}
