/**
 * Env-variable rules for agent runs (feature 031). SEPARATE dep-free module
 * (no zod, no node:*) so the web app imports it from the TS source via the
 * `@brigadir/contracts/env` alias — same discipline as pagination.constants —
 * and reserved-key / format validation is byte-identical in the browser form
 * and the server. The zod schemas that consume these live in `env.schema.ts`.
 */

/** POSIX-ish env var name: letter/underscore, then letters/digits/underscores. */
export const ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Per-value byte cap (data-model.md). */
export const ENV_VALUE_MAX_BYTES = 8 * 1024;

/** Per-run merged-set byte cap (data-model.md). */
export const ENV_TOTAL_MAX_BYTES = 64 * 1024;

/**
 * Keys the platform itself injects (auth, provider routing, process bootstrap,
 * git/ssh, test harness). Operator env may NEVER set these — the executor
 * applies platform values AFTER operator env so they win regardless, but every
 * write surface also rejects them so the config never carries a lie. Prefix
 * rules (below) cover the whole vendor/platform namespaces; this exact set
 * catches the bare bootstrap names that carry no prefix.
 */
export const RESERVED_ENV_KEYS: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'TERM',
  'TMPDIR',
  'SSH_AUTH_SOCK',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'NODE_EXTRA_CA_CERTS',
];

/**
 * Reserved key PREFIXES. Anything starting with one of these is platform
 * territory: ANTHROPIC_* / AWS_* / CLAUDE_* are vendor-auth/provider routing,
 * FAKE_CLAUDE_* is the test-harness channel, BRIGADIR_* reserves the platform's
 * own namespace for future injections.
 */
export const RESERVED_ENV_PREFIXES: readonly string[] = [
  'ANTHROPIC_',
  'AWS_',
  'CLAUDE_',
  'FAKE_CLAUDE_',
  'BRIGADIR_',
];

/** True when `key` is platform-reserved (exact name or reserved prefix). */
export function isReservedEnvKey(key: string): boolean {
  if (RESERVED_ENV_KEYS.includes(key)) return true;
  return RESERVED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * UTF-8 byte length of a string (env caps are byte-based, not char-based).
 * Uses TextEncoder so this module stays dep-free and works in the browser
 * bundle as well as node.
 */
export function envByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
