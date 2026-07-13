/**
 * The dashboard bearer guard moved to `@brigadir/app-config` (feature 006) so
 * both the backend dashboard module and `libs/human-tasks` can apply it.
 * Re-exported here to keep the feature-005 import paths stable. The
 * constant-time implementation lives in
 * `libs/app-config/src/dashboard-token.guard.ts`.
 */
export { DashboardTokenGuard } from '@brigadir/app-config';
