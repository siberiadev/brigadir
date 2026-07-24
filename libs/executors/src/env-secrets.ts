import { sealSecret, openSecret } from '@brigadir/jira';

/**
 * `workspaces.env_secrets` (bytea) codec — feature 031. One sealed JSON
 * document PER WORKSPACE holds the secret env values of all three scopes,
 * sealed with the SAME AES-256-GCM envelope and key (`BRIGADIR_CREDENTIALS_KEY`)
 * as jira_credentials / executors.secrets. One blob = one crypto envelope, one
 * decrypt per run start, logical granularity down to repo/agent inside the JSON.
 *
 * Repos are keyed by their STABLE `id` (WorkspaceRepositorySchema.id), never by
 * name — a rename must not orphan the secrets. Agents are keyed by agent id.
 *
 * The API layer treats every value as WRITE-ONLY (responses expose only key
 * NAMES via env_secret_keys); only the claude_cli runtime ever opens the blob —
 * to merge secret env into the spawned process (feature 031 injection contract).
 */

export interface EnvSecretsDocument {
  /** Workspace-scope secret env defaults. */
  workspace?: Record<string, string>;
  /** repoId → secret env values for that repository. */
  repos?: Record<string, Record<string, string>>;
  /** agentId → secret env values for that agent's runs. */
  agents?: Record<string, Record<string, string>>;
}

export function sealEnvSecrets(doc: EnvSecretsDocument, key?: Buffer): Buffer {
  return sealSecret(JSON.stringify(doc), key);
}

/** Throws `SecretBoxError` on tamper/wrong key — never a silent fallback. */
export function openEnvSecrets(blob: Buffer | Uint8Array, key?: Buffer): EnvSecretsDocument {
  const parsed: unknown = JSON.parse(openSecret(blob, key));
  return (parsed ?? {}) as EnvSecretsDocument;
}

/**
 * Names-only projection of the sealed doc (the shape the API returns). Never
 * exposes values. Empty arrays/objects for absent scopes so the response shape
 * is stable.
 */
export function envSecretKeys(doc: EnvSecretsDocument): {
  workspace: string[];
  repos: Record<string, string[]>;
  agents: Record<string, string[]>;
} {
  const namesOf = (m?: Record<string, string>): string[] => Object.keys(m ?? {});
  const perRef = (m?: Record<string, Record<string, string>>): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    for (const [ref, values] of Object.entries(m ?? {})) out[ref] = namesOf(values);
    return out;
  };
  return {
    workspace: namesOf(doc.workspace),
    repos: perRef(doc.repos),
    agents: perRef(doc.agents),
  };
}
