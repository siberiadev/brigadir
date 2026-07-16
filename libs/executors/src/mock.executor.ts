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
      case 'delay':
        // Holds the run in `running` for a controllable window, then succeeds —
        // what the per-profile max_parallel_runs gate tests occupy slots with.
        await new Promise((r) => setTimeout(r, triggerEvent.mock_delay_ms ?? 500));
        return { exitStatus: 'completed', report: successReport() };
      case 'routed':
        // FR-024/D12: the mock orchestrator emits a `routed` report. The target
        // worker's name rides in `trigger_event.target_agent` so integration
        // tests can drive fail→triage→route→rework→success deterministically.
        return {
          exitStatus: 'completed',
          report: routedReport(triggerEvent.target_agent ?? 'Developer', triggerEvent.task),
        };
      case 'team':
        // feature 011 (D15): the mock orchestrator emits a `team` proposal. The
        // roster rides in the AGENT's behavior (`team_proposal`, mirroring how
        // `route_target` parameterizes `routed`) so integration tests control it.
        return { exitStatus: 'completed', report: teamReport(await this.teamProposalOf(ctx.runId)) };
      case 'team_invalid':
        // feature 011 (D15): a proposal referencing a status that exists on no
        // board — the accept path must reject it with `status_absent` and zero
        // agents created; the mock cannot repair-loop, so the run fail-closes.
        return {
          exitStatus: 'completed',
          report: teamReport([{ ...DEFAULT_TEAM[0], trigger_status: 'No Such Status' }]),
        };
      default:
        return { exitStatus: 'completed', report: successReport() };
    }
  }

  /** The test-controlled roster from the orchestrator agent's behavior. */
  private async teamProposalOf(runId: string): Promise<TeamProposalAgents> {
    const [row] = await this.db
      .select({ behavior: schema.agents.behavior })
      .from(schema.runs)
      .innerJoin(schema.agents, eq(schema.runs.agentId, schema.agents.id))
      .where(eq(schema.runs.id, runId))
      .limit(1);
    const proposal = (row?.behavior as { team_proposal?: TeamProposalAgents } | null)?.team_proposal;
    return Array.isArray(proposal) && proposal.length > 0 ? proposal : DEFAULT_TEAM;
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

function routedReport(targetAgent: string, task?: string): AgentReport {
  return {
    schema_version: 1,
    outcome: 'routed',
    summary: `Mock orchestrator routed the ticket back to "${targetAgent}".`,
    checks: [{ name: 'triage', status: 'pass' }],
    routing: {
      target_agent: targetAgent,
      task: task ?? 'Fix the failing checks from the previous attempt and re-run the suite.',
    },
  };
}

type TeamProposalAgents = NonNullable<AgentReport['team']>['agents'];

/** Fallback roster when the test doesn't set `behavior.team_proposal`. */
const DEFAULT_TEAM: TeamProposalAgents = [
  {
    name: 'Developer',
    description: 'Implements tickets end to end and opens a PR.',
    instruction: 'Implement the ticket on a branch and open a PR.',
    trigger_status: 'To Do',
    status_running: 'In Progress',
    status_success: 'In Review',
    status_failure: 'Blocked',
    executor: 'mock-default',
  },
];

function teamReport(agents: TeamProposalAgents): AgentReport {
  return {
    schema_version: 1,
    outcome: 'team',
    summary: `Mock orchestrator proposed a team of ${agents.length} agent(s).`,
    checks: [{ name: 'project_studied', status: 'pass' }],
    team: { agents },
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
