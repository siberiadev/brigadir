/**
 * Display-only compact number formatting (token counts): the API/DB keep the
 * exact integers; the UI compacts to `12.3k` / `1.2M` past 999.
 */

/** 340 → "340"; 12_345 → "12.3k"; 1_234_567 → "1.2M"; null/garbage → null. */
export function formatTokens(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value < 1000) return String(value);
  const compact = (n: number, suffix: string) => {
    const rounded = (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, '');
    return `${rounded}${suffix}`;
  };
  if (value < 1_000_000) return compact(value / 1000, 'k');
  return compact(value / 1_000_000, 'M');
}
