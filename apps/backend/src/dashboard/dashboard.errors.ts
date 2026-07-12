import { HttpException, HttpStatus } from '@nestjs/common';
import type { ErrorIssue } from '@brigadir/contracts';

/**
 * Path-qualified 422 for validation/linter failures (contracts/dashboard-api.md
 * error shape). The wizard/agent form attaches each issue to its field. No raw
 * stack traces (SC-009).
 */
export function validationError(
  message: string,
  issues: ErrorIssue[],
  warnings?: ErrorIssue[],
): HttpException {
  return new HttpException(
    { error: { code: 'validation_failed', message, issues, ...(warnings && warnings.length ? { warnings } : {}) } },
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

/** Single-issue helper for verify/create field errors. */
export function fieldError(
  message: string,
  path: (string | number)[],
  code: string,
  value?: unknown,
): HttpException {
  return validationError(message, [{ path, code, message, value, level: 'error' }]);
}

/** 502 when the board status list can't be fetched (form blocks status editing). */
export function statusesUnavailable(): HttpException {
  return new HttpException(
    { error: { code: 'statuses_unavailable', message: 'Board statuses are currently unavailable.' } },
    HttpStatus.BAD_GATEWAY,
  );
}
