import type { StatusCategoryKey } from './jira.types';

/**
 * Pure agent mini-linter (feature 005, FR-012 / contracts/dashboard-api.md).
 *
 * The SINGLE source of the validation rules: the backend imports it as the save
 * authority (`agents.controller`) and `apps/web` imports the same function as the
 * client-side mirror, so the two can never drift. No I/O — it is a pure function
 * over the candidate agent, the other agents in the workspace, and the board's
 * flat status list.
 *
 * Rules & codes:
 * - `status_absent` (error) — any of trigger/running/success/failure names not on
 *   the board's flat status list, pinned to the offending field.
 * - `duplicate_trigger` (error) — `trigger_status` equals another **enabled**
 *   agent's, with an equal-or-absent `trigger_jql` (a distinct `trigger_jql`
 *   disambiguates and is allowed). Disabled agents never collide.
 * - `status_cycle` (warning, non-blocking) — A.success → B.trigger and
 *   B.success → A.trigger.
 */

/** A board status as returned by `getProjectStatuses` (flat, de-duped by id). */
export interface BoardStatus {
  id: string;
  name: string;
  statusCategory: StatusCategoryKey;
}

/** The subset of an agent the linter reasons about (candidate or existing). */
export interface LintableAgent {
  /** present when editing; used to exclude the candidate from the "other agents" set. */
  id?: string;
  name: string;
  trigger_status?: string | null;
  trigger_jql?: string | null;
  status_running?: string | null;
  status_success: string;
  status_failure: string;
  /** absent = treated as enabled. */
  enabled?: boolean;
}

export type LintLevel = 'error' | 'warning';

export interface LintIssue {
  path: (string | number)[];
  code: 'status_absent' | 'duplicate_trigger' | 'status_cycle';
  message: string;
  value?: unknown;
  level: LintLevel;
}

export interface LintResult {
  errors: LintIssue[];
  warnings: LintIssue[];
}

/** undefined/null/empty → null; otherwise the trimmed jql. Absent jqls compare equal. */
function normalizeJql(jql: string | null | undefined): string | null {
  const v = (jql ?? '').trim();
  return v === '' ? null : v;
}

const STATUS_FIELDS: { field: keyof LintableAgent; path: string }[] = [
  { field: 'trigger_status', path: 'trigger_status' },
  { field: 'status_running', path: 'status_running' },
  { field: 'status_success', path: 'status_success' },
  { field: 'status_failure', path: 'status_failure' },
];

export function lintAgent(
  candidate: LintableAgent,
  agentsInWorkspace: LintableAgent[],
  boardStatuses: BoardStatus[],
): LintResult {
  const errors: LintIssue[] = [];
  const warnings: LintIssue[] = [];

  const boardNames = new Set(boardStatuses.map((s) => s.name));

  // --- status_absent: each present status name must exist on the board ---
  for (const { field, path } of STATUS_FIELDS) {
    const name = candidate[field] as string | null | undefined;
    if (name == null || name === '') continue;
    if (!boardNames.has(name)) {
      errors.push({
        path: [path],
        code: 'status_absent',
        message: `"${name}" is not a status on this board.`,
        value: name,
        level: 'error',
      });
    }
  }

  // Other enabled agents (exclude the candidate itself when editing).
  const others = agentsInWorkspace.filter(
    (a) => a.enabled !== false && !(candidate.id !== undefined && a.id === candidate.id),
  );

  // --- duplicate_trigger: same trigger_status + equal/absent trigger_jql ---
  const candTrigger = candidate.trigger_status ?? null;
  if (candTrigger != null && candTrigger !== '') {
    const candJql = normalizeJql(candidate.trigger_jql);
    const collision = others.find(
      (a) =>
        (a.trigger_status ?? null) === candTrigger && normalizeJql(a.trigger_jql) === candJql,
    );
    if (collision) {
      errors.push({
        path: ['trigger_status'],
        code: 'duplicate_trigger',
        message: `Another enabled agent ("${collision.name}") already triggers on "${candTrigger}" with the same JQL scope.`,
        value: candTrigger,
        level: 'error',
      });
    }
  }

  // --- status_cycle (warning): A.success→B.trigger and B.success→A.trigger ---
  if (candTrigger != null && candTrigger !== '') {
    const cycleWith = others.find(
      (b) =>
        (b.trigger_status ?? null) === candidate.status_success &&
        b.status_success === candTrigger,
    );
    if (cycleWith) {
      warnings.push({
        path: ['status_success'],
        code: 'status_cycle',
        message: `This may form a status cycle with agent "${cycleWith.name}".`,
        value: candidate.status_success,
        level: 'warning',
      });
    }
  }

  return { errors, warnings };
}
