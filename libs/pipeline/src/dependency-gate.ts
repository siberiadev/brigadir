import type { JiraIssue, JiraIssueLink } from '@brigadir/contracts';

/**
 * Dependency gate (research D10, FR-034/035).
 *
 * A ticket is BLOCKED iff it has ≥1 inward "is blocked by" issue link whose
 * linked (blocker) issue is not in the `done` status category. ONLY inward
 * "is blocked by" links gate — outward "blocks" and "relates to" never do. The
 * linked issue's status comes straight from the `issuelinks[].inwardIssue`
 * that the poller's search returns (no extra fetch).
 */

const IS_BLOCKED_BY = 'is blocked by';

/** The unresolved blocking links (inward "is blocked by", blocker not done). */
function blockingLinks(issue: JiraIssue): JiraIssueLink[] {
  const links = issue.fields.issuelinks ?? [];
  return links.filter(
    (link) =>
      link.inwardIssue !== undefined &&
      link.type.inward.toLowerCase() === IS_BLOCKED_BY &&
      link.inwardIssue.fields.status.statusCategory.key !== 'done',
  );
}

/** Keys of the open blockers (for logging which ticket gates the trigger). */
export function blockingKeys(issue: JiraIssue): string[] {
  return blockingLinks(issue).map((link) => link.inwardIssue!.key);
}

export function evaluateDependencyGate(issue: JiraIssue): 'clear' | 'blocked' {
  return blockingLinks(issue).length > 0 ? 'blocked' : 'clear';
}
