import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExecutorConfig } from '@brigadir/contracts';
import type { ExecutorType } from '../agent-executor.interface';

/** The `claude_cli` branch of `ExecutorConfigSchema` (already zod-defaulted). */
export type ClaudeCliExecutorConfig = Extract<ExecutorConfig, { type: 'claude_cli' }>;

/**
 * Moonshot's Anthropic-compatible endpoint (feature 025,
 * specs/025-kimi-executor/contracts/kimi-provider-env.md). A module-scope
 * constant read at composition time is permitted static structure
 * (Constitution lazy-resolution carve-out): it is the identity of the `kimi`
 * executor type, not a credential or connection — deliberately NOT
 * operator-configurable, never persisted, never exposed via API/UI.
 */
export const MOONSHOT_ANTHROPIC_BASE_URL = 'https://api.moonshot.ai/anthropic';

/**
 * Provider preset (feature 025): fixed per DI-registered executor instance,
 * outside any profile config — which is exactly why editing a profile can
 * never re-point it at another provider. `claude_cli` gets no base URL
 * (behavior byte-identical to pre-025); `kimi` gets the Moonshot constant.
 */
export interface ProviderPreset {
  type: ExecutorType;
  anthropicBaseUrl?: string;
}

/**
 * Platform default toolset for a REPO-MOUNTED run when neither the executor
 * profile (`config.allowedTools`) nor the agent (`behavior.allowed_tools`)
 * declares any (ST3-768). Under `--permission-mode dontAsk` an empty allowlist
 * auto-denies every mutating tool — the agent can read the repo but never
 * write, branch, or push, which no repo-mounted run ever wants. Generated
 * teams (`behavior: {}`) and the seeded `claude` profile hit exactly this.
 * Explicit config on either level still wins; no-repo (triage) runs keep the
 * empty allowlist — they have no workspace to mutate.
 *
 * `Bash` is deliberately unrestricted: the real guardrails are the per-run git
 * worktree, the run timeout, and the budget — tool-level narrowing is the
 * OPERATOR's per-profile/per-agent override (e.g. a read-only reviewer), not
 * the default. Read-only tools (Read/Glob/Grep) are listed for explicitness
 * even though dontAsk auto-allows them.
 */
export const DEFAULT_REPO_RUN_ALLOWED_TOOLS: readonly string[] = [
  'Read',
  'Glob',
  'Grep',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'TodoWrite',
  'Task',
  'Skill',
  'Bash',
  'WebFetch',
  'WebSearch',
];

/**
 * What's actually stored in `executors.config` (the DB jsonb column) at
 * runtime — the discriminant `type` and shared `concurrency` live in their
 * own columns, so the jsonb blob is everything else in the branch.
 * `repository` is NOT part of the executor config (platform-scoped executors,
 * 2026-07-13): a run's repository comes from `agents.behavior.repository`,
 * else the run workspace's default; a leftover key in old rows is ignored.
 */
export type ClaudeCliExecutorConfigInput = Omit<
  ClaudeCliExecutorConfig,
  'type' | 'concurrency' | 'repository'
>;

/** Fully-defaulted runtime shape the executor consumes — no optional fields left. */
export interface ClaudeCliRuntimeConfig {
  model: string;
  cliPath: string;
  allowedTools: string[];
  keepFailedWorktrees: boolean;
  worktreeRoot: string;
  repoCacheRoot: string;
  maxTurns?: number;
  killGraceMs: number;
  cancelPollMs: number;
  /** Feature 004 (D6): explicit opt-in to the MCP callback channel. */
  useCallbackChannel: boolean;
}

/**
 * Effective auth mode (feature 018, specs/018-bedrock-auth-mode/contracts/
 * executor-auth.md). Discriminated result so bedrock's required region is
 * carried by the type, not re-checked at every consumer.
 */
export type EffectiveAuth =
  | { mode: 'host_subscription' }
  | { mode: 'api_key' }
  | { mode: 'bedrock'; awsRegion: string; awsProfile?: string; caBundlePath?: string };

/**
 * The ONE implementation of the auth defaulting rule (feature 018 FR-002):
 * stored `auth` wins; absent → `api_key` iff a sealed key blob exists, else
 * `host_subscription`. Consumed by the runtime (loadRunConfig) AND the
 * dashboard response mapper — duplicating this conditional is how the two
 * would drift. Stored rows are never rewritten to materialize the default.
 *
 * A bedrock row without awsRegion cannot be written through the validated
 * API/boot paths; hitting one here means hand-edited jsonb — fail loud
 * (FR-012), never fall back to another auth mode.
 */
export function resolveEffectiveAuth(
  config: Pick<ClaudeCliExecutorConfigInput, 'auth' | 'awsRegion' | 'awsProfile' | 'caBundlePath'>,
  hasStoredKey: boolean,
): EffectiveAuth {
  const mode = config.auth ?? (hasStoredKey ? 'api_key' : 'host_subscription');
  if (mode !== 'bedrock') return { mode };
  if (!config.awsRegion) {
    throw new Error('executor config has auth "bedrock" but no awsRegion — re-save the profile');
  }
  return {
    mode,
    awsRegion: config.awsRegion,
    awsProfile: config.awsProfile,
    caBundlePath: config.caBundlePath,
  };
}

/**
 * Per-mode child-env injection (feature 018), applied strictly AFTER
 * `buildChildEnv` — the allowlist floor is unchanged and every value here
 * comes from the profile row, never from the worker's own process.env:
 *  - host_subscription → nothing (CLI reads ~/.claude via HOME);
 *  - api_key → ANTHROPIC_API_KEY (the profile's own decrypted secret —
 *    the HOST's variable of the same name still cannot leak through);
 *  - bedrock → CLAUDE_CODE_USE_BEDROCK=1 + AWS_REGION (+ AWS_PROFILE /
 *    NODE_EXTRA_CA_CERTS iff configured). AWS credentials are NEVER injected:
 *    the CLI resolves them from ~/.aws via the allowlisted HOME.
 * Pure (mutates only the passed env object) — unit-tested per mode.
 */
export function applyAuthEnv(
  env: Record<string, string>,
  auth: EffectiveAuth,
  apiKey?: string,
): void {
  switch (auth.mode) {
    case 'host_subscription':
      return;
    case 'api_key':
      if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
      return;
    case 'bedrock':
      env.CLAUDE_CODE_USE_BEDROCK = '1';
      env.AWS_REGION = auth.awsRegion;
      if (auth.awsProfile) env.AWS_PROFILE = auth.awsProfile;
      if (auth.caBundlePath) env.NODE_EXTRA_CA_CERTS = auth.caBundlePath;
      return;
  }
}

/**
 * Provider-endpoint injection (feature 025), applied strictly AFTER
 * `buildChildEnv` and AFTER `applyAuthEnv` — same discipline as the auth
 * injection above: the allowlist floor is untouched (`ANTHROPIC_BASE_URL` is
 * never a member and never will be, so a host-level value cannot reach any
 * run of any type), and the injected value comes from the DI-time preset
 * constant, never from the worker's own process.env. For the `claude_cli`
 * preset (no `anthropicBaseUrl`) this is a no-op and the env object stays
 * byte-identical to pre-025. Pure (mutates only the passed env object) —
 * unit-tested per preset.
 */
export function applyProviderEnv(env: Record<string, string>, preset: ProviderPreset): void {
  if (preset.anthropicBaseUrl) {
    env.ANTHROPIC_BASE_URL = preset.anthropicBaseUrl;
  }
}

/**
 * Resolve the boot-validated `claude_cli` config branch into the runtime
 * shape (D9/contracts/executor-config.md). Pure — no I/O; `os.homedir()` is a
 * process-metadata read, not a filesystem/network call, and every default
 * here mirrors the contract's documented default column.
 *
 * Workspace roots default under `~/.brigadir/`, NOT `os.tmpdir()` (changed
 * after the live incident of 2026-07-18). macOS periodically reaps files older
 * than ~3 days out of `$TMPDIR`, which silently guts a cached clone — and both
 * roots hold state that legitimately outlives a run: the per-repo cache across
 * runs, and, under `keepFailedWorktrees`, a failed run's tree kept for days of
 * human inspection. `ensureCache` now heals a rotted cache on its own; this
 * keeps the rot from happening in the first place.
 */
export function resolveClaudeCliConfig(
  raw: ClaudeCliExecutorConfigInput,
  agentAllowedTools: readonly string[] = [],
): ClaudeCliRuntimeConfig {
  return {
    model: raw.model,
    cliPath: raw.cliPath,
    allowedTools:
      raw.allowedTools && raw.allowedTools.length > 0 ? raw.allowedTools : [...agentAllowedTools],
    keepFailedWorktrees: raw.keepFailedWorktrees,
    worktreeRoot: raw.worktreeRoot ?? join(homedir(), '.brigadir', 'worktrees'),
    repoCacheRoot: raw.repoCacheRoot ?? join(homedir(), '.brigadir', 'repos'),
    maxTurns: raw.maxTurns,
    killGraceMs: raw.killGraceMs,
    cancelPollMs: raw.cancelPollMs,
    useCallbackChannel: raw.useCallbackChannel,
  };
}
