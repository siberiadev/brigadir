import { Injectable, Inject, Logger } from '@nestjs/common';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { AGENTS_CONFIG } from '@brigadir/app-config';
import { ReportSchema, type AgentsConfig } from '@brigadir/contracts';
import type { AgentExecutor, ExecutorResult, RunContext } from '../agent-executor.interface';
import { resolveClaudeCliConfig, type ClaudeCliExecutorConfigInput } from './claude-cli.config';
import { buildArgs } from './args';
import { buildChildEnv } from './env-allowlist';
import { ClaudeStreamParser, type TerminalResult } from './stream-parser';
import { prepare, cleanup, type WorktreeRepo } from './worktree';
import { spawnGroup } from './process-group';

const STDERR_TAIL_BYTES = 16 * 1024;

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

function buildWrapperText(ctx: RunContext, worktreeDir: string): string {
  const lines = [
    `You are an autonomous coding agent working on Jira ticket ${ctx.ticket.key}: ${ctx.ticket.summary}`,
    ctx.ticket.description ? `\n${ctx.ticket.description}` : '',
    '',
    '## Your task',
    ctx.instruction,
    '',
    '## How to report your result',
    'No MCP tools are available in this session (Phase 0). When you are completely finished, ' +
      'return your final answer strictly as JSON conforming to the provided report schema. ' +
      'Do not include any other text after the JSON.',
    '- outcome="success" ONLY if every required check actually passed in this session. Never ' +
      'claim a check passed without running it.',
    '- outcome="failure" if something required failed — report each check honestly with its ' +
      'status and reason.',
    '- outcome="needs_human" if you are blocked or requirements are ambiguous and cannot ' +
      'proceed — include a human_task describing the question or blocker.',
    '',
    '## Rules',
    `- Work only inside this workspace directory (${worktreeDir}).`,
    '- Do not transition or comment the Jira ticket yourself — the system does that from your report.',
    '- If you cannot finish, still return a JSON report with outcome="failure" or ' +
      '"needs_human" — never exit the session without one.',
  ];
  return lines.join('\n');
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
 * claude_cli-specific instance config (model/cliPath/repository/allowedTools/
 * worktree roots/kill+cancel timing) has no home there, so this executor
 * looks it up itself via `ctx.runId` — the same DB-lookup pattern
 * `MockExecutor` already uses for its scenario. `AGENTS_CONFIG` resolves the
 * `repository` name to an actual git URL (workspace.repositories[], static
 * process config, not a secret).
 */
@Injectable()
export class ClaudeCliExecutor implements AgentExecutor {
  readonly type = 'claude_cli' as const;
  private readonly logger = new Logger(ClaudeCliExecutor.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: BrigadirDb,
    @Inject(AGENTS_CONFIG) private readonly agentsConfig: AgentsConfig,
  ) {}

  async run(ctx: RunContext, signal: AbortSignal): Promise<ExecutorResult> {
    const { runtimeConfig, repo, branchPrefix } = await this.loadRunConfig(ctx.runId);

    let worktree: { worktreeDir: string; branch: string; cacheDir: string };
    try {
      worktree = await prepare(
        repo,
        ctx.runId,
        ctx.ticket.key,
        branchPrefix,
        runtimeConfig.worktreeRoot,
        runtimeConfig.repoCacheRoot,
      );
    } catch (err) {
      return { exitStatus: 'crashed', diagnostics: err instanceof Error ? err.message : String(err) };
    }

    await this.db
      .update(schema.runs)
      .set({ worktreePath: worktree.worktreeDir })
      .where(eq(schema.runs.id, ctx.runId));

    try {
      await mkdir(join(worktree.worktreeDir, '.brigadir'), { recursive: true });
      await writeFile(
        join(worktree.worktreeDir, '.brigadir', 'wrapper.txt'),
        buildWrapperText(ctx, worktree.worktreeDir),
      );
    } catch (err) {
      await cleanup(worktree.cacheDir, worktree.worktreeDir, { keep: runtimeConfig.keepFailedWorktrees });
      return { exitStatus: 'crashed', diagnostics: err instanceof Error ? err.message : String(err) };
    }

    const result = await this.runProcess(ctx, signal, worktree, runtimeConfig);

    try {
      await cleanup(worktree.cacheDir, worktree.worktreeDir, {
        keep: runtimeConfig.keepFailedWorktrees && runFailed(result),
      });
    } catch (err) {
      this.logger.error(`worktree cleanup failed for run ${ctx.runId}: ${String(err)}`);
    }

    return result;
  }

  private runProcess(
    ctx: RunContext,
    signal: AbortSignal,
    worktree: { worktreeDir: string; cacheDir: string },
    runtimeConfig: ReturnType<typeof resolveClaudeCliConfig>,
  ): Promise<ExecutorResult> {
    const argv = buildArgs({
      model: runtimeConfig.model,
      worktreeDir: worktree.worktreeDir,
      allowedTools: runtimeConfig.allowedTools,
      maxTurns: ctx.limits.maxTurns ?? runtimeConfig.maxTurns,
      maxBudgetUsd: ctx.limits.maxBudgetUsd,
    });
    const env = buildChildEnv(process.env);
    const group = spawnGroup(runtimeConfig.cliPath, argv, { cwd: worktree.worktreeDir, env });

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
          settle({ exitStatus: abortReason, externalRef, diagnostics: `run ${abortReason}` });
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

  private async loadRunConfig(
    runId: string,
  ): Promise<{ runtimeConfig: ReturnType<typeof resolveClaudeCliConfig>; repo: WorktreeRepo; branchPrefix: string }> {
    const [row] = await this.db
      .select({
        executorConfig: schema.executors.config,
        behavior: schema.agents.behavior,
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
    const behavior = (row.behavior ?? {}) as { allowed_tools?: string[]; branch_prefix?: string };
    const runtimeConfig = resolveClaudeCliConfig(rawConfig, behavior.allowed_tools ?? []);

    const repoEntry = this.agentsConfig.workspace.repositories?.find(
      (r) => r.name === runtimeConfig.repository,
    );
    if (!repoEntry) {
      throw new Error(
        `workspace has no repository named "${runtimeConfig.repository}" (boot validation should have caught this)`,
      );
    }

    return {
      runtimeConfig,
      repo: { name: repoEntry.name, url: repoEntry.url, defaultBranch: repoEntry.default_branch },
      branchPrefix: behavior.branch_prefix ?? 'run',
    };
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
