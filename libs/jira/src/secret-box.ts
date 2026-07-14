import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { resolveCredentialsKey } from './credentials-key.provider';

/**
 * Generic AES-256-GCM envelope for secrets at rest (extracted 2026-07-14 from
 * `credentials.codec.ts` so executor-profile API keys reuse the exact same
 * envelope and key as workspace Jira credentials — Constitution V, one codec,
 * one `BRIGADIR_CREDENTIALS_KEY`).
 *
 * Envelope: `version(0x01) || iv(12) || authTag(16) || ciphertext`. The key is
 * resolved lazily at CALL time (never at `@Module()` composition) via
 * `resolveCredentialsKey()`; callers holding an explicit key may pass it in.
 */

export const SECRET_BOX_VERSION_GCM = 0x01;
const IV_LEN = 12;
const TAG_LEN = 16;

/** Tamper / wrong-key / malformed envelope — never a silent fallback. */
export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

/** AES-256-GCM seal a utf8 plaintext. Requires the key (fail-fast). */
export function sealSecret(plaintext: string, key: Buffer = resolveCredentialsKey()): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([SECRET_BOX_VERSION_GCM]), iv, authTag, ciphertext]);
}

/** Open a sealed envelope back to the utf8 plaintext. Throws `SecretBoxError`. */
export function openSecret(blob: Buffer | Uint8Array, key: Buffer = resolveCredentialsKey()): string {
  const buf = Buffer.from(blob);
  if (buf.length === 0 || buf[0] !== SECRET_BOX_VERSION_GCM) {
    throw new SecretBoxError('secret blob is not a valid envelope (unrecognized version byte)');
  }
  const iv = buf.subarray(1, 1 + IV_LEN);
  const authTag = buf.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(1 + IV_LEN + TAG_LEN);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretBoxError('secret blob failed AES-256-GCM authentication (tamper or wrong key)');
  }
}
