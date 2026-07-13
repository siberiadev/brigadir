import { Provider } from '@nestjs/common';

/**
 * Shared dashboard bearer secret (feature 005, R5). Mirrors
 * `jwt-secret.provider.ts`: resolved in a DI factory (never at `@Module()`
 * composition — Constitution lazy resolution), fail-fast with no dev default.
 * Distinct from the run-token secret: this guards operator→system dashboard
 * routes, the run token guards agent→system callbacks.
 *
 * Lives in `@brigadir/app-config` (feature 006) so BOTH the backend dashboard
 * module AND `libs/human-tasks` (the guarded resolve endpoint) can inject it
 * without a lib→app dependency.
 */

export const BRIGADIR_DASHBOARD_TOKEN = Symbol('BRIGADIR_DASHBOARD_TOKEN');

export class DashboardTokenMissingError extends Error {
  constructor() {
    super('BRIGADIR_DASHBOARD_TOKEN env var is required (dashboard bearer auth) — no default fallback');
    this.name = 'DashboardTokenMissingError';
  }
}

export function resolveDashboardToken(): string {
  const token = process.env.BRIGADIR_DASHBOARD_TOKEN;
  if (!token) {
    throw new DashboardTokenMissingError();
  }
  return token;
}

export const dashboardTokenProvider: Provider = {
  provide: BRIGADIR_DASHBOARD_TOKEN,
  useFactory: (): string => resolveDashboardToken(),
};
