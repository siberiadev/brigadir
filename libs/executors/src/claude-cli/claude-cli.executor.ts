import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { eq } from 'drizzle-orm';
import {
  DRIZZLE,
  type BrigadirDb,
  schema,
  getBrigadirAgentTemplate,
  ensureSetupExecutor,
  createKeyedTicketTask,
  SETUP_EXECUTOR_NAME,
} from '@brigadir/database';
import { AGENTS_CONFIG } from '@brigadir/app-config';
import { JIRA_CLIENT, type JiraClient } from '@brigadir/jira';
import {
  ReportSchema,
  isApiKeyOnlyExecutorType,
  matchVerificationReceipt,
  VerificationReceiptSchema,
  type AgentsConfig,
} from '@brigadir/contracts';
import type {
  AgentExecutor,
  ExecutorResult,
  ExecutorType,
  RunContext,
} from '../agent-executor.interface';
import { openExecutorSecrets } from '../executor-secrets';
import { openEnvSecrets, type EnvSecretsDocument } from '../env-secrets';
import { assembleRunUserEnv, applyUserEnv } from '../user-env';
import {
  resolveClaudeCliConfig,
  resolveEffectiveAuth,
  applyAuthEnv,
  applyProviderEnv,
  API_KEY_ONLY_PROVIDER_LABELS,
  DEFAULT_REPO_RUN_ALLOWED_TOOLS,
  type ClaudeCliExecutorConfigInput,
  type EffectiveAuth,
  type ProviderPreset,
} from './claude-cli.config';
import { buildArgs } from './args';
import { resolveCostUsd } from './provider-pricing';
import { buildChildEnv } from './env-allowlist';
import { makeScrub } from '@brigadir/scrubber';
import { SecretBoxError } from '@brigadir/jira';
import { ClaudeStreamParser, type TerminalResult } from './stream-parser';
import {
  prepareAll,
  cleanupAll,
  ensureCaches,
  branchExistsOnOrigin,
  BlockerMergeConflictError,
  type WorktreeRepo,
  type MultiPrepareResult,
} from './worktree';
import { spawnGroup } from './process-group';
import {
  narrowByTicketComponents,
  RepositoryScopeUndeterminableError,
  type NarrowResult,
} from './scope-ticket';
import { buildWrapperText, type LinkedTicketEntry, type WrapperVerifiedGates } from './wrapper';
import { writeMcpConfig, resolveMcpConfigRoot, type WrittenMcpConfig } from './mcp-config';
import { resolveMcpServerEntryPath } from './mcp-server-path';
import { buildFeatureContextSection } from './feature-context';
import {
  getPriorWork,
  matchReportedBranches,
  getBlockerWork,
  buildStartPlan,
  type PriorWork,
  type BranchMatch,
  type StartPlan,
} from './prior-work';
import {
  blockerBranchLostTask,
  blockerMergeConflictTask,
  blockerRepoUnmountedTask,
  type BlockerTask,
} from './blocker-tasks';

const STDERR_TAIL_BYTES = 16 * 1024;

/** A blocker branch that dropped out of the plan, and the blocker's live status. */
interface DroppedBlocker {
  key: string;
  /** Null when the blocker produced nothing at all (no ticket row / no report). */
  repo: string | null;
  branch: string | null;
  /** `"<name>|<category>"` from the live fetch; undefined if Jira did not return the key. */
  status: string | undefined;
}

/** What a run inherited from its blockers (feature 032), consumed by prepare + wrapper. */
interface InheritanceResult {
  /** Own continue-branches merged with the blocker-sourced start branches. */
  continueBranches: Record<string, string>;
  /** Extra blocker branches to merge, per repo (diamonds only). */
  mergeBranches: Record<string, string[]>;
  plan: StartPlan;
  dropped: DroppedBlocker[];
  unmountedReported: StartPlan['unmounted'];
  /** The `## Linked tickets` view-model for the wrapper. */
  linkedTickets: LinkedTicketEntry[];
}

/**
 * DI token for the harness's provider preset (feature 025). The bare class
 * provider resolves it as absent (`@Optional`) and defaults to the
 * `claude_cli` preset — byte-identical pre-025 behavior; the `kimi` instance
 * is built by an explicit factory in ExecutorsModule with the Moonshot preset.
 */
export const CLAUDE_CLI_PROVIDER_PRESET = Symbol('CLAUDE_CLI_PROVIDER_PRESET');

/**
 * Which repository NAMES a run asks for (feature 019, research D1). The
 * executor is platform capacity and carries no repository (2026-07-13) —
 * the choice is the AGENT's:
 *   `behavior.repositories` (non-empty) > deprecated `behavior.repository`
 *   (one-element list) > [] = ALL workspace repositories.
 * Non-string junk degrades to the all-repos default, never crashes.
 * Pure — unit-tested directly.
 */
export function resolveRepositoryNames(behavior: {
  repository?: unknown;
  repositories?: unknown;
}): string[] {
  if (Array.isArray(behavior.repositories)) {
    const names = behavior.repositories.filter(
      (n): n is string => typeof n === 'string' && n.length > 0,
    );
    if (names.length > 0) return names;
  }
  return typeof behavior.repository === 'string' && behavior.repository.length > 0
    ? [behavior.repository]
    : [];
}

/**
 * Repository source of truth (feature 005): workspace settings.repositories
 * (what the wizard/settings screen writes — DB wins) beats the legacy
 * agents.yaml workspace.repositories[], kept as fallback for yaml-imported
 * setups whose settings blob predates the wizard. Feature 019 (research D1):
 * `names` is a FILTER over the winning list — empty = ALL repositories, in
 * workspace declaration order (the agent's list selects, the workspace
 * orders); an unknown name fails loud (defense-in-depth behind config-time
 * validation). Pure — unit-tested directly.
 */
export function pickWorkspaceRepositories(
  dbRepos: { name: string; git_url: string; default_branch: string }[],
  yamlRepos: { name: string; url: string; default_branch: string }[],
  names: string[],
  yamlLoaded: boolean,
): WorktreeRepo[] {
  if (dbRepos.length > 0) {
    for (const name of names) {
      if (!dbRepos.some((r) => r.name === name)) {
        throw new Error(
          `workspace has no repository named "${name}" in settings.repositories (linter should have caught this)`,
        );
      }
    }
    const selected = names.length > 0 ? dbRepos.filter((r) => names.includes(r.name)) : dbRepos;
    return selected.map((r) => ({ name: r.name, url: r.git_url, defaultBranch: r.default_branch }));
  }

  for (const name of names) {
    if (!yamlRepos.some((r) => r.name === name)) {
      throw new Error(
        `no repository "${name}" found: workspace settings has no repositories and ` +
          (yamlLoaded ? 'agents.yaml does not define it either' : 'no agents.yaml is loaded'),
      );
    }
  }
  const selected = names.length > 0 ? yamlRepos.filter((r) => names.includes(r.name)) : yamlRepos;
  if (selected.length === 0) {
    throw new Error(
      `no repository "(default)" found: workspace settings has no repositories and ` +
        (yamlLoaded ? 'agents.yaml does not define it either' : 'no agents.yaml is loaded'),
    );
  }
  return selected.map((r) => ({ name: r.name, url: r.url, defaultBranch: r.default_branch }));
}

class StderrTail {
  private buf = '';

  push(chunk: Buffer | string): void {
    this.buf += chunk.toString();
    if (this.buf.length > STDERR_TAIL_BYTES) {
      this.buf = this.buf.slice(this.buf.length - STDERR_TAIL_BYTES);
    }
  }

  get text(): string {
    return this.buf;
  }
}

/**
 * Feature 032: the `## Linked tickets` view-model — one entry per DIRECT
 * blocker, in key order, from data prepare already has (the batched status
 * fetch and the blockers' reports). No extra Jira call.
 *
 * A blocker with no usable report still gets a line: "this ticket is chained to
 * that one" is useful context on its own, and the missing branch is already
 * being surfaced through the timeline and the human queue.
 */
function buildLinkedTickets(
  keys: string[],
  found: { key: string; entries: { branch?: string; pr_url?: string }[] }[],
  statuses: Map<string, string>,
): LinkedTicketEntry[] {
  const workByKey = new Map(found.map((f) => [f.key, f]));
  return [...keys].sort().map((key) => {
    const entry = workByKey.get(key)?.entries.find((e) => e.branch);
    return {
      key,
      status: (statuses.get(key) ?? '').split('|')[0] || 'unknown',
      ...(entry?.branch ? { branch: entry.branch } : {}),
      ...(entry?.pr_url ? { prUrl: entry.pr_url } : {}),
    };
  });
}

/** Was this outcome one a human should be able to inspect the worktree for? */
function runFailed(result: ExecutorResult): boolean {
  if (result.exitStatus !== 'completed') return true;
  const report = result.report as { outcome?: string } | undefined;
  return !report || report.outcome !== 'success';
}

/**
 * ClaudeCliExecutor (T082) — the first real `AgentExecutor`. Spawns one
 * headless `claude -p` per run inside a dedicated git worktree, drives it on
 * the operator's Claude subscription, and extracts a `ReportSchema`-valid
 * report via `--json-schema`/`structured_output` (research D1 — no
 * `result.result`-text fallback exists, by design).
 *
 * `RunContext` (frozen, FR-001) carries only the generic run shape; the
 * claude_cli-specific instance config (model/cliPath/allowedTools/
 * worktree roots/kill+cancel timing) has no home there, so this executor
 * looks it up itself via `ctx.runId` — the same DB-lookup pattern
 * `MockExecutor` already uses for its scenario. The repository NAME comes from
 * `agents.behavior.repository` (else the workspace default); workspace
 * settings — or legacy `AGENTS_CONFIG` — resolve it to an actual git URL.
 */
@Injectable()
export class ClaudeCliExecutor implements AgentExecutor {
  /**
   * Feature 025: the type comes from the provider preset — the SAME class
   * serves `claude_cli` (no endpoint override) and `kimi` (Moonshot base URL),
   * registered as two DI instances. Absent preset ⇒ `claude_cli`.
   */
  readonly type: ExecutorType;
  private readonly preset: ProviderPreset;
  private readonly logger = new Logger(ClaudeCliExecutor.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: BrigadirDb,
    // Feature 005: AGENTS_CONFIG is optional (null on a DB-only boot). The
    // claude_cli executor still resolves its repository from the yaml at
    // run-time (DB-authoritative repo config is future work); a run with no
    // yaml throws a clear error rather than crashing at boot.
    @Inject(AGENTS_CONFIG) private readonly agentsConfig: AgentsConfig | null,
    @Inject(JIRA_CLIENT) private readonly jira: JiraClient,
    @Optional() @Inject(CLAUDE_CLI_PROVIDER_PRESET) preset?: ProviderPreset,
  ) {
    this.preset = preset ?? { type: 'claude_cli' };
    this.type = this.preset.type;
  }

  async run(ctx: RunContext, signal: AbortSignal): Promise<ExecutorResult> {
    const {
      runtimeConfig,
      repos,
      excludedRepos,
      workspaceId,
      ticketId,
      preferRunId,
      auth,
      apiKey,
      noRepo,
      setupRun,
      userEnv,
      envSecretValues,
    } = await this.loadRunConfig(ctx);

    // The run's workspace dir: the parent `worktreeRoot/<runId>` holding one
    // worktree per repo (feature 019, research D3), or a scratch temp dir for
    // no-repo runs. `workspace` stays null exactly for the scratch case.
    let workspaceDir: string;
    let workspace: MultiPrepareResult | null = null;
    // Feature 032: what this run inherited from its blockers. Declared out here
    // so the wrapper (below) and the merge-conflict handler (in the catch) can
    // both see it. Null for no-repo, ticketless, and blocker-free runs.
    let inherit: InheritanceResult | null = null;
    // Feature 033: the ticket's verification receipt, resolved against the
    // prepared worktrees. Undefined unless every mounted repo matched.
    let verifiedGates: WrapperVerifiedGates | undefined;
    if (noRepo) {
      // feature 010 (FR-018, Constitution V): a no-repository run (the
      // orchestrator's triage) runs from a scratch temp dir — no clone, no
      // worktree, no git credentials in reach. It reads only the system's own
      // run history (via the handoff section already assembled into the prompt).
      try {
        workspaceDir = await mkdtemp(join(tmpdir(), 'brigadir-orch-'));
      } catch (err) {
        return { exitStatus: 'crashed', diagnostics: err instanceof Error ? err.message : String(err) };
      }
      // No `worktree_path` persisted — there is no repository worktree to inspect.
    } else {
      // The system no longer creates OR names branches (feature 023 + 024) —
      // it only picks the commit each repo starts from; the agent creates and
      // reports its own branch. A repo run must be ticket-bound OR a
      // workspace-setup run (feature 015, FR-020, ticketless by design); any
      // other ticketless repo run is a config error.
      if (!ctx.ticket && !setupRun) {
        return {
          exitStatus: 'crashed',
          diagnostics: 'ticketless run requires a no-repository agent (workspace_mode: none)',
        };
      }
      try {
        // Where the previous stage on this ticket left the code. Deliberately
        // NOT best-effort: a failed read means we cannot tell whether prior
        // work exists, and silently starting from the default branch is the
        // false-success mode this feature exists to prevent. Setup runs are
        // ticketless — there is no chain to continue.
        let prior: PriorWork | undefined;
        let matched: BranchMatch = { continueBranches: {}, unmatched: [] };
        if (ctx.ticket && ticketId) {
          prior = await getPriorWork(this.db, {
            ticketId,
            currentRunId: ctx.runId,
            preferRunId,
          });
          matched = prior
            ? matchReportedBranches(prior.entries, repos)
            : { continueBranches: {}, unmatched: [] };
        }

        // Feature 032: caches are ensured FIRST (their `fetch --prune` is what
        // makes the origin probes below truthful), then the blockers' work is
        // resolved against them, and only then are worktrees added.
        const caches = await ensureCaches(repos, runtimeConfig.repoCacheRoot);
        inherit = await this.resolveInheritance({
          ctx,
          ticketId,
          workspaceId,
          repos,
          caches,
          own: matched,
        });

        workspace = await prepareAll(
          repos,
          ctx.runId,
          runtimeConfig.worktreeRoot,
          runtimeConfig.repoCacheRoot,
          {
            continueBranches: inherit.continueBranches,
            mergeBranches: inherit.mergeBranches,
            caches,
          },
        );
        // Feature 024: record start-ref events AFTER prepare, so each carries
        // the resolved startSha (the gate baseline). A prepare that throws
        // above writes no rows — such a run fails loudly before an agent
        // starts and hands nothing off.
        if (ctx.ticket && ticketId) {
          await this.recordStartRefEvent(ctx.runId, workspace.repos, prior, matched, inherit);
          // Feature 033: receipts exist only on the callback channel (the
          // complete path writes them from measured observed heads).
          if (runtimeConfig.useCallbackChannel) {
            verifiedGates = await this.resolveVerificationReceipt(ctx.runId, ticketId, workspace.repos);
          }
        }
      } catch (err) {
        // Feature 032: a diamond whose blocker branches conflict is not a
        // generic prepare fault — it is a specific, actionable human case, and
        // the run must not just die with a git message nobody can act on.
        if (err instanceof BlockerMergeConflictError && ctx.ticket && ticketId) {
          await this.raiseBlockerTask(
            workspaceId,
            ticketId,
            blockerMergeConflictTask({
              ticketKey: ctx.ticket.key,
              repo: err.repoName,
              startBranch: err.startRef.replace(/^origin\//, ''),
              mergeBranches: err.mergeBranches,
              blockerKeys: inherit?.plan.repos[err.repoName]?.blockers.map((b) => b.key) ?? [],
            }),
          );
        }
        return { exitStatus: 'crashed', diagnostics: err instanceof Error ? err.message : String(err) };
      }
      workspaceDir = workspace.parentDir;

      // Points at the PARENT dir — inspecting a kept failed workspace shows
      // every repo worktree plus .brigadir/ (feature 019, spec FR-005).
      await this.db
        .update(schema.runs)
        .set({ worktreePath: workspaceDir })
        .where(eq(schema.runs.id, ctx.runId));
    }

    let mcpConfig: WrittenMcpConfig | undefined;
    try {
      if (runtimeConfig.useCallbackChannel) {
        mcpConfig = await writeMcpConfig(
          {
            runId: ctx.runId,
            callbackUrl: ctx.callback.httpBaseUrl,
            runToken: ctx.callback.runToken,
            mcpServerEntryPath: resolveMcpServerEntryPath(),
            // Feature 024: the gate observes these worktrees' HEADs at
            // complete_task. Empty for no-repo runs (workspace is null).
            repoDirs: Object.fromEntries(
              (workspace?.repos ?? []).map((r) => [r.repo.name, r.worktreeDir]),
            ),
          },
          resolveMcpConfigRoot(),
        );
      }

      // Feature context needs a ticket to anchor on — skipped for setup runs.
      const featureContextSection =
        runtimeConfig.useCallbackChannel && ctx.ticket
          ? await buildFeatureContextSection({ jira: this.jira, db: this.db }, ctx.ticket.key, workspaceId)
          : undefined;

      await mkdir(join(workspaceDir, '.brigadir'), { recursive: true });
      await writeFile(
        join(workspaceDir, '.brigadir', 'wrapper.txt'),
        buildWrapperText(ctx, workspaceDir, {
          useCallbackChannel: runtimeConfig.useCallbackChannel,
          featureContextSection,
          repos: workspace?.repos.map((r) => {
            const repoPlan = inherit?.plan.repos[r.repo.name];
            const blockers = repoPlan?.source === 'blocker' ? repoPlan.blockers : [];
            const merged = r.start.mergedBranches ?? [];
            return {
              name: r.repo.name,
              absPath: r.worktreeDir,
              defaultBranch: r.repo.defaultBranch,
              continueBranch: r.start.continueBranch,
              // Feature 032: state the provenance so the agent knows whether
              // this branch is ITS chain's work or a dependency it merely reads.
              provenance:
                blockers.length > 0 && merged.length > 0
                  ? ('merged_blockers' as const)
                  : blockers.length > 0
                    ? ('inherited_blocker' as const)
                    : r.start.continueBranch
                      ? ('continue_own' as const)
                      : ('default' as const),
              ...(blockers.length > 0 ? { blockerKey: blockers[0].key } : {}),
              ...(merged.length > 0
                ? { mergedFrom: blockers.map((b) => ({ key: b.key, branch: b.branch })) }
                : {}),
            };
          }),
          // Feature 020 (D4): non-empty only for ticket-narrowed runs.
          onDemandRepos: excludedRepos.map((r) => ({ name: r.name, url: r.url })),
          // Feature 032: the direct blockers, from data already fetched during
          // prepare — this adds no Jira call of its own.
          linkedTickets: inherit?.linkedTickets ?? [],
          // Feature 033: gates already verified at this exact workspace state.
          verifiedGates,
        }),
      );
    } catch (err) {
      await mcpConfig?.cleanup();
      await this.cleanupWorkspace(workspace, workspaceDir, runtimeConfig.keepFailedWorktrees, ctx.runId);
      return { exitStatus: 'crashed', diagnostics: err instanceof Error ? err.message : String(err) };
    }

    const result = await this.runProcess(
      ctx,
      signal,
      workspaceDir,
      runtimeConfig,
      mcpConfig,
      auth,
      apiKey,
      userEnv,
      envSecretValues,
    );

    try {
      await mcpConfig?.cleanup();
    } catch (err) {
      this.logger.error(`mcp-config cleanup failed for run ${ctx.runId}: ${String(err)}`);
    }

    await this.cleanupWorkspace(
      workspace,
      workspaceDir,
      runtimeConfig.keepFailedWorktrees && runFailed(result),
      ctx.runId,
    );

    return result;
  }

  /**
   * Tear down the run's workspace: every per-repo worktree + the parent dir
   * (repo runs — feature 019), or the scratch temp dir (no-repo orchestrator
   * runs — feature 010; `workspace` is null there). `keep` retains the WHOLE
   * parent for failed-run inspection. Best-effort; a cleanup fault is logged,
   * never fatal.
   */
  private async cleanupWorkspace(
    workspace: MultiPrepareResult | null,
    workspaceDir: string,
    keep: boolean,
    runId: string,
  ): Promise<void> {
    try {
      if (workspace === null) {
        // No git worktrees to prune — just remove the scratch dir.
        if (!keep) await rm(workspaceDir, { recursive: true, force: true });
      } else {
        await cleanupAll(workspace, { keep });
      }
    } catch (err) {
      this.logger.error(`workspace cleanup failed for run ${runId}: ${String(err)}`);
    }
  }

  private runProcess(
    ctx: RunContext,
    signal: AbortSignal,
    workspaceDir: string,
    runtimeConfig: ReturnType<typeof resolveClaudeCliConfig>,
    mcpConfig: WrittenMcpConfig | undefined,
    auth: EffectiveAuth,
    apiKey: string | undefined,
    userEnv: Record<string, string>,
    envSecretValues: string[],
  ): Promise<ExecutorResult> {
    const argv = buildArgs({
      model: runtimeConfig.model,
      worktreeDir: workspaceDir,
      allowedTools: runtimeConfig.allowedTools,
      maxTurns: ctx.limits.maxTurns ?? runtimeConfig.maxTurns,
      maxBudgetUsd: ctx.limits.maxBudgetUsd,
      useCallbackChannel: runtimeConfig.useCallbackChannel,
      mcpConfigPath: mcpConfig?.configPath,
      stopHookSettingsJson: mcpConfig?.settingsJson,
    });
    const env = buildChildEnv(process.env);
    // Feature 031: inject operator env AFTER the allowlist floor and BEFORE the
    // platform's own auth/provider injection — so platform-managed keys always
    // win and `ALLOWLIST_KEYS` is never widened. applyUserEnv drops any
    // reserved key defensively (write surfaces already reject them) and returns
    // the dropped list for a diagnostic.
    const droppedReserved = applyUserEnv(env, userEnv);
    if (droppedReserved.length > 0) {
      this.logger.warn(
        `run ${ctx.runId}: dropped ${droppedReserved.length} reserved env key(s) from operator config: ${droppedReserved.join(', ')}`,
      );
    }
    // Per-profile auth injection (feature 018; api_key mode since 2026-07-14):
    // DELIBERATE additions of the profile's own values AFTER the allowlist
    // pass — the HOST's ANTHROPIC_API_KEY / AWS_* / CLAUDE_CODE_USE_BEDROCK /
    // NODE_EXTRA_CA_CERTS still can never leak through (none are allowlisted).
    applyAuthEnv(env, auth, apiKey);
    // Provider-endpoint injection (feature 025): a no-op for the claude_cli
    // preset; the kimi preset points the CLI at Moonshot. Same discipline —
    // the host's ANTHROPIC_BASE_URL is not allowlisted and never passes.
    applyProviderEnv(env, this.preset);
    const group = spawnGroup(runtimeConfig.cliPath, argv, { cwd: workspaceDir, env });

    // D7: `claude -p` REQUIRES a prompt on stdin (never argv — size/secrets).
    // The full task (ticket + agent instruction + rules) already rides the
    // --append-system-prompt-file wrapper; stdin carries the kick-off USER
    // message. Missing this write was live incident #4 of 2026-07-14: the CLI
    // waits 3s for stdin, then exits 1 ("Input must be provided..."), while
    // the fake-claude harness never read stdin — green tests, dead runs.
    group.child.stdin?.on('error', () => {
      /* child may exit before/while we write (EPIPE) — the close handler owns the outcome */
    });
    group.child.stdin?.end(
      ctx.ticket
        ? `Work Jira ticket ${ctx.ticket.key} exactly as described in your system prompt. Begin now.\n`
        : 'Carry out the workspace task exactly as described in your system prompt. Begin now.\n',
    );

    // feature 026 (Constitution V): scrub every tool_call string the parser
    // persists, including strings nested in a complete_task report.
    // feature 031: a run-scoped scrubber ALSO redacts this run's secret env
    // VALUES — a short/low-entropy secret the global scrubber would miss must
    // never surface in run events, reports, or diagnostics (FR-007). No secret
    // env ⇒ `makeScrub` returns the plain global `scrub` (zero overhead).
    const runScrub = makeScrub(envSecretValues);
    const parser = new ClaudeStreamParser({ scrub: runScrub });
    const stderrTail = new StderrTail();
    let externalRef: string | undefined;
    let terminal: TerminalResult | undefined;
    let rateLimited: { retryDelayMs?: number; attempt?: number } | undefined;

    return new Promise<ExecutorResult>((resolvePromise) => {
      let settled = false;
      // Set synchronously by `onAbort`, read by the `close` handler — the
      // single authoritative place that resolves this promise. Deciding the
      // outcome only in `close` (never racing an async `.then()` against it)
      // avoids a real race: `terminate()`'s underlying process 'exit'/'close'
      // events can interleave with its own promise resolution in either
      // order, so two independent "resolve the run" call sites would race.
      let abortReason: 'timeout' | 'cancelled' | undefined;

      const settle = (result: ExecutorResult): void => {
        if (settled) return;
        settled = true;
        resolvePromise(result);
      };

      // Tracks the in-flight insert of the *most recent* run_event so the
      // rate_limited branch can await the specific api_retry row (carrying
      // retry_delay_ms — the processor's requeue TTL, D5) before settling,
      // instead of racing a fire-and-forget insert against the caller.
      let lastPersist: Promise<unknown> = Promise.resolve();
      const persistRunEvent = (type: string, payload: Record<string, unknown>): Promise<unknown> => {
        const p = this.db
          .insert(schema.runEvents)
          .values({ runId: ctx.runId, type, payload })
          .catch((err) => this.logger.error(`failed to persist run_event for ${ctx.runId}: ${String(err)}`));
        lastPersist = p;
        return p;
      };

      const rl = createInterface({ input: group.child.stdout! });
      rl.on('line', (line) => {
        for (const parsed of parser.parseLine(line)) {
          switch (parsed.kind) {
            case 'run_event':
              persistRunEvent(parsed.event.type, parsed.event.payload);
              break;
            case 'external_ref':
              externalRef = parsed.sessionId;
              break;
            case 'terminal':
              terminal = parsed.result;
              break;
            case 'rate_limit':
              rateLimited = { retryDelayMs: parsed.retryDelayMs, attempt: parsed.attempt };
              // D5: don't wait out a subscription window inside a worker slot.
              void group.terminate(runtimeConfig.killGraceMs);
              break;
          }
        }
      });

      group.child.stderr?.on('data', (chunk: Buffer) => stderrTail.push(chunk));

      const onAbort = (): void => {
        abortReason = signal.reason === 'cancelled' ? 'cancelled' : 'timeout';
        void group.terminate(runtimeConfig.killGraceMs);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();

      group.child.once('error', (err) => {
        settle({ exitStatus: 'crashed', externalRef, diagnostics: `failed to spawn claude: ${err.message}` });
      });

      const handleClose = async (code: number | null): Promise<void> => {
        signal.removeEventListener('abort', onAbort);

        // The CLI prices total_cost_usd at ANTHROPIC rates regardless of the
        // provider endpoint; for presets with their own price table (deepseek)
        // the run's cost is recomputed from token usage. Everywhere below uses
        // THIS number — including the budget ceiling — never the raw CLI one.
        const costUsd = resolveCostUsd(this.preset.type, runtimeConfig.model, terminal);

        // Outcome precedence: cancelled > rate_limited > timeout (incident
        // 2026-07-19). A user cancel is authoritative over everything. But a
        // rate_limit we already parsed must outrank a LATE watchdog `timeout`:
        // when terminate() outlives its grace (a wedged or setsid-escaped
        // child), the run can linger until the processor aborts with
        // 'timeout'. Reporting that as timed_out burns the attempt on a
        // subscription limit the run should have been parked+requeued for.
        if (abortReason === 'cancelled') {
          // The cancel-poll aborts a lingering process AFTER a callback
          // finalize/park flipped the run off 'running' — exactly the path
          // where a terminal event parsed before the kill carries the run's
          // only cost/usage data. handleClose runs after 'close', so
          // `terminal` holds whatever the parser captured; don't drop it.
          settle({
            exitStatus: 'cancelled',
            externalRef,
            costUsd,
            usage: terminal?.usage,
            diagnostics: 'run cancelled',
          });
          return;
        }

        if (rateLimited) {
          // Guarantee the api_retry row (retry_delay_ms) is visible to the
          // processor's DB read before we hand back rate_limited.
          await lastPersist;
          settle({
            exitStatus: 'rate_limited',
            externalRef,
            costUsd,
            usage: terminal?.usage,
            diagnostics: 'subscription rate limit hit — retry later, attempt not spent',
          });
          return;
        }

        if (abortReason === 'timeout') {
          // Problem 5 (incident 2026-07-19): a timed_out run otherwise discards
          // the last thing the CLI / MCP server wrote to stderr — the one place
          // the cause is visible. Persist the (already ≤16 KB) tail as an
          // `error` run_event so a timeout is diagnosable. cancelled/rate_limited
          // are handled above and keep their existing paths.
          if (stderrTail.text.length > 0) {
            await persistRunEvent('error', {
              source: 'stderr-tail',
              reason: 'timeout',
              // feature 031: scrub secret env values a service may have logged.
              stderr: runScrub(stderrTail.text),
            });
          }
          settle({
            exitStatus: 'timeout',
            externalRef,
            costUsd,
            usage: terminal?.usage,
            diagnostics: 'run timeout',
          });
          return;
        }

        if (terminal) {
          // D11 (REVISED ×2): only the terminal event ever carries cost data;
          // enforce the ceiling here as a post-hoc verification of the CLI's
          // own --max-budget-usd self-stop. The ceiling compares the PROVIDER
          // cost (provider-pricing.ts) — for the deepseek preset the CLI's
          // Anthropic-priced self-stop still fires ~30× early, which is
          // conservative, but this check must not crash a run whose real
          // spend is under the budget.
          if (
            ctx.limits.maxBudgetUsd !== undefined &&
            costUsd !== undefined &&
            costUsd > ctx.limits.maxBudgetUsd
          ) {
            settle({
              exitStatus: 'crashed',
              externalRef,
              costUsd,
              usage: terminal.usage,
              diagnostics: `budget exceeded: cost_usd=${costUsd} > max_budget_usd=${ctx.limits.maxBudgetUsd}`,
            });
            return;
          }

          // Callback-wired runs never carry structured_output on the terminal
          // event — `--json-schema` is deliberately not passed (args.ts, FR-011:
          // exactly one live completion channel). Parsing it here would ALWAYS
          // fail and its "no schema-valid structured_output" message would
          // shadow the processor's accurate fail-closed diagnostic ("exited
          // without a complete_task or request_human callback") — the SXF-1174
          // Problem 7 red herring. Settle with no diagnostics; the processor
          // decides via outbox/DB state what actually happened.
          if (runtimeConfig.useCallbackChannel) {
            settle({
              exitStatus: 'completed',
              externalRef,
              costUsd,
              usage: terminal.usage,
            });
            return;
          }

          const parsedReport = ReportSchema.safeParse(terminal.structuredOutput);
          if (parsedReport.success) {
            settle({
              exitStatus: 'completed',
              externalRef,
              costUsd,
              usage: terminal.usage,
              report: parsedReport.data,
            });
          } else {
            settle({
              exitStatus: 'completed',
              externalRef,
              costUsd,
              usage: terminal.usage,
              diagnostics: `no schema-valid structured_output: ${parsedReport.error.message}`,
            });
          }
          return;
        }

        // No terminal `result` event ever arrived: nonzero/unexpected exit.
        // feature 031: scrub secret env values a service may have logged.
        const tail = runScrub(stderrTail.text);
        settle({
          exitStatus: 'crashed',
          externalRef,
          diagnostics: `claude exited (code=${code ?? 'null'}) without a result event${tail ? `: ${tail}` : ''}`,
        });
      };

      group.child.once('close', (code) => {
        void handleClose(code);
      });
    });
  }

  private async loadRunConfig(ctx: RunContext): Promise<{
    runtimeConfig: ReturnType<typeof resolveClaudeCliConfig>;
    repos: WorktreeRepo[];
    /** Feature 020 (D4): base-set repos excluded by ticket-component narrowing — wrapper escape hatch. */
    excludedRepos: WorktreeRepo[];
    workspaceId: string;
    /** Feature 023: anchors the "prior work on this ticket" lookup. Null for ticketless runs. */
    ticketId: string | null;
    /** Feature 023: the run a rework / human-resume / triage handoff names, if any. */
    preferRunId: string | undefined;
    auth: EffectiveAuth;
    apiKey: string | undefined;
    noRepo: boolean;
    setupRun: boolean;
    /** Feature 031: merged operator env to inject (empty for no-repo runs). */
    userEnv: Record<string, string>;
    /** Feature 031: secret env VALUES in this run, for the run-scoped scrubber. */
    envSecretValues: string[];
  }> {
    const runId = ctx.runId;
    const [row] = await this.db
      .select({
        executorConfig: schema.executors.config,
        executorName: schema.executors.name,
        executorSecrets: schema.executors.secrets,
        behavior: schema.agents.behavior,
        agentId: schema.runs.agentId,
        workspaceId: schema.runs.workspaceId,
        ticketId: schema.runs.ticketId,
        triggerEvent: schema.runs.triggerEvent,
      })
      .from(schema.runs)
      .innerJoin(schema.agents, eq(schema.runs.agentId, schema.agents.id))
      .innerJoin(schema.executors, eq(schema.agents.executorId, schema.executors.id))
      .where(eq(schema.runs.id, runId))
      .limit(1);

    if (!row) {
      throw new Error(`run ${runId} not found while resolving ${this.type} config`);
    }

    // feature 015 (FR-013, D8): a workspace-setup run resolves its environment
    // from the LIVE brigadir template's `setup` execution profile — capable
    // model, larger turn budget, repo-mounted — instead of the agent's own
    // cheap triage profile. Every other source stays byte-identical.
    const setupRun =
      (row.triggerEvent as { source?: string } | null)?.source === 'workspace-setup';

    let rawConfig = row.executorConfig as ClaudeCliExecutorConfigInput;
    let executorName = row.executorName;
    let executorSecrets = row.executorSecrets;
    let behavior = (row.behavior ?? {}) as {
      allowed_tools?: string[];
      repository?: string;
      repositories?: string[];
      workspace_mode?: string;
      // Feature 031: non-secret per-agent env override (highest operator layer).
      env?: Record<string, string>;
    };

    if (setupRun) {
      const template = await getBrigadirAgentTemplate(this.db);
      const profile = await this.resolveSetupProfile(runId, template.setup.executor);
      rawConfig = profile.config as ClaudeCliExecutorConfigInput;
      executorName = profile.name;
      executorSecrets = profile.secrets;
      behavior = template.setup.behavior as typeof behavior;
    }

    // feature 010 (FR-018): the orchestrator's TRIAGE runs have NO repository
    // workspace; feature 015 narrowed the rule to triage — setup behavior
    // defaults to repo-mounted (no workspace_mode: 'none').
    let noRepo = behavior.workspace_mode === 'none';
    // Named runner profiles (2026-07-14): the PROFILE's model is the single
    // source of truth — resolveClaudeCliConfig reads it from the executor
    // config only, so a legacy `behavior.model` on the agent is ignored here
    // unconditionally (no data migration; live agent "TEST" keeps working).
    const runtimeConfig = resolveClaudeCliConfig(rawConfig, behavior.allowed_tools ?? []);

    // Platform-scoped executors (2026-07-13): the repository set is the
    // AGENT's choice (behavior.repositories / deprecated behavior.repository),
    // else ALL of the run workspace's repositories (feature 019, research D1).
    // A no-repository run resolves none (skips clone/worktree entirely).
    let repos: WorktreeRepo[] = [];
    let excludedRepos: WorktreeRepo[] = [];
    if (!noRepo) {
      if (setupRun) {
        // feature 015 (FR-017): a workspace with no repositories degrades to
        // the repo-less scratch path — the setup protocol's recon branch is
        // best-effort and bounded; the run must proceed either way.
        // Feature 019 (research D5): setup runs deliberately KEEP a
        // one-element scope (the resolved default / template-named repo) —
        // the setup protocol self-clones extras into .repos/<name>; the
        // all-repos default does not apply here.
        try {
          repos = (await this.resolveRepositories(row.workspaceId, resolveRepositoryNames(behavior))).repos.slice(0, 1);
        } catch (err) {
          this.logger.warn(
            `setup run ${runId}: no repository available (${String(err)}) — proceeding without one (FR-017)`,
          );
          noRepo = true;
        }
      } else {
        const resolved = await this.resolveRepositories(row.workspaceId, resolveRepositoryNames(behavior));
        // Feature 020: ticket Components narrow the base set (D1/D2/D3, gated
        // per workspace by settings.ticket_scoping — D2b). Ticketless runs are
        // exempt (FR-014); setup runs never reach this branch (D5). The gate
        // runs BEFORE prepareAll, so a parked/failed scope costs no clone work.
        const scopingEnabled = resolved.ticketScoping && ctx.ticket !== null;
        const narrowed = narrowByTicketComponents({
          baseRepos: resolved.repos,
          components: ctx.ticket?.components ?? null,
          workspaceRepoNames: resolved.workspaceRepoNames,
          scopingEnabled,
        });
        if (scopingEnabled && ctx.ticket) {
          await this.recordScopingEvent(runId, narrowed);
          if (narrowed.kind === 'undeterminable') {
            throw new RepositoryScopeUndeterminableError(
              narrowed.case,
              {
                ticketKey: ctx.ticket.key,
                components: ctx.ticket.components ?? [],
                agentRepoNames: resolved.repos.map((r) => r.name),
                workspaceRepoNames: resolved.workspaceRepoNames,
              },
              narrowed.decision,
            );
          }
          if (narrowed.kind === 'components_unreadable') {
            // R5: components are UNKNOWN (Jira fetch failed), not absent —
            // fail closed rather than park with a misleading question or
            // silently clone the full set.
            throw new Error(
              `ticket ${ctx.ticket.key}: components could not be read from Jira while ticket scoping is enabled — failing closed (feature 020)`,
            );
          }
        }
        // This is the ONLY thing that decides which repositories a run mounts:
        // the agent's base set, narrowed by the ticket's Components. Feature
        // 032's branch inheritance reads this set and never adds to it (FR-010)
        // — a blocker with work in an unmounted repository produces a
        // `blocker_artifacts_unmounted` event and a human task, not a surprise
        // extra clone with credentials the ticket's scope never granted.
        repos = narrowed.kind === 'resolved' ? narrowed.repos : resolved.repos;
        // D4: what narrowing left out stays reachable via the wrapper's
        // on-demand `.repos/<name>` note (empty for non-narrowed runs).
        excludedRepos = resolved.repos.filter((r) => !repos.includes(r));
      }
    }

    // ST3-768: an empty allowlist on a repo-mounted run is a config gap, never
    // an intent — dontAsk auto-denies every mutating tool, so the run could
    // read the repo but never write/commit/push (generated teams carry
    // `behavior: {}` and the seeded `claude` profile declares no allowedTools).
    // Applied AFTER repo resolution so a setup run degraded to the scratch
    // no-repo path (FR-017) stays as locked-down as a triage run.
    if (!noRepo && runtimeConfig.allowedTools.length === 0) {
      runtimeConfig.allowedTools = [...DEFAULT_REPO_RUN_ALLOWED_TOOLS];
    }

    // Feature 018: effective auth mode — stored `auth` wins, else the legacy
    // defaulting (stored key → api_key, none → host_subscription). Legacy
    // rows land exactly where pre-018 behavior did.
    // Features 025/028: the api_key-only presets (kimi, deepseek_api —
    // membership is the shared API_KEY_ONLY_EXECUTOR_TYPES set, FR-016) have
    // no subscription or cloud-credential fallback against their provider, so
    // a keyless profile fails fast here (normal failed-run path) instead of
    // sliding into host_subscription via the defaulting chain.
    let auth: EffectiveAuth;
    if (isApiKeyOnlyExecutorType(this.preset.type)) {
      if (executorSecrets == null) {
        throw new Error(
          `${this.preset.type} executor profile "${executorName}" has no stored API key — re-enter the ${API_KEY_ONLY_PROVIDER_LABELS[this.preset.type] ?? this.preset.type} key in the profile`,
        );
      }
      auth = { mode: 'api_key' };
    } else {
      auth = resolveEffectiveAuth(rawConfig, executorSecrets != null);
    }

    // Profile API key (write-only at the API; only the runtime opens it) —
    // decrypted ONLY when the effective mode is api_key. There a blob that
    // fails to open stays a hard error (running billed-by-subscription when
    // the operator configured a key would be a silent misbill); in bedrock/
    // host_subscription mode a stored blob is retained INERT (FR-009) and is
    // never even materialized — an undecryptable inert blob must not fail an
    // otherwise-healthy run.
    let apiKey: string | undefined;
    if (auth.mode === 'api_key' && executorSecrets != null) {
      try {
        apiKey = openExecutorSecrets(executorSecrets).api_key;
      } catch (err) {
        throw new Error(
          `executor profile "${executorName}" has secrets that failed to decrypt (rotate BRIGADIR_CREDENTIALS_KEY back or re-enter the API key): ${String(err)}`,
          { cause: err },
        );
      }
    }

    // Feature 031: assemble the operator env for this run. Repo-mounted runs
    // only — triage (workspace_mode: 'none') and no-repo-degraded setup runs
    // get nothing, exactly like DEFAULT_REPO_RUN_ALLOWED_TOOLS (research D4).
    const { userEnv, envSecretValues } = noRepo
      ? { userEnv: {}, envSecretValues: [] }
      : await this.resolveRunUserEnv({
          workspaceId: row.workspaceId,
          agentId: row.agentId,
          agentEnv: behavior.env,
          mountedRepoNames: repos.map((r) => r.name),
        });

    return {
      runtimeConfig,
      repos,
      excludedRepos,
      workspaceId: row.workspaceId,
      ticketId: row.ticketId,
      preferRunId: (row.triggerEvent as { failing_run_id?: string } | null)?.failing_run_id,
      auth,
      apiKey,
      noRepo,
      setupRun,
      userEnv,
      envSecretValues,
    };
  }

  /**
   * Feature 031: read the workspace's non-secret env config + sealed
   * env-secrets blob and assemble the merged operator env for a repo-mounted
   * run (workspace ⊕ mounted repos in mount order ⊕ agent). Mounted repos are
   * matched to their settings entry by name to recover `id` (secret keying) and
   * `env`. An env-secrets blob that fails to open is a FAIL-FAST before spawn
   * (D7) — running with silently-missing secrets is never acceptable.
   */
  private async resolveRunUserEnv(args: {
    workspaceId: string;
    agentId: string;
    agentEnv?: Record<string, string>;
    mountedRepoNames: string[];
  }): Promise<{ userEnv: Record<string, string>; envSecretValues: string[] }> {
    const [ws] = await this.db
      .select({ settings: schema.workspaces.settings, envSecrets: schema.workspaces.envSecrets })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, args.workspaceId))
      .limit(1);
    const settings = (ws?.settings ?? {}) as {
      env?: Record<string, string>;
      repositories?: { id?: string; name: string; env?: Record<string, string> }[];
    };

    let secrets: EnvSecretsDocument = {};
    if (ws?.envSecrets) {
      try {
        secrets = openEnvSecrets(ws.envSecrets);
      } catch (err) {
        if (err instanceof SecretBoxError) {
          throw new Error(
            `workspace ${args.workspaceId} env-secrets blob failed to decrypt — ` +
              `fix BRIGADIR_CREDENTIALS_KEY or re-enter the secret env values (feature 031)`,
            { cause: err },
          );
        }
        throw err;
      }
    }

    const repoEntries = settings.repositories ?? [];
    const mountedRepos = args.mountedRepoNames.map((name) => {
      const entry = repoEntries.find((r) => r.name === name);
      return { id: entry?.id, env: entry?.env };
    });

    const { userEnv, secretValues } = assembleRunUserEnv({
      workspaceEnv: settings.env,
      agentEnv: args.agentEnv,
      mountedRepos,
      agentId: args.agentId,
      secrets: { workspace: secrets.workspace, repos: secrets.repos, agents: secrets.agents },
    });
    return { userEnv, envSecretValues: secretValues };
  }

  /**
   * Resolve the template's setup executor PROFILE NAME to a live profile row
   * (feature 015, FR-018). Missing or disabled → fall back to the built-in
   * `brigadir-setup` profile (insert-if-absent) and record a warning on the
   * run timeline — a dangling reference degrades, never fails the run.
   */
  private async resolveSetupProfile(runId: string, name: string) {
    const select = () =>
      this.db
        .select({
          id: schema.executors.id,
          name: schema.executors.name,
          config: schema.executors.config,
          secrets: schema.executors.secrets,
          enabled: schema.executors.enabled,
        })
        .from(schema.executors);

    const [profile] = await select().where(eq(schema.executors.name, name)).limit(1);
    if (profile?.enabled) return profile;

    const fallbackId = await ensureSetupExecutor(this.db);
    const [fallback] = await select().where(eq(schema.executors.id, fallbackId)).limit(1);
    // A missing reference to the built-in name itself is just a fresh database
    // (ensureSetupExecutor created it above) — not a misconfiguration.
    if (name !== SETUP_EXECUTOR_NAME || profile) {
      const message = `setup executor profile "${name}" ${profile ? 'is disabled' : 'does not exist'} — falling back to "${SETUP_EXECUTOR_NAME}"`;
      this.logger.warn(`run ${runId}: ${message}`);
      await this.db
        .insert(schema.runEvents)
        .values({ runId, type: 'log', payload: { message, source: 'setup-profile-fallback' } });
    }
    return fallback;
  }

  /**
   * Repository source of truth (feature 005): `workspaces.settings.repositories`
   * (what the wizard/settings screen writes — DB wins) first; the legacy
   * `agents.yaml` workspace.repositories[] as fallback for yaml-imported setups
   * whose settings blob predates the wizard. Empty name list = ALL workspace
   * repositories in declaration order (feature 019, research D1).
   */
  private async resolveRepositories(
    workspaceId: string,
    names: string[],
  ): Promise<{ repos: WorktreeRepo[]; ticketScoping: boolean; workspaceRepoNames: string[] }> {
    const [ws] = await this.db
      .select({ settings: schema.workspaces.settings })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1);
    const settings = (ws?.settings ?? {}) as {
      repositories?: { name: string; git_url: string; default_branch: string }[];
      ticket_scoping?: boolean;
    };
    const dbRepos = settings.repositories ?? [];
    const yamlRepos = this.agentsConfig?.workspace.repositories ?? [];

    return {
      repos: pickWorkspaceRepositories(dbRepos, yamlRepos, names, this.agentsConfig !== null),
      // Feature 020 (D2b): the scoping flag rides the same settings row —
      // one runtime read, nothing at module composition.
      ticketScoping: settings.ticket_scoping === true,
      // ALL workspace repo names (same DB-wins precedence as the repo list) —
      // needed to tell "component names no repo" from "names one outside the
      // agent's scope" (D2 case 2 vs 3).
      workspaceRepoNames: (dbRepos.length > 0 ? dbRepos : yamlRepos).map((r) => r.name),
    };
  }

  /**
   * Feature 020 (FR-015): one timeline event per scoping-active resolution so
   * an operator can tell "scoped to 1 repo on purpose" from "scoping
   * misfired". Same run_events precedent as setup-profile-fallback above.
   */
  private async recordScopingEvent(runId: string, result: NarrowResult): Promise<void> {
    const d = result.decision;
    const message =
      d.gate === 'passed'
        ? `ticket components narrowed the repository set to: ${d.effective.join(', ')}` +
          (d.ignored.length > 0 ? ` (ignored non-repository components: ${d.ignored.join(', ')})` : '')
        : d.gate === 'skipped_single_repo'
          ? 'ticket scoping skipped — single-repository base set (components add no information)'
          : d.gate === 'failed:components_unreadable'
            ? 'ticket components could not be read from Jira — failing closed'
            : `repository scope undeterminable (${d.gate.replace('parked:', '')}) — parking to the human queue`;
    await this.db
      .insert(schema.runEvents)
      .values({ runId, type: 'log', payload: { source: 'repo-scoping', message, ...d } });
  }

  /**
   * Feature 032 (contracts/branch-inheritance.md §§2-4): resolve what this run
   * inherits from its blockers, and apply the missing-branch matrix.
   *
   * Runs whose ticket has no observed blockers do NO work here and no Jira
   * fetch — their result is byte-identical to feature 023 (FR-016).
   */
  private async resolveInheritance(opts: {
    ctx: RunContext;
    ticketId: string | null;
    workspaceId: string;
    repos: WorktreeRepo[];
    caches: Record<string, string>;
    own: BranchMatch;
  }): Promise<InheritanceResult> {
    const { ctx, ticketId, workspaceId, repos, caches, own } = opts;
    const empty: InheritanceResult = {
      continueBranches: own.continueBranches,
      mergeBranches: {},
      plan: { repos: {}, unmounted: [], unmatched: own.unmatched },
      dropped: [],
      unmountedReported: [],
      linkedTickets: [],
    };
    if (!ctx.ticket || !ticketId) return empty;

    const [ticket] = await this.db
      .select({ blockedBy: schema.tickets.blockedBy })
      .from(schema.tickets)
      .where(eq(schema.tickets.id, ticketId))
      .limit(1);
    // `null` (never observed since feature 032) and `[]` (observed, no links)
    // mean the same thing here: nothing to inherit.
    const blockedByKeys = [...((ticket?.blockedBy as string[] | null) ?? [])].sort();
    if (blockedByKeys.length === 0) return empty;

    const { found, missing } = await getBlockerWork(this.db, {
      workspaceId,
      blockedByKeys,
      currentTicketId: ticketId,
    });
    if (found.length === 0 && missing.length === 0) return empty;

    // ONE batched fetch for the blockers' LIVE status — the done/not-done
    // asymmetry (FR-008) needs the status CATEGORY, which the tickets cache
    // does not store, and it must be fresh at exactly this decision point
    // (Principle I: Jira is the truth for status). A failure fails the run
    // loudly rather than guessing: guessing "done" would silence a real
    // problem, guessing "not done" would spam the human queue.
    const statuses = await this.fetchBlockerStatuses(blockedByKeys);

    const plan = buildStartPlan({ repos, own, blockerWork: found });

    // The blocker branches that are no longer on origin (or were never usable)
    // drop out of the plan here, before any worktree exists.
    const dropped: DroppedBlocker[] = [];
    for (const repo of repos) {
      const repoPlan = plan.repos[repo.name];
      if (repoPlan.source !== 'blocker') continue;
      const surviving: typeof repoPlan.blockers = [];
      for (const b of repoPlan.blockers) {
        if (await branchExistsOnOrigin(caches[repo.name], b.branch)) {
          surviving.push(b);
          continue;
        }
        dropped.push({ key: b.key, repo: repo.name, branch: b.branch, status: statuses.get(b.key) });
      }
      if (surviving.length === 0) {
        plan.repos[repo.name] = { source: 'default', mergeBranches: [], blockers: [] };
      } else {
        repoPlan.startBranch = surviving[0].branch;
        repoPlan.mergeBranches = surviving.slice(1).map((b) => b.branch);
        repoPlan.blockers = surviving;
      }
    }

    // Blocker keys that produced nothing at all (no ticket row / no artifacts)
    // join the same matrix — from the operator's side "the branch is gone" and
    // "there never was one" are the same problem with the same fix.
    for (const miss of missing) {
      dropped.push({ key: miss.key, repo: null, branch: null, status: statuses.get(miss.key) });
    }

    await this.applyMissingBranchMatrix(ctx, workspaceId, ticketId, repos, dropped);
    await this.reportUnmountedBlockerWork(ctx, workspaceId, ticketId, plan);

    const continueBranches: Record<string, string> = { ...own.continueBranches };
    const mergeBranches: Record<string, string[]> = {};
    for (const [name, p] of Object.entries(plan.repos)) {
      if (p.source === 'blocker' && p.startBranch) {
        continueBranches[name] = p.startBranch;
        if (p.mergeBranches.length > 0) mergeBranches[name] = p.mergeBranches;
      }
    }
    return {
      continueBranches,
      mergeBranches,
      plan,
      dropped,
      unmountedReported: plan.unmounted,
      linkedTickets: buildLinkedTickets(blockedByKeys, found, statuses),
    };
  }

  /**
   * ONE `key in (…)` search for the blockers' live status. No silent fallback
   * (constitution, Technology Constraints): a fetch failure throws, naming the
   * keys, and the caller turns it into a crashed run with those diagnostics.
   */
  private async fetchBlockerStatuses(keys: string[]): Promise<Map<string, string>> {
    try {
      const issues = await this.jira.searchUpdated(`key in (${keys.join(', ')})`, ['status']);
      return new Map(
        issues.map((i) => [
          i.key,
          `${i.fields.status.name}|${i.fields.status.statusCategory.key}`,
        ]),
      );
    } catch (err) {
      throw new Error(
        `could not read the status of blocker(s) [${keys.join(', ')}] from Jira — ` +
          'refusing to guess whether their branches should still exist: ' +
          (err instanceof Error ? err.message : String(err)),
        // The detail is inlined above because this message becomes the run's
        // `diagnostics`; `cause` keeps the original for anything reading the chain.
        { cause: err },
      );
    }
  }

  /**
   * FR-008's asymmetry. A blocker whose branch is gone AND whose status
   * category is `done` is the NORMAL end of a chain — its PR merged and the
   * branch was deleted, so the default branch already contains the work and the
   * run starts there quietly. A blocker that is still OPEN with nothing usable
   * is a genuine gap: the run proceeds from the default branch (stalling the
   * chain would be worse) but a person is told, exactly once.
   */
  private async applyMissingBranchMatrix(
    ctx: RunContext,
    workspaceId: string,
    ticketId: string,
    repos: WorktreeRepo[],
    dropped: DroppedBlocker[],
  ): Promise<void> {
    for (const d of dropped) {
      const [statusName, category] = (d.status ?? '|').split('|');
      const repoName = d.repo ?? repos.map((r) => r.name).join(', ');
      const defaultBranch = repos.find((r) => r.name === d.repo)?.defaultBranch ?? 'the default branch';
      if (category === 'done') {
        await this.recordBlockerDropEvent(ctx.runId, 'blocker_branch_merged', {
          repo: d.repo,
          blockers: [{ key: d.key, branch: d.branch }],
          message:
            `${repoName}: ${d.key} is done and left no branch on origin — its work is already in ` +
            `${defaultBranch}; starting there.`,
        });
        continue;
      }
      await this.recordBlockerDropEvent(ctx.runId, 'blocker_no_artifact', {
        repo: d.repo,
        blockers: [{ key: d.key, branch: d.branch }],
        message:
          `${repoName}: ${d.key} is still open (${statusName || 'status unknown'}) but left no ` +
          `usable branch — starting from ${defaultBranch} WITHOUT its work.`,
      });
      if (!ctx.ticket) continue;
      await this.raiseBlockerTask(
        workspaceId,
        ticketId,
        blockerBranchLostTask({
          ticketKey: ctx.ticket.key,
          blockerKey: d.key,
          repo: d.repo ?? 'this run\'s repositories',
          blockerStatus: statusName || 'unknown',
          defaultBranch,
        }),
      );
    }
  }

  /**
   * FR-010: a blocker changed a repository this run does not mount. The run is
   * fine — the mounted repositories still inherited correctly — but the agent
   * cannot see that part of the chain, so it is a visible diagnostic rather
   * than a silent omission. Mounting is NEVER widened here: repository scope
   * comes solely from the agent's base set narrowed by ticket Components
   * (`narrowByTicketComponents`), and inheritance follows scope, never
   * overrides it.
   */
  private async reportUnmountedBlockerWork(
    ctx: RunContext,
    workspaceId: string,
    ticketId: string,
    plan: StartPlan,
  ): Promise<void> {
    for (const u of plan.unmounted) {
      await this.recordBlockerDropEvent(ctx.runId, 'blocker_artifacts_unmounted', {
        repo: u.repo,
        blockers: [{ key: u.key, branch: u.branch }],
        message:
          `${u.key} reported work in "${u.repo}", which this run does not mount — add the ` +
          `matching Component to ${ctx.ticket?.key ?? 'the ticket'}, or widen the agent's ` +
          'repository scope.',
      });
      if (!ctx.ticket) continue;
      await this.raiseBlockerTask(
        workspaceId,
        ticketId,
        blockerRepoUnmountedTask({
          ticketKey: ctx.ticket.key,
          blockerKey: u.key,
          repo: u.repo,
        }),
      );
    }
  }

  /** A repo-less start-ref event for a blocker that contributed nothing (§5b). */
  private async recordBlockerDropEvent(
    runId: string,
    decision: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.db
      .insert(schema.runEvents)
      .values({ runId, type: 'log', payload: { source: 'start-ref', decision, ...payload } });
  }

  /**
   * Raise one of the three inheritance diagnostics, deduped on its title.
   * Strictly non-fatal: the run itself is unaffected by the queue write, and a
   * failure here must never turn a working run into a crashed one.
   */
  private async raiseBlockerTask(
    workspaceId: string,
    ticketId: string,
    task: BlockerTask,
  ): Promise<void> {
    try {
      const { created } = await createKeyedTicketTask(this.db, {
        workspaceId,
        ticketId,
        title: task.title,
        details: task.details,
      });
      if (created) this.logger.warn(task.title);
    } catch (err) {
      this.logger.error(`could not raise "${task.kind}" human task: ${String(err)}`);
    }
  }

  /**
   * Feature 033: resolve the ticket's verification receipt against the freshly
   * prepared worktrees. The receipt reaches the wrapper only when EVERY
   * mounted repo sits exactly at its recorded sha (whole-workspace semantics —
   * partial injection would claim run-level gates for a partially-matching
   * workspace). A valid-but-mismatched receipt emits a `receipt-stale` event
   * so invalidation is observable; garbage/legacy jsonb degrades silently.
   * Best-effort throughout: prepare never depends on this resolving.
   */
  private async resolveVerificationReceipt(
    runId: string,
    ticketId: string,
    repos: MultiPrepareResult['repos'],
  ): Promise<WrapperVerifiedGates | undefined> {
    try {
      const [row] = await this.db
        .select({ verification: schema.tickets.verification })
        .from(schema.tickets)
        .where(eq(schema.tickets.id, ticketId))
        .limit(1);
      const raw = row?.verification;
      if (raw === null || raw === undefined) return undefined;

      const startShas = Object.fromEntries(repos.map((r) => [r.repo.name, r.start.startSha]));
      const receipt = matchVerificationReceipt(raw, startShas);
      if (!receipt) {
        const parsed = VerificationReceiptSchema.safeParse(raw);
        if (parsed.success) {
          await this.db.insert(schema.runEvents).values({
            runId,
            type: 'log',
            payload: {
              source: 'receipt-stale',
              message:
                `Verification receipt from run ${parsed.data.runId.slice(0, 8)} does not match ` +
                'this workspace state — recorded gates will be re-verified.',
              receiptRunId: parsed.data.runId,
              receiptRepos: parsed.data.repos,
              startShas,
            },
          });
        }
        return undefined;
      }

      await this.db.insert(schema.runEvents).values({
        runId,
        type: 'log',
        payload: {
          source: 'receipt-injected',
          message:
            `Verification receipt injected: ${receipt.gates.join(', ')} already verified at ` +
            `this exact state (run ${receipt.runId.slice(0, 8)}).`,
          receiptRunId: receipt.runId,
          gates: receipt.gates,
          repos: receipt.repos,
        },
      });
      return {
        agentRole: receipt.agentRole ?? receipt.agentName ?? 'a previous agent',
        runId: receipt.runId,
        gates: receipt.gates,
        repoShas: receipt.repos,
      };
    } catch (err) {
      this.logger.warn(`verification receipt resolution failed for run ${runId}: ${String(err)}`);
      return undefined;
    }
  }

  /**
   * Feature 023: one timeline event PER MOUNTED REPO recording which ref this
   * run started from and why, so "where did this stage begin?" is answerable
   * from the run timeline alone, without logs. Written unconditionally —
   * including the boring `default_branch` case, which is exactly the one
   * needed when reconstructing an incident, and which doubles as the durable
   * record of which repos a run actually mounted. Same run_events precedent
   * as scoping above.
   */
  private async recordStartRefEvent(
    runId: string,
    repos: MultiPrepareResult['repos'],
    prior: PriorWork | undefined,
    matched: BranchMatch,
    inherit: InheritanceResult | null,
  ): Promise<void> {
    const rows = repos.map(({ repo, start }) => {
      const continueBranch = start.continueBranch;
      // Feature 032: the plan says WHOSE branch this is — the ticket's own
      // prior work or a blocker's. Both arrive as `continueBranch` in the
      // worktree layer (it is a pure git layer and does not know the
      // difference), so provenance is read back from the plan here.
      const repoPlan = inherit?.plan.repos[repo.name];
      const blockers = repoPlan?.source === 'blocker' ? repoPlan.blockers : [];
      const mergedBranches = start.mergedBranches ?? [];

      let decision: string;
      let message: string;
      if (blockers.length > 0 && mergedBranches.length > 0) {
        decision = 'merged_blockers';
        message =
          `${repo.name}: starting from ${continueBranch} merged with ` +
          `${mergedBranches.join(', ')} — work inherited from ` +
          `${blockers.map((b) => b.key).join(', ')}`;
      } else if (blockers.length > 0) {
        decision = 'inherited_from_blocker';
        message = `${repo.name}: starting from ${continueBranch}, inherited from blocker ${blockers[0].key}`;
      } else if (continueBranch) {
        decision = 'report_confirmed';
        message = `${repo.name}: continuing branch ${continueBranch}, reported by run ${prior?.runId}`;
      } else {
        decision = 'default_branch';
        message = `${repo.name}: no branch reported by prior work — starting from ${repo.defaultBranch}`;
      }

      return {
        runId,
        type: 'log' as const,
        payload: {
          source: 'start-ref',
          message,
          repo: repo.name,
          decision,
          continueBranch: continueBranch ?? null,
          // Feature 024: the resolved commit — the completion gate's baseline.
          // Feature 032: resolved AFTER any merge, so a merged start point is
          // the baseline by construction.
          startSha: start.startSha,
          reportedByRunId: prior?.runId ?? null,
          unmatchedReportedRepos: matched.unmatched,
          ...(blockers.length > 0 ? { blockers } : {}),
          ...(mergedBranches.length > 0 ? { mergedBranches } : {}),
        },
      };
    });
    if (rows.length > 0) await this.db.insert(schema.runEvents).values(rows);
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    // Lazy — only ever does work when actually called, never at module/@Module()
    // init (Constitution "Lazy resource resolution"). Checks the DEFAULT `claude`
    // binary resolves on PATH; per-instance `cliPath` overrides aren't visible
    // here since this interface has no per-run parameter (same limitation mock's
    // healthCheck has).
    const pathDirs = (process.env.PATH ?? '').split(':').filter(Boolean);
    const { existsSync } = await import('node:fs');
    const found = pathDirs.some((dir) => existsSync(join(dir, 'claude')));
    return found ? { ok: true } : { ok: false, detail: 'claude binary not found on PATH' };
  }
}
