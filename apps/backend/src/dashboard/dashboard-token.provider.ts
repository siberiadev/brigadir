/**
 * The dashboard bearer secret moved to `@brigadir/app-config` (feature 006) so
 * `libs/human-tasks` can guard its resolve endpoint without a lib→app import.
 * Re-exported here to keep the feature-005 import paths stable.
 */
export {
  BRIGADIR_DASHBOARD_TOKEN,
  DashboardTokenMissingError,
  resolveDashboardToken,
  dashboardTokenProvider,
} from '@brigadir/app-config';
