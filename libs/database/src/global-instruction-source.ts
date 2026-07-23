import { eq, inArray, sql } from 'drizzle-orm';
import { AgentInstructionsSourceSchema, type AgentInstructionsSource } from '@brigadir/contracts';
import type { BrigadirDb } from './drizzle.constants';
import * as schema from './schema';
import type { StoredInstructionSource } from './workspace-settings';

/**
 * Global (platform) agent role-template source (feature 030), stored in the
 * `global_settings` KV under two keys — mirroring the `workspace_setup_instruction`
 * live-read pattern:
 *  - `agent_instructions_repo` — the non-secret source object {git_url, git_ref?, subdir?};
 *  - `agent_instructions_repo_token` — the sealed token as a base64 string (jsonb value).
 *
 * The token is sealed by the caller (controller) and opened by the caller
 * (resolver); this module only stores/loads bytes (database stays free of the
 * crypto layer — Constitution V, one codec at the edges).
 */

export const AGENT_INSTRUCTIONS_REPO_KEY = 'agent_instructions_repo';
export const AGENT_INSTRUCTIONS_REPO_TOKEN_KEY = 'agent_instructions_repo_token';

type DbRead = Pick<BrigadirDb, 'select'>;
type DbWrite = Pick<BrigadirDb, 'insert' | 'delete'>;

/**
 * Read the global source + sealed token blob. A missing/corrupt source value
 * degrades to `null` (built-ins) rather than throwing — the same fallback
 * posture as `getBrigadirAgentTemplate`.
 */
export async function getGlobalInstructionSource(db: DbRead): Promise<StoredInstructionSource> {
  const rows = await db
    .select({ key: schema.globalSettings.key, value: schema.globalSettings.value })
    .from(schema.globalSettings)
    .where(
      inArray(schema.globalSettings.key, [
        AGENT_INSTRUCTIONS_REPO_KEY,
        AGENT_INSTRUCTIONS_REPO_TOKEN_KEY,
      ]),
    );
  const byKey = new Map(rows.map((r) => [r.key, r.value]));

  let source: AgentInstructionsSource | null = null;
  const rawSource = byKey.get(AGENT_INSTRUCTIONS_REPO_KEY);
  if (rawSource != null) {
    const parsed = AgentInstructionsSourceSchema.safeParse(rawSource);
    source = parsed.success ? parsed.data : null;
  }

  let tokenBlob: Buffer | null = null;
  const rawToken = byKey.get(AGENT_INSTRUCTIONS_REPO_TOKEN_KEY);
  if (typeof rawToken === 'string' && rawToken.length > 0) {
    tokenBlob = Buffer.from(rawToken, 'base64');
  }

  return { source, tokenBlob };
}

/** Set (`upsert`) or clear (`null` ⇒ delete the row) the global source object. */
export async function setGlobalInstructionSource(
  db: DbWrite,
  source: AgentInstructionsSource | null,
): Promise<void> {
  if (source === null) {
    await db.delete(schema.globalSettings).where(eq(schema.globalSettings.key, AGENT_INSTRUCTIONS_REPO_KEY));
    return;
  }
  await db
    .insert(schema.globalSettings)
    .values({ key: AGENT_INSTRUCTIONS_REPO_KEY, value: source })
    .onConflictDoUpdate({
      target: schema.globalSettings.key,
      set: { value: source, updatedAt: sql`now()` },
    });
}

/** Set (`upsert`, base64) or clear (`null` ⇒ delete the row) the sealed global token. */
export async function setGlobalInstructionToken(db: DbWrite, tokenBlob: Buffer | null): Promise<void> {
  if (tokenBlob === null) {
    await db
      .delete(schema.globalSettings)
      .where(eq(schema.globalSettings.key, AGENT_INSTRUCTIONS_REPO_TOKEN_KEY));
    return;
  }
  const value = tokenBlob.toString('base64');
  await db
    .insert(schema.globalSettings)
    .values({ key: AGENT_INSTRUCTIONS_REPO_TOKEN_KEY, value })
    .onConflictDoUpdate({
      target: schema.globalSettings.key,
      set: { value, updatedAt: sql`now()` },
    });
}
