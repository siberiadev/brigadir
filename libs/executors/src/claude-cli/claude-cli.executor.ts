import { Injectable, Inject, Logger } from '@nestjs/common';
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
  SETUP_EXECUTOR_NAME,
} from '@brigadir/database';
import { AGENTS_CONFIG } from '@brigadir/app-config';
import { JIRA_CLIENT, type JiraClient } from '@brigadir/jira';
import { ReportSchema, type AgentsConfig } from '@brigadir/contracts';
import type { AgentExecutor, ExecutorResult, RunContext } from '../agent-executor.interface';
import { openExecutorSecrets } from '../executor-secrets';
import {
  resolveClaudeCliConfig,
  resolveEffectiveAuth,
  applyAuthEnv,
  DEFAULT_REPO_RUN_ALLOWED_TOOLS,
  type ClaudeCliExecutorConfigInput,
  type EffectiveAuth,
} from './claude-cli.config';
import { buildArgs } from './args';
import { buildChildEnv } from './env-allowlist';
import { ClaudeStreamParser, type TerminalResult } from './stream-parser';
import {
  prepareAll,
  cleanupAll,
  setupRunBranchIdentity,
  type WorktreeRepo,
  type MultiPrepareResult,
} from './worktree';
import { spawnGroup } from './process-group';
import {
  narrowByTicketComponents,
  RepositoryScopeUndeterminableError,
  type NarrowResult,
} from './scope-ticket';
import { buildWrapperText } from './wrapper';
import { writeMcpConfig, defaultMcpConfigRoot, type WrittenMcpConfig } from './mcp-config';
import { buildFeatureContextSection } from './feature-context';
import {
  getPriorWork,
  matchReportedBranches,
  type PriorWork,
  type BranchMatch,
} from './prior-work';

const STDERR_TAIL_BYTES = 16 * 1024;

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
  readonly type = 'claude_cli' as const;
  private readonly logger = new Logger(ClaudeCliExecutor.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: BrigadirDb,
    // Feature 005: AGENTS_CONFIG is optional (null on a DB-only boot). The
    // claude_cli executor still resolves its repository from the yaml at
    // run-time (DB-authoritative repo config is future work); a run with no
    // yaml throws a clear error rather than crashing at boot.
    @Inject(AGENTS_CONFIG) private readonly agentsConfig: AgentsConfig | null,
    @Inject(JIRA_CLIENT) private readonly jira: JiraClient,
  ) {}

  async run(ctx: RunContext, signal: AbortSignal): Promise<ExecutorResult> {
    const {
      runtimeConfig,
      repos,
      excludedRepos,
      branchPrefix,
      workspaceId,
      ticketId,
      preferRunId,
      auth,
      apiKey,
      noRepo,
      setupRun,
    } = await this.loadRunConfig(ctx);

    // The run's workspace dir: the parent `worktreeRoot/<runId>` holding one
    // worktree per repo (feature 019, research D3), or a scratch temp dir for
    // no-repo runs. `workspace` stays null exactly for the scratch case.
    let workspaceDir: string;
    let workspace: MultiPrepareResult | null = null;
    let suggestedBranch: string | undefined;
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
      // The system no longer creates branches (feature 023) — it only picks the
      // commit each repo starts from and SUGGESTS a name for the agent to
      // create. A ticketless repo run is a config error EXCEPT for
      // workspace-setup runs (feature 015, FR-020): those are ticketless by
      // design and suggest `setup/<runId8>` (never pushed — spec FR-015).
      if (ctx.ticket) {
        suggestedBranch = `${branchPrefix}/${ctx.ticket.key}`;
      } else if (setupRun) {
        const identity = setupRunBranchIdentity(ctx.runId);
        suggestedBranch = `${identity.branchPrefix}/${identity.ticketKey}`;
      } else {
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
        let continueBranches: Record<string, string> = {};
        if (ctx.ticket && ticketId) {
          const prior = await getPriorWork(this.db, {
            ticketId,
            currentRunId: ctx.runId,
            preferRunId,
          });
          const matched = prior
            ? matchReportedBranches(prior.entries, repos)
            : { continueBranches: {}, unmatched: [] };
          continueBranches = matched.continueBranches;
          await this.recordStartRefEvent(ctx.runId, repos, prior, matched);
        }
        workspace = await prepareAll(
          repos,
          ctx.runId,
          runtimeConfig.worktreeRoot,
          runtimeConfig.repoCacheRoot,
          { continueBranches },
        );
      } catch (err) {
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
            mcpServerEntryPath: this.resolveMcpServerEntryPath(),
          },
          defaultMcpConfigRoot(tmpdir()),
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
          repos: workspace?.repos.map((r) => ({
            name: r.repo.name,
            absPath: r.worktreeDir,
            defaultBranch: r.repo.defaultBranch,
            continueBranch: r.start.continueBranch,
            suggestedBranch,
          })),
          // Feature 020 (D4): non-empty only for ticket-narrowed runs.
          onDemandRepos: excludedRepos.map((r) => ({ name: r.name, url: r.url })),
        }),
      );
    } catch (err) {
      await mcpConfig?.cleanup();
      await this.cleanupWorkspace(workspace, workspaceDir, runtimeConfig.keepFailedWorktrees, ctx.runId);
      return { exitStatus: 'crashed', diagnostics: err instanceof Error ? err.message : String(err) };
    }

    const result = await this.runProcess(ctx, signal, workspaceDir, runtimeConfig, mcpConfig, auth, apiKey);

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

  /** Resolves to the built `packages/mcp-server/dist/main.js`; overridable for deployments/tests. */
  private resolveMcpServerEntryPath(): string {
    return process.env.BRIGADIR_MCP_SERVER_ENTRY ?? join(process.cwd(), 'packages', 'mcp-server', 'dist', 'main.js');
  }

  private runProcess(
    ctx: RunContext,
    signal: AbortSignal,
    workspaceDir: string,
    runtimeConfig: ReturnType<typeof resolveClaudeCliConfig>,
    mcpConfig: WrittenMcpConfig | undefined,
    auth: EffectiveAuth,
    apiKey: string | undefined,
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
    // Per-profile auth injection (feature 018; api_key mode since 2026-07-14):
    // DELIBERATE additions of the profile's own values AFTER the allowlist
    // pass — the HOST's ANTHROPIC_API_KEY / AWS_* / CLAUDE_CODE_USE_BEDROCK /
    // NODE_EXTRA_CA_CERTS still can never leak through (none are allowlisted).
    applyAuthEnv(env, auth, apiKey);
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

    const parser = new ClaudeStreamParser();
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

        if (abortReason) {
          // The cancel-poll aborts a lingering process AFTER a callback
          // finalize/park flipped the run off 'running' — exactly the path
          // where a terminal event parsed before the kill carries the run's
          // only cost/usage data. handleClose runs after 'close', so
          // `terminal` holds whatever the parser captured; don't drop it.
          settle({
            exitStatus: abortReason,
            externalRef,
            costUsd: terminal?.totalCostUsd,
            usage: terminal?.usage,
            diagnostics: `run ${abortReason}`,
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
            costUsd: terminal?.totalCostUsd,
            usage: terminal?.usage,
            diagnostics: 'subscription rate limit hit — retry later, attempt not spent',
          });
          return;
        }

        if (terminal) {
          // D11 (REVISED): only the terminal event ever carries total_cost_usd;
          // enforce the ceiling here as a post-hoc verification of the CLI's
          // own --max-budget-usd self-stop. No token→USD estimation.
          if (
            ctx.limits.maxBudgetUsd !== undefined &&
            terminal.totalCostUsd !== undefined &&
            terminal.totalCostUsd > ctx.limits.maxBudgetUsd
          ) {
            settle({
              exitStatus: 'crashed',
              externalRef,
              costUsd: terminal.totalCostUsd,
              usage: terminal.usage,
              diagnostics: `budget exceeded: cost_usd=${terminal.totalCostUsd} > max_budget_usd=${ctx.limits.maxBudgetUsd}`,
            });
            return;
          }

          const parsedReport = ReportSchema.safeParse(terminal.structuredOutput);
          if (parsedReport.success) {
            settle({
              exitStatus: 'completed',
              externalRef,
              costUsd: terminal.totalCostUsd,
              usage: terminal.usage,
              report: parsedReport.data,
            });
          } else {
            settle({
              exitStatus: 'completed',
              externalRef,
              costUsd: terminal.totalCostUsd,
              usage: terminal.usage,
              diagnostics: `no schema-valid structured_output: ${parsedReport.error.message}`,
            });
          }
          return;
        }

        // No terminal `result` event ever arrived: nonzero/unexpected exit.
        const tail = stderrTail.text;
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
    branchPrefix: string;
    workspaceId: string;
    /** Feature 023: anchors the "prior work on this ticket" lookup. Null for ticketless runs. */
    ticketId: string | null;
    /** Feature 023: the run a rework / human-resume / triage handoff names, if any. */
    preferRunId: string | undefined;
    auth: EffectiveAuth;
    apiKey: string | undefined;
    noRepo: boolean;
    setupRun: boolean;
  }> {
    const runId = ctx.runId;
    const [row] = await this.db
      .select({
        executorConfig: schema.executors.config,
        executorName: schema.executors.name,
        executorSecrets: schema.executors.secrets,
        behavior: schema.agents.behavior,
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
      throw new Error(`run ${runId} not found while resolving claude_cli config`);
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
      branch_prefix?: string;
      repository?: string;
      repositories?: string[];
      workspace_mode?: string;
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
    const auth = resolveEffectiveAuth(rawConfig, executorSecrets != null);

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

    return {
      runtimeConfig,
      repos,
      excludedRepos,
      // Feature 023: no longer a git instruction — the name SUGGESTED to the
      // agent in the wrapper when it has no prior branch to continue.
      branchPrefix: behavior.branch_prefix ?? 'run',
      workspaceId: row.workspaceId,
      ticketId: row.ticketId,
      preferRunId: (row.triggerEvent as { failing_run_id?: string } | null)?.failing_run_id,
      auth,
      apiKey,
      noRepo,
      setupRun,
    };
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
    repos: WorktreeRepo[],
    prior: PriorWork | undefined,
    matched: BranchMatch,
  ): Promise<void> {
    const rows = repos.map((repo) => {
      const continueBranch = matched.continueBranches[repo.name];
      const decision = continueBranch ? 'report_confirmed' : 'default_branch';
      const message = continueBranch
        ? `${repo.name}: continuing branch ${continueBranch}, reported by run ${prior?.runId}`
        : `${repo.name}: no branch reported by prior work — starting from ${repo.defaultBranch}`;
      return {
        runId,
        type: 'log' as const,
        payload: {
          source: 'start-ref',
          message,
          repo: repo.name,
          decision,
          continueBranch: continueBranch ?? null,
          reportedByRunId: prior?.runId ?? null,
          unmatchedReportedRepos: matched.unmatched,
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
