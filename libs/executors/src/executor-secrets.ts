import { sealSecret, openSecret } from '@brigadir/jira';

/**
 * `executors.secrets` (bytea) codec — named runner profiles (2026-07-14).
 * The blob is a JSON object sealed with the SAME AES-256-GCM envelope and key
 * (`BRIGADIR_CREDENTIALS_KEY`) as workspace Jira credentials (`secret-box.ts`).
 * JSON (not the raw key) so future per-profile secret fields extend the shape
 * without an envelope version bump.
 *
 * The API layer treats the key as WRITE-ONLY (`has_api_key` in responses);
 * only the claude_cli runtime ever opens the blob — to inject
 * `ANTHROPIC_API_KEY` into the spawned process (billed by key instead of the
 * host subscription).
 */

export interface ExecutorSecrets {
  api_key?: string;
}

export function sealExecutorSecrets(secrets: ExecutorSecrets, key?: Buffer): Buffer {
  return sealSecret(JSON.stringify(secrets), key);
}

/** Throws `SecretBoxError` on tamper/wrong key — never a silent fallback. */
export function openExecutorSecrets(blob: Buffer | Uint8Array, key?: Buffer): ExecutorSecrets {
  const parsed: unknown = JSON.parse(openSecret(blob, key));
  return (parsed ?? {}) as ExecutorSecrets;
}
