/**
 * Default token expiry — one year from `from` (Atlassian's max; the user can
 * override). Atlassian exposes no token-expiry API, so this is user-entered with
 * a sensible default (feature 005 spec amendment / FR-004).
 */
export function defaultExpiry(from: Date = new Date()): Date {
  const d = new Date(from);
  d.setFullYear(d.getFullYear() + 1);
  return d;
}
