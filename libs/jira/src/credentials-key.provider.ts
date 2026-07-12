import { Provider } from '@nestjs/common';

/**
 * AES-256-GCM key for `workspaces.jira_credentials` at rest (feature 005, R2 /
 * contracts/credentials-codec.md). Mirrors `jwt-secret.provider.ts`: resolved in
 * a DI factory — NOT at `@Module()` composition — so env set by a test harness /
 * process manager after import time is honored (Constitution lazy resolution).
 *
 * FR-023 fail-fast: the key is a HARD boot requirement for BOTH backend and
 * worker. `BRIGADIR_CREDENTIALS_KEY` is 32 bytes, accepted as base64 OR hex; a
 * missing/mis-sized value throws `CredentialsKeyMissingError` — never a silent
 * default and never a plaintext fallback.
 */

export const BRIGADIR_CREDENTIALS_KEY = Symbol('BRIGADIR_CREDENTIALS_KEY');

export class CredentialsKeyMissingError extends Error {
  constructor(detail = 'is not set') {
    super(
      `BRIGADIR_CREDENTIALS_KEY ${detail} — a 32-byte base64/hex key is required for credentials at rest (no default fallback)`,
    );
    this.name = 'CredentialsKeyMissingError';
  }
}

/** Decode a base64/hex env value into a 32-byte key Buffer, or throw. */
export function resolveCredentialsKey(raw: string | undefined = process.env.BRIGADIR_CREDENTIALS_KEY): Buffer {
  if (!raw) {
    throw new CredentialsKeyMissingError();
  }
  // 64 hex chars → hex; otherwise base64. Validate the decoded length is 32.
  const key = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new CredentialsKeyMissingError(
      `decoded to ${key.length} bytes (expected 32)`,
    );
  }
  return key;
}

export const credentialsKeyProvider: Provider = {
  provide: BRIGADIR_CREDENTIALS_KEY,
  useFactory: (): Buffer => resolveCredentialsKey(),
};
