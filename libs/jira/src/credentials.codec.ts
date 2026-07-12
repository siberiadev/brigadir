import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { JiraCredentialsSchema, type JiraCredentials } from '@brigadir/contracts';
import { JiraAuthError } from './jira.errors';
import { resolveCredentialsKey } from './credentials-key.provider';

/**
 * Encode/decode `workspaces.jira_credentials` (bytea) with AES-256-GCM at rest
 * (feature 005, R2 / contracts/credentials-codec.md). Backs Constitution
 * Principle V.
 *
 * Envelope: `version(0x01) || iv(12) || authTag(16) || ciphertext`. The
 * plaintext is the same `JSON.stringify({email, api_token})` as the legacy
 * format, so the shape callers see is unchanged.
 *
 * The function seam (`encodeJiraCredentials` / `decodeJiraCredentials`) is
 * preserved so no caller changes. The key is resolved lazily at CALL time (never
 * at `@Module()` composition) via `resolveCredentialsKey()`; callers that hold an
 * explicit candidate key (Verify/rotation, tests) may pass it in.
 *
 * `decode` format-sniffs `blob[0]`:
 *  - `0x01` → GCM decrypt (REQUIRES the key — fail-fast).
 *  - `0x7b` (`{`) → legacy plaintext JSON (key NOT required — an operator who
 *    upgraded the binary before setting the key can still authenticate until the
 *    boot migration re-encrypts).
 *  - anything else (e.g. the iteration-1 placeholder bytes) → `JiraAuthError`.
 */

const VERSION_GCM = 0x01;
const LEGACY_JSON = 0x7b; // '{'
const IV_LEN = 12;
const TAG_LEN = 16;

/** AES-256-GCM encrypt. Requires the key (fail-fast). */
export function encodeJiraCredentials(creds: JiraCredentials, key: Buffer = resolveCredentialsKey()): Buffer {
  const plaintext = Buffer.from(JSON.stringify(JiraCredentialsSchema.parse(creds)), 'utf8');
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION_GCM]), iv, authTag, ciphertext]);
}

export function decodeJiraCredentials(
  blob: Buffer | Uint8Array,
  key?: Buffer,
): JiraCredentials {
  const buf = Buffer.from(blob);

  if (buf.length > 0 && buf[0] === VERSION_GCM) {
    return decodeGcm(buf, key ?? resolveCredentialsKey());
  }
  if (buf.length > 0 && buf[0] === LEGACY_JSON) {
    return decodeLegacyJson(buf);
  }
  throw new JiraAuthError(
    'workspace jira_credentials are not a valid credentials blob (unrecognized envelope)',
  );
}

function decodeGcm(buf: Buffer, key: Buffer): JiraCredentials {
  const iv = buf.subarray(1, 1 + IV_LEN);
  const authTag = buf.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(1 + IV_LEN + TAG_LEN);
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // tamper (auth-tag mismatch) or wrong key — never a silent fallback.
    throw new JiraAuthError('workspace jira_credentials failed AES-256-GCM authentication');
  }
  return parseAndValidate(plaintext.toString('utf8'));
}

function decodeLegacyJson(buf: Buffer): JiraCredentials {
  return parseAndValidate(buf.toString('utf8'));
}

function parseAndValidate(json: string): JiraCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new JiraAuthError(
      'workspace jira_credentials are not a valid credentials blob (expected {email, api_token})',
    );
  }
  const result = JiraCredentialsSchema.safeParse(parsed);
  if (!result.success) {
    throw new JiraAuthError(
      `workspace jira_credentials failed validation: ${result.error.issues
        .map((i) => i.path.join('.') || '<root>')
        .join(', ')}`,
    );
  }
  return result.data;
}
