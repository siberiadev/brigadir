/**
 * Display-only cost formatting (decision 2026-07-15): the API/DB keep the full
 * numeric(10,4) precision; the UI always rounds to 2 decimals.
 */

/** "2.3911" → "2.39"; null/undefined/garbage → null. */
export function formatCost(value: string | number | null | undefined): string | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n.toFixed(2);
}

/** "2.3911" → "$2.39"; null/undefined/garbage → null. */
export function formatCostUsd(value: string | number | null | undefined): string | null {
  const formatted = formatCost(value);
  return formatted !== null ? `$${formatted}` : null;
}
