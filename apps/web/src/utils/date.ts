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

/** Compact "how long ago" label for an ISO timestamp (queue age / run timing). */
export function relativeAge(iso: string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(iso).getTime();
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * 'HH:MM:SS' local wall-clock label for an ISO timestamp (timeline rows).
 * Manual padding — `toLocaleTimeString` output varies across CI locales.
 */
export function formatClockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** A duration in ms as a compact "1m 5s" / "42s" label; null → em dash. */
export function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}
