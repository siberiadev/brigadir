import { Injectable, Inject, Logger } from '@nestjs/common';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { AGENTS_CONFIG } from '@brigadir/app-config';
import { JIRA_CLIENT, type JiraClient } from '@brigadir/jira';
import { ReportSchema, type AgentsConfig } from '@brigadir/contracts';
import type { AgentExecutor, ExecutorResult, RunContext } from '../agent-executor.interface';
import { openExecutorSecrets } from '../executor-secrets';
import { resolveClaudeCliConfig, type ClaudeCliExecutorConfigInput } from './claude-cli.config';
import { buildArgs } from './args';
import { buildChildEnv } from './env-allowlist';
import { ClaudeStreamParser, type TerminalResult } from './stream-parser';
import { prepare, cleanup, type WorktreeRepo } from './worktree';
import { spawnGroup } from './process-group';
import { buildWrapperText } from './wrapper';
import { writeMcpConfig, defaultMcpConfigRoot, type WrittenMcpConfig } from './mcp-config';
import { buildFeatureContextSection } from './feature-context';

const STDERR_TAIL_BYTES = 16 * 1024;

/**
 * Which repository NAME a run asks for (platform-scoped executors,
 * 2026-07-13): the executor is platform capacity and carries no repository, so
 * the choice is the AGENT's — `behavior.repository` when set, else '' (= the
 * run workspace's default repository). Pure — unit-tested directly.
 */
export function resolveRepositoryName(behavior: { repository?: unknown }): string {
  return typeof behavior.repository === 'string' ? behavior.repository : '';
}

/**
 * Repository source of truth (feature 005): workspace settings.repositories
 * (what the wizard/settings screen writes — DB wins) beats the legacy
 * agents.yaml workspace.repositories[], kept as fallback for yaml-imported
 * setups whose settings blob predates the wizard. Empty name = the workspace
 * default (first entry, FR-004/FR-008). Pure — unit-tested directly.
 */
export function pickWorkspaceRepository(
  dbRepos: { name: string; git_url: string; default_branch: string }[],
  yamlRepos: { name: string; url: string; default_branch: string }[],
  repoName: string,
  yamlLoaded: boolean,
): WorktreeRepo {
  if (dbRepos.length > 0) {
    const entry = repoName ? dbRepos.find((r) => r.name === repoName) : dbRepos[0];
    if (!entry) {
      throw new Error(
        `workspace has no repository named "${repoName}" in settings.repositories (linter should have caught this)`,
      );
    }
    return { name: entry.name, url: entry.git_url, defaultBranch: entry.default_branch };
  }

  const entry = repoName ? yamlRepos.find((r) => r.name === repoName) : yamlRepos[0];
  if (!entry) {
    throw new Error(
      `no repository "${repoName || '(default)'}" found: workspace settings has no repositories and ` +
        (yamlLoaded ? 'agents.yaml does not define it either' : 'no agents.yaml is loaded'),
    );
  }
  return { name: entry.name, url: entry.url, defaultBranch: entry.default_branch };
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
    const { runtimeConfig, repo, branchPrefix, workspaceId, apiKey } = await this.loadRunConfig(
      ctx.runId,
    );

    let worktree: { worktreeDir: string; branch: string; cacheDir: string };
    try {
      worktree = await prepare(
        repo,
        ctx.runId,
        ctx.ticket.key,
        branchPrefix,
        runtimeConfig.worktreeRoot,
        runtimeConfig.repoCacheRoot,
        { reuseBranch: ctx.isResumedAttempt === true },
      );
    } catch (err) {
      return { exitStatus: 'crashed', diagnostics: err instanceof Error ? err.message : String(err) };
    }

    await this.db
      .update(schema.runs)
      .set({ worktreePath: worktree.worktreeDir })
      .where(eq(schema.runs.id, ctx.runId));

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

      const featureContextSection = runtimeConfig.useCallbackChannel
        ? await buildFeatureContextSection({ jira: this.jira, db: this.db }, ctx.ticket.key, workspaceId)
        : undefined;

      await mkdir(join(worktree.worktreeDir, '.brigadir'), { recursive: true });
      await writeFile(
        join(worktree.worktreeDir, '.brigadir', 'wrapper.txt'),
        buildWrapperText(ctx, worktree.worktreeDir, {
          useCallbackChannel: runtimeConfig.useCallbackChannel,
          featureContextSection,
        }),
      );
    } catch (err) {
      await mcpConfig?.cleanup();
      await cleanup(worktree.cacheDir, worktree.worktreeDir, { keep: runtimeConfig.keepFailedWorktrees });
      return { exitStatus: 'crashed', diagnostics: err instanceof Error ? err.message : String(err) };
    }

    const result = await this.runProcess(ctx, signal, worktree, runtimeConfig, mcpConfig, apiKey);

    try {
      await mcpConfig?.cleanup();
    } catch (err) {
      this.logger.error(`mcp-config cleanup failed for run ${ctx.runId}: ${String(err)}`);
    }

    try {
      await cleanup(worktree.cacheDir, worktree.worktreeDir, {
        keep: runtimeConfig.keepFailedWorktrees && runFailed(result),
      });
    } catch (err) {
      this.logger.error(`worktree cleanup failed for run ${ctx.runId}: ${String(err)}`);
    }

    return result;
  }

  /** Resolves to the built `packages/mcp-server/dist/main.js`; overridable for deployments/tests. */
  private resolveMcpServerEntryPath(): string {
    return process.env.BRIGADIR_MCP_SERVER_ENTRY ?? join(process.cwd(), 'packages', 'mcp-server', 'dist', 'main.js');
  }

  private runProcess(
    ctx: RunContext,
    signal: AbortSignal,
    worktree: { worktreeDir: string; cacheDir: string },
    runtimeConfig: ReturnType<typeof resolveClaudeCliConfig>,
    mcpConfig: WrittenMcpConfig | undefined,
    apiKey: string | undefined,
  ): Promise<ExecutorResult> {
    const argv = buildArgs({
      model: runtimeConfig.model,
      worktreeDir: worktree.worktreeDir,
      allowedTools: runtimeConfig.allowedTools,
      maxTurns: ctx.limits.maxTurns ?? runtimeConfig.maxTurns,
      maxBudgetUsd: ctx.limits.maxBudgetUsd,
      useCallbackChannel: runtimeConfig.useCallbackChannel,
      mcpConfigPath: mcpConfig?.configPath,
      stopHookSettingsJson: mcpConfig?.settingsJson,
    });
    const env = buildChildEnv(process.env);
    // Named runner profiles (2026-07-14): a profile with a stored API key runs
    // billed by that key instead of the host's ~/.claude subscription. This is
    // a DELIBERATE injection of the profile's own decrypted secret — the
    // allowlist still guarantees the HOST's ANTHROPIC_API_KEY can never leak
    // through (it is not an allowlisted key).
    if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
    const group = spawnGroup(runtimeConfig.cliPath, argv, { cwd: worktree.worktreeDir, env });

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
      `Work Jira ticket ${ctx.ticket.key} exactly as described in your system prompt. Begin now.\n`,
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

  private async loadRunConfig(runId: string): Promise<{
    runtimeConfig: ReturnType<typeof resolveClaudeCliConfig>;
    repo: WorktreeRepo;
    branchPrefix: string;
    workspaceId: string;
    apiKey: string | undefined;
  }> {
    const [row] = await this.db
      .select({
        executorConfig: schema.executors.config,
        executorName: schema.executors.name,
        executorSecrets: schema.executors.secrets,
        behavior: schema.agents.behavior,
        workspaceId: schema.runs.workspaceId,
      })
      .from(schema.runs)
      .innerJoin(schema.agents, eq(schema.runs.agentId, schema.agents.id))
      .innerJoin(schema.executors, eq(schema.agents.executorId, schema.executors.id))
      .where(eq(schema.runs.id, runId))
      .limit(1);

    if (!row) {
      throw new Error(`run ${runId} not found while resolving claude_cli config`);
    }

    const rawConfig = row.executorConfig as ClaudeCliExecutorConfigInput;
    const behavior = (row.behavior ?? {}) as {
      allowed_tools?: string[];
      branch_prefix?: string;
      repository?: string;
    };
    // Named runner profiles (2026-07-14): the PROFILE's model is the single
    // source of truth — resolveClaudeCliConfig reads it from the executor
    // config only, so a legacy `behavior.model` on the agent is ignored here
    // unconditionally (no data migration; live agent "TEST" keeps working).
    const runtimeConfig = resolveClaudeCliConfig(rawConfig, behavior.allowed_tools ?? []);

    // Platform-scoped executors (2026-07-13): the repository is the AGENT's
    // choice (behavior.repository), else the run workspace's default repo.
    const repo = await this.resolveRepository(row.workspaceId, resolveRepositoryName(behavior));

    // Profile API key (write-only at the API; only the runtime opens it). A
    // blob that fails to open is a hard error — running billed-by-subscription
    // when the operator configured a key would be a silent misbill.
    let apiKey: string | undefined;
    if (row.executorSecrets != null) {
      try {
        apiKey = openExecutorSecrets(row.executorSecrets).api_key;
      } catch (err) {
        throw new Error(
          `executor profile "${row.executorName}" has secrets that failed to decrypt (rotate BRIGADIR_CREDENTIALS_KEY back or re-enter the API key): ${String(err)}`,
          { cause: err },
        );
      }
    }

    return {
      runtimeConfig,
      repo,
      branchPrefix: behavior.branch_prefix ?? 'run',
      workspaceId: row.workspaceId,
      apiKey,
    };
  }

  /**
   * Repository source of truth (feature 005): `workspaces.settings.repositories`
   * (what the wizard/settings screen writes — DB wins) first; the legacy
   * `agents.yaml` workspace.repositories[] as fallback for yaml-imported setups
   * whose settings blob predates the wizard. Empty name = the workspace default
   * (first entry, FR-004/FR-008).
   */
  private async resolveRepository(workspaceId: string, repoName: string): Promise<WorktreeRepo> {
    const [ws] = await this.db
      .select({ settings: schema.workspaces.settings })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1);
    const settings = (ws?.settings ?? {}) as {
      repositories?: { name: string; git_url: string; default_branch: string }[];
    };

    return pickWorkspaceRepository(
      settings.repositories ?? [],
      this.agentsConfig?.workspace.repositories ?? [],
      repoName,
      this.agentsConfig !== null,
    );
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
