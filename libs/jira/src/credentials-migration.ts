import { eq } from 'drizzle-orm';
import { type BrigadirDb, schema } from '@brigadir/database';
import { decodeJiraCredentials, encodeJiraCredentials } from './credentials.codec';

/**
 * One-shot legacy-credentials boot migration (feature 005, FR-022 /
 * contracts/credentials-codec.md). Scans `workspaces` and, for every row whose
 * `jira_credentials[0]` is the legacy `{` byte (0x7b), re-encrypts it into the
 * AES-256-GCM `0x01` envelope (bumping `updated_at`).
 *
 * Idempotent: `0x01` rows and the iteration-1 placeholder bytes are skipped by
 * the version-byte sniff. Requires the credentials key (boot-required, T122), so
 * on a keyed boot this collapses the plaintext-tolerance window to this pass.
 * Returns the number of rows migrated (the caller logs it).
 */
const LEGACY_JSON_BYTE = 0x7b; // '{'

export async function migrateLegacyCredentials(db: BrigadirDb, key?: Buffer): Promise<number> {
  const rows = await db
    .select({ id: schema.workspaces.id, credentials: schema.workspaces.jiraCredentials })
    .from(schema.workspaces);

  let migrated = 0;
  for (const row of rows) {
    const blob = Buffer.from(row.credentials as Buffer);
    if (blob.length === 0 || blob[0] !== LEGACY_JSON_BYTE) continue;

    // Legacy plaintext path needs no key; re-encode into the GCM envelope.
    const creds = decodeJiraCredentials(blob);
    const encrypted = encodeJiraCredentials(creds, key);
    await db
      .update(schema.workspaces)
      .set({ jiraCredentials: encrypted, updatedAt: new Date() })
      .where(eq(schema.workspaces.id, row.id));
    migrated++;
  }
  return migrated;
}
