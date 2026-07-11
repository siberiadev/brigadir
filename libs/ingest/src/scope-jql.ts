import type { JiraBoardType } from '@brigadir/contracts';

/** Poller `fields` (data-model.md): status drives the diff, issuelinks the gate. */
export const POLL_FIELDS = ['status', 'summary', 'updated', 'issuelinks'] as const;

/** HWM overlap window (spec §perf): re-fetch the last 60s so nothing near the edge is lost. */
export const HWM_OVERLAP_MS = 60_000;

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

/** Lower bound for the next poll: HWM minus the overlap window, or undefined on first run. */
export function sinceClause(highWaterMark: string | undefined): string | undefined {
  if (!highWaterMark) return undefined;
  return new Date(Date.parse(highWaterMark) - HWM_OVERLAP_MS).toISOString();
}
