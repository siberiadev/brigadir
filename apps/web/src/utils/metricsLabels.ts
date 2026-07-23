/**
 * Single home for the human-readable series labels on the /metrics page (feature
 * 029, FR-017/M5). Every Metrics panel pulls legend/series names from here
 * rather than reinventing them, so terminology stays consistent with the rest of
 * the dashboard (run statuses are shown verbatim, matching RunStatusTag) and the
 * "no applicable dimension" bucket reads the same everywhere.
 */

/** The backend's placeholder category for a NULL dimension (FR-014). */
export const UNKNOWN_KEY = '__unknown__';
/** Its human label — the single agreed wording (FR-017). */
export const UNKNOWN_LABEL = 'unknown';

/** Token-type series → readable legend names (Cost & Usage tab). */
export const TOKEN_TYPE_LABELS: Record<string, string> = {
  input: 'Input',
  output: 'Output',
  cache_read: 'Cache read',
  cache_creation: 'Cache creation',
};

/** Human-task kind → readable legend names (Human-in-the-loop tab). */
export const HUMAN_TASK_KIND_LABELS: Record<string, string> = {
  question: 'Question',
  blocker: 'Blocker',
  review: 'Review',
};

/**
 * Generic series-key → label. `__unknown__` becomes «не определено»; everything
 * else (statuses, executor types, trigger sources, roles, workspace names) is
 * shown verbatim — matching how the rest of the dashboard renders those tokens.
 */
export function metricSeriesLabel(key: string): string {
  return key === UNKNOWN_KEY ? UNKNOWN_LABEL : key;
}

/** Token-type key → label (falls back to the generic rule). */
export function tokenTypeLabel(key: string): string {
  return TOKEN_TYPE_LABELS[key] ?? metricSeriesLabel(key);
}

/** Human-task kind key → label (falls back to the generic rule). */
export function humanTaskKindLabel(key: string): string {
  return HUMAN_TASK_KIND_LABELS[key] ?? metricSeriesLabel(key);
}
