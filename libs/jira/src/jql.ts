/**
 * Escape a string for use inside a double-quoted JQL value. Callers compose
 * JQL server-side (contracts.md D6); every interpolated value must pass through
 * this so a quote/backslash in a status name or scope filter can't break out of
 * the quoted literal.
 */
export function jqlEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
