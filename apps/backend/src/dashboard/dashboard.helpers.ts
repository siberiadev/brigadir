import { PaginationQuerySchema, type CredentialStatus } from '@brigadir/contracts';

/**
 * Единый парсинг `page`/`page_size` для всех list-эндпоинтов (реш. 2026-07-15).
 * `.catch()` в схеме держит толерантность к мусору в query string (`?page=abc`
 * → 1), как исторически клампил runs.controller. Дефолт page_size = 10.
 */
export function parsePagination(
  pageRaw?: string,
  pageSizeRaw?: string,
): { page: number; pageSize: number; limit: number; offset: number } {
  const parsed = PaginationQuerySchema.parse({
    ...(pageRaw !== undefined ? { page: pageRaw } : {}),
    ...(pageSizeRaw !== undefined ? { page_size: pageSizeRaw } : {}),
  });
  return {
    page: parsed.page,
    pageSize: parsed.page_size,
    limit: parsed.page_size,
    offset: (parsed.page - 1) * parsed.page_size,
  };
}

/**
 * Extract a board id from a bare id or a Jira board URL (FR-006). Handles the
 * classic RapidBoard URL (`?rapidView=42`) and the newer `/boards/42` path.
 * Returns null when no id can be parsed.
 */
export function extractBoardId(board: string): number | null {
  const trimmed = board.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const m = trimmed.match(/rapidView=(\d+)/) ?? trimmed.match(/\/boards?\/(\d+)/i);
  return m ? Number(m[1]) : null;
}

/** Jira deep link built from stored fields — no live Jira call (FR-034). */
export function deepLink(siteUrl: string, jiraKey: string): string {
  return `${siteUrl.replace(/\/+$/, '')}/browse/${jiraKey}`;
}

/** duration = finished−started (ms); running → now−started; null when not started. */
export function durationMs(startedAt: Date | null, finishedAt: Date | null): number | null {
  if (!startedAt) return null;
  const end = finishedAt ?? new Date();
  return end.getTime() - startedAt.getTime();
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Derive the expiry badge state from `jira_credential_expires_at` (FR-021). */
export function deriveCredentialStatus(
  expiresAt: Date | null | undefined,
  now: Date = new Date(),
): CredentialStatus {
  if (!expiresAt) return 'ok';
  const remainingMs = expiresAt.getTime() - now.getTime();
  if (remainingMs <= 0) return 'expired';
  if (remainingMs <= 7 * DAY_MS) return 'warn_7';
  if (remainingMs <= 30 * DAY_MS) return 'warn_30';
  return 'ok';
}
