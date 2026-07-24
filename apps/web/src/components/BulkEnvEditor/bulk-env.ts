import { ENV_KEY_REGEX, isReservedEnvKey, envByteLength, ENV_VALUE_MAX_BYTES } from '@brigadir/contracts/env';

/**
 * Pure logic for the bulk ".env" editor (DigitalOcean App Platform style). Kept
 * dep-free of Vue so it is unit-testable in isolation; the sole consumer is the
 * colocated BulkEnvEditor.vue.
 *
 * Secrets are write-only: their values never leave the server, so in the
 * textarea an existing secret shows as `KEY=<mask>`. On apply, a mask left
 * untouched keeps the stored value; a changed mask re-seals the secret; a
 * deleted line removes it. A brand-new key pasted as plain text is always a
 * NON-secret (plain text carries no "encrypt" marker) — mark it secret via the
 * row checkbox instead.
 */

/** Sentinel shown in place of an existing secret's value. Matches EnvVarsTable's mask. */
export const SECRET_MASK = '••••••••';

export interface BulkEnvError {
  line: number;
  message: string;
}

export interface BulkEnvResult {
  /** Final non-secret env (replaces the form's plaintext model). */
  plainEnv: Record<string, string>;
  /** Secrets to upsert (value changed away from the mask). */
  secretSet: Record<string, string>;
  /** Secret keys to delete (were secret, now absent from the text). */
  secretDelete: string[];
  /** Per-line validation errors; non-empty ⇒ apply is blocked. */
  errors: BulkEnvError[];
}

/** Quote a value that would not round-trip bare (spaces, `#`, leading/trailing ws, empty). */
function quoteIfNeeded(value: string): string {
  if (value === '') return '';
  if (/^\s|\s$|\s|#|"|'/.test(value)) return `"${value.replace(/"/g, '\\"')}"`;
  return value;
}

/** Strip one matching layer of surrounding single/double quotes. */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return value.slice(1, -1).replace(/\\"/g, '"');
    }
  }
  return value;
}

/**
 * Serialize the current env to `.env` text: plaintext `KEY=value` lines first,
 * then `KEY=<mask>` for each existing secret. This is what the textarea is
 * seeded with so the user edits the full set.
 */
export function serializeBulkEnv(plainEnv: Record<string, string>, secretKeys: string[]): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(plainEnv)) lines.push(`${key}=${quoteIfNeeded(value)}`);
  for (const key of secretKeys) lines.push(`${key}=${SECRET_MASK}`);
  return lines.join('\n');
}

interface ParsedLine {
  key: string;
  value: string;
  line: number;
}

/** Parse `.env` text into per-key entries (last wins), collecting format errors. */
function parseLines(text: string): { entries: Map<string, ParsedLine>; errors: BulkEnvError[] } {
  const entries = new Map<string, ParsedLine>();
  const errors: BulkEnvError[] = [];
  const rawLines = text.split(/\r?\n/);
  rawLines.forEach((raw, i) => {
    const line = i + 1;
    let trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    if (trimmed.startsWith('export ')) trimmed = trimmed.slice('export '.length).trimStart();
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      errors.push({ line, message: `Line ${line}: expected KEY=VALUE.` });
      return;
    }
    const key = trimmed.slice(0, eq).trim();
    const value = unquote(trimmed.slice(eq + 1).trim());
    if (!ENV_KEY_REGEX.test(key)) {
      errors.push({ line, message: `Line ${line}: "${key || '(empty)'}" is not a valid variable name.` });
      return;
    }
    if (isReservedEnvKey(key)) {
      errors.push({ line, message: `Line ${line}: "${key}" is reserved by the platform.` });
      return;
    }
    // Duplicate key → last wins (standard .env behavior); keep the latest line.
    entries.set(key, { key, value, line });
  });
  return { entries, errors };
}

/**
 * Classify parsed text against the current secret key names into the structured
 * apply result. Size-validates every NON-mask value.
 */
export function computeBulkResult(text: string, secretKeys: string[]): BulkEnvResult {
  const { entries, errors } = parseLines(text);
  const secretSet: Record<string, string> = {};
  const plainEnv: Record<string, string> = {};
  const isSecret = new Set(secretKeys);

  for (const { key, value, line } of entries.values()) {
    if (isSecret.has(key)) {
      if (value === SECRET_MASK) continue; // untouched → keep the stored secret
      if (envByteLength(value) > ENV_VALUE_MAX_BYTES) {
        errors.push({ line, message: `Line ${line}: value for "${key}" exceeds 8 KB.` });
        continue;
      }
      secretSet[key] = value; // changed → re-seal
    } else {
      if (envByteLength(value) > ENV_VALUE_MAX_BYTES) {
        errors.push({ line, message: `Line ${line}: value for "${key}" exceeds 8 KB.` });
        continue;
      }
      plainEnv[key] = value;
    }
  }

  // Secrets present before, gone from the text → delete.
  const secretDelete = secretKeys.filter((k) => !entries.has(k));

  return { plainEnv, secretSet, secretDelete, errors };
}
