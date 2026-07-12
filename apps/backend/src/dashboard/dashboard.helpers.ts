import type { CredentialStatus } from '@brigadir/contracts';

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
