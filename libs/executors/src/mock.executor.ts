import { Injectable, Inject, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { TriggerEventSchema, type AgentReport } from '@brigadir/contracts';
import {
  type AgentExecutor,
  type ExecutorResult,
  type RunContext,
} from './agent-executor.interface';

/**
 * MockExecutor (research D5) — deterministic six-scenario harness (NFR item 5).
 *
 * The scenario rides in `runs.trigger_event.mock_scenario` (kept out of the job
 * payload so the queue contract matches real executors). `rate_limited` is
 * stateful-deterministic: it records an `api_retry` event in `run_events` on the
 * first pass and returns `rate_limited`; on the next pass (the marker exists) it
 * behaves like `success`. State lives in Postgres, so it survives restarts.
 */
@Injectable()
export class MockExecutor implements AgentExecutor {
  readonly type = 'mock' as const;
  private readonly logger = new Logger(MockExecutor.name);

  constructor(@Inject(DRIZZLE) private readonly db: BrigadirDb) {}

  async run(ctx: RunContext, _signal: AbortSignal): Promise<ExecutorResult> {
    const [run] = await this.db
      .select({ triggerEvent: schema.runs.triggerEvent })
      .from(schema.runs)
      .where(eq(schema.runs.id, ctx.runId))
      .limit(1);

    const triggerEvent = TriggerEventSchema.parse(run?.triggerEvent ?? {});
    const scenario = triggerEvent.mock_scenario;
    this.logger.log(`mock run ${ctx.runId} scenario=${scenario}`);

    switch (scenario) {
      case 'success':
        return { exitStatus: 'completed', report: successReport() };
      case 'failure':
        return { exitStatus: 'completed', report: failureReport() };
      case 'needs_human':
        return { exitStatus: 'completed', report: needsHumanReport() };
      case 'timeout':
        return { exitStatus: 'timeout', diagnostics: 'mock: simulated executor timeout' };
      case 'crash':
        throw new Error('mock: simulated process crash');
      case 'rate_limited':
        return this.rateLimited(ctx.runId);
      default:
        return { exitStatus: 'completed', report: successReport() };
    }
  }

  private async rateLimited(runId: string): Promise<ExecutorResult> {
    const existing = await this.db
      .select({ id: schema.runEvents.id })
      .from(schema.runEvents)
      .where(and(eq(schema.runEvents.runId, runId), eq(schema.runEvents.type, 'api_retry')))
      .limit(1);

    if (existing.length === 0) {
      await this.db.insert(schema.runEvents).values({
        runId,
        type: 'api_retry',
        payload: { error: 'rate_limit', source: 'mock' },
      });
      return { exitStatus: 'rate_limited', diagnostics: 'mock: rate limited (first pass)' };
    }
    // marker already present → the retry succeeds deterministically.
    return { exitStatus: 'completed', report: successReport() };
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true };
  }
}

function successReport(): AgentReport {
  return {
    schema_version: 1,
    outcome: 'success',
    summary: 'Mock run completed successfully.',
    checks: [
      { name: 'tests_pass', status: 'pass' },
      { name: 'lint_pass', status: 'pass' },
    ],
  };
}

function failureReport(): AgentReport {
  return {
    schema_version: 1,
    outcome: 'failure',
    summary: 'Mock run failed a required check.',
    checks: [
      { name: 'tests_pass', status: 'fail', reason: 'mock: 1 test failing' },
      { name: 'lint_pass', status: 'pass' },
    ],
  };
}

function needsHumanReport(): AgentReport {
  return {
    schema_version: 1,
    outcome: 'needs_human',
    summary: 'Mock run needs a human decision.',
    checks: [{ name: 'design_review', status: 'warn', reason: 'ambiguous requirement' }],
    human_task: {
      kind: 'question',
      title: 'Clarify expected behavior for edge case',
      details: 'mock: the ticket does not specify the empty-input behavior.',
    },
  };
}
