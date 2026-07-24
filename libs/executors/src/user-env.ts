import { isReservedEnvKey } from '@brigadir/contracts';

/**
 * Operator-supplied environment variables for agent runs (feature 031).
 *
 * Composition merges three scopes in precedence order and the platform applies
 * its own env AFTER this (auth/provider), so a reserved key can never be
 * overridden by operator env. `applyUserEnv` is the single injection point,
 * called in ClaudeCliExecutor.runProcess BETWEEN the allowlist floor
 * (`buildChildEnv`) and `applyAuthEnv` — so `ALLOWLIST_KEYS` is never widened.
 *
 * See specs/031-agent-env-variables/data-model.md ("Effective run env") for the
 * normative precedence formula.
 */

export type EnvMap = Record<string, string>;

export interface ComposeUserEnvInput {
  /** Workspace-level env defaults (plaintext ⊕ decrypted secrets), lowest layer. */
  workspaceEnv?: EnvMap;
  /**
   * Per-repository env for the run's MOUNTED repositories, in mount order.
   * Later entries win on key collision (data-model.md D4). Each entry is the
   * repo's plaintext env already merged with its decrypted secrets.
   */
  repoEnvs?: EnvMap[];
  /** Per-agent env override (plaintext ⊕ decrypted secrets), highest layer. */
  agentEnv?: EnvMap;
}

/**
 * Merge the operator env layers by precedence: workspace < repos (in mount
 * order, later wins) < agent. Reserved keys are NOT filtered here — that is
 * `applyUserEnv`'s defensive job at the injection boundary, so callers that
 * want the raw effective merge (e.g. UI override-diffing) see everything.
 */
export function composeUserEnv(input: ComposeUserEnvInput): EnvMap {
  const merged: EnvMap = {};
  Object.assign(merged, input.workspaceEnv ?? {});
  for (const repoEnv of input.repoEnvs ?? []) {
    Object.assign(merged, repoEnv);
  }
  Object.assign(merged, input.agentEnv ?? {});
  return merged;
}

/** One mounted repository, in mount order, as the layer assembler needs it. */
export interface MountedRepoEnvSource {
  /** Stable repo id — keys secret env in `EnvSecretsDocument.repos`. */
  id?: string;
  /** Non-secret per-repo env from `settings.repositories[].env`. */
  env?: EnvMap;
}

export interface AssembleEnvInput {
  /** Non-secret workspace defaults (`settings.env`). */
  workspaceEnv?: EnvMap;
  /** Non-secret per-agent override (`behavior.env`). */
  agentEnv?: EnvMap;
  /** Mounted repositories in mount order (later wins). */
  mountedRepos?: MountedRepoEnvSource[];
  /** The run agent's id — keys secret agent env. */
  agentId?: string;
  /** Decrypted secret env by scope (from the sealed `env_secrets` blob). */
  secrets?: {
    workspace?: EnvMap;
    repos?: Record<string, EnvMap>;
    agents?: Record<string, EnvMap>;
  };
}

/**
 * Assemble the full effective operator env for a run from its non-secret config
 * plus the decrypted secret scopes, merging plaintext and secret at EACH scope
 * before the scope precedence is applied (data-model.md "Effective run env").
 * Returns the merged env AND the flat list of secret values in it, so the
 * caller can build a run-scoped scrubber ({@link makeScrub}) that redacts them
 * from every output (FR-007).
 */
export function assembleRunUserEnv(input: AssembleEnvInput): { userEnv: EnvMap; secretValues: string[] } {
  const secrets = input.secrets ?? {};
  const secretValues: string[] = [];
  const collect = (m?: EnvMap): EnvMap | undefined => {
    if (m) for (const v of Object.values(m)) secretValues.push(v);
    return m;
  };

  const workspaceLayer: EnvMap = { ...(input.workspaceEnv ?? {}), ...(collect(secrets.workspace) ?? {}) };
  const repoLayers: EnvMap[] = (input.mountedRepos ?? []).map((repo) => ({
    ...(repo.env ?? {}),
    ...(collect(repo.id ? secrets.repos?.[repo.id] : undefined) ?? {}),
  }));
  const agentSecret = input.agentId ? secrets.agents?.[input.agentId] : undefined;
  const agentLayer: EnvMap = { ...(input.agentEnv ?? {}), ...(collect(agentSecret) ?? {}) };

  const userEnv = composeUserEnv({
    workspaceEnv: workspaceLayer,
    repoEnvs: repoLayers,
    agentEnv: agentLayer,
  });
  return { userEnv, secretValues };
}

/**
 * Inject the composed operator env into a child-env object, IN PLACE. Drops any
 * platform-reserved key (defense-in-depth: write surfaces reject these, but
 * stored/legacy/hand-edited data must never smuggle one through) and returns
 * the list of dropped keys so the caller can log a run diagnostic.
 *
 * MUST be called after the allowlist floor and BEFORE the platform's own
 * auth/provider injection, so platform values overwrite any colliding key.
 */
export function applyUserEnv(env: Record<string, string>, userEnv: EnvMap): string[] {
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(userEnv)) {
    if (isReservedEnvKey(key)) {
      dropped.push(key);
      continue;
    }
    env[key] = value;
  }
  return dropped;
}
