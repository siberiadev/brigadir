/**
 * JiraModule error taxonomy (contracts.md C1).
 *
 * - NoTransitionPath: the board has no transition from the current status to the
 *   requested target (a board-config fault → the run is failed with this
 *   diagnostic, FR-008).
 * - JiraAuthError: credentials are missing/invalid — unrecoverable; the worker
 *   maps it to BullMQ `UnrecoverableError` rather than retrying forever.
 * - JiraRateLimited: a 429 the caller may act on; carries the retry delay.
 */

export class NoTransitionPath extends Error {
  constructor(
    readonly issueKey: string,
    readonly fromStatus: string | null,
    readonly targetStatus: string,
  ) {
    super(
      `no Jira transition from "${fromStatus ?? '(unknown)'}" to "${targetStatus}" on ${issueKey} — check the board workflow`,
    );
    this.name = 'NoTransitionPath';
  }
}

export class JiraAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JiraAuthError';
  }
}

/** A non-ok, non-429 HTTP response from Jira; carries the status for 409 handling. */
export class JiraHttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body?: string,
  ) {
    super(`Jira ${method} ${path} → ${status}${body ? `: ${body.slice(0, 300)}` : ''}`);
    this.name = 'JiraHttpError';
  }
}

export class JiraRateLimited extends Error {
  constructor(
    readonly retryAfterMs: number,
    readonly reason?: string,
  ) {
    super(`Jira rate limited (retry after ${retryAfterMs}ms${reason ? `, reason=${reason}` : ''})`);
    this.name = 'JiraRateLimited';
  }
}
