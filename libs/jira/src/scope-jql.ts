import type { JiraBoardType } from '@brigadir/contracts';

/**
 * Poller `fields` (data-model.md): status drives the diff, issuelinks the gate,
 * priority the release order (feature 022).
 */
export const POLL_FIELDS = ['status', 'summary', 'updated', 'issuelinks', 'priority'] as const;

/**
 * HWM overlap window. 26 HOURS, not seconds — two reasons (live incident 2026-07-13):
 * 1. JQL naked datetimes are interpreted in the API USER'S profile timezone and the
 *    literal carries no offset. Formatting the bound in UTC can therefore land up to
 *    ~±14h off the intended instant depending on the bot account's timezone; 26h of
 *    overlap makes the bound safely inclusive for every possible profile timezone.
 * 2. JQL minute precision truncates seconds.
 * Re-fetching a day's window is cheap (ORDER BY updated ASC, paged) and the ingest is
 * a diff against last_seen_status — re-seen unchanged tickets are no-ops.
 */
export const HWM_OVERLAP_MS = 26 * 60 * 60_000;

export interface BoardScope {
  boardType: JiraBoardType;
  projectKey: string;
  /** Active sprint id (scrum only); required for scrum scope, ignored for kanban. */
  sprintId?: number | null;
}

export interface ScopeJqlOptions extends BoardScope {
  /** Optional global filter from `workspaces.settings.scope_jql`. */
  scopeJql?: string;
  /** ISO lower bound for `updated` (omit for a sprint-switch full rescan / first run). */
  since?: string;
}

/**
 * Build the poller scope JQL (data-model.md "Poller scope JQL"):
 *
 * - kanban: `project = K [AND (scope_jql)] [AND updated >= "since"]`
 * - scrum:  `project = K AND sprint in (id) [AND (scope_jql)] [AND updated >= "since"]`
 * - scrum sprint-switch: same as scrum WITHOUT the `updated` clause (omit `since`)
 *
 * Ordered by `updated ASC` so the high-water mark advances monotonically.
 */
export function buildScopeJql(opts: ScopeJqlOptions): string {
  const clauses = [`project = "${opts.projectKey}"`];
  if (opts.boardType === 'scrum' && opts.sprintId != null) {
    clauses.push(`sprint in (${opts.sprintId})`);
  }
  if (opts.scopeJql) clauses.push(`(${opts.scopeJql})`);
  if (opts.since) clauses.push(`updated >= "${opts.since}"`);
  return `${clauses.join(' AND ')} ORDER BY updated ASC`;
}

/**
 * Lower bound for the next poll: HWM minus the overlap window, or undefined on first run.
 *
 * FORMAT IS LOAD-BEARING (live incident 2026-07-13): JQL accepts ONLY
 * `yyyy-MM-dd HH:mm` (minute precision, no timezone). An ISO-8601 string with
 * `T`/`Z`/millis is NOT rejected by the live `/rest/api/3/search/jql` — Jira
 * returns HTTP 200 with ZERO issues, silently. That killed incremental polling
 * in production while every test passed (mock-jira leniently parsed ISO).
 * Never emit toISOString() here; mock-jira now mirrors the silent-empty
 * behavior for non-JQL formats so a regression fails loudly in tests.
 */
export function sinceClause(highWaterMark: string | undefined): string | undefined {
  if (!highWaterMark) return undefined;
  const t = new Date(Date.parse(highWaterMark) - HWM_OVERLAP_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
}
