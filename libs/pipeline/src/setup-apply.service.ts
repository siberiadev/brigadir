import { Injectable, Inject, Logger } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { JiraClientFactory } from '@brigadir/jira';
import { lintAgent, type AgentReport, type LintIssue, type LintableAgent } from '@brigadir/contracts';

const ACTIVE_STATUSES = ['queued', 'running', 'awaiting_human'];

/** Path-qualified validation issue, shaped like the callback 422 body. */
export interface TeamIssue {
  path: (string | number)[];
  code: string;
  message: string;
}

export type TeamAcceptResult =
  /** Whole proposal valid → agents + review task + finalize landed in ONE tx. */
  | { kind: 'applied'; agentsCreated: number }
  /** Business validation failed → NOTHING changed; the run stays active so the
   *  agent can fix the proposal and re-submit (FR-017 repair loop). */
  | { kind: 'invalid'; issues: TeamIssue[] }
  /** Run not active (double complete) — mirrors finalizeWithReport's contract. */
  | { kind: 'conflict' }
  /** FR-014: `team` from a non-setup run — recast and finalized as a failure. */
  | { kind: 'recast_failure' };

/**
 * SetupApplyService (feature 011, D9/D10) — the accept path of a workspace-setup
 * run's `team` report. Validation and application share ONE transaction so
 * "succeeded ⇔ the team and review task exist" is an invariant:
 *
 *   validate (names ∪ statuses ∪ executors ∪ triggers, all-or-nothing)
 *     → invalid: return the issue list (the caller answers 422; run untouched)
 *   apply: insert N agents (enabled) + the review human task + guarded finalize
 *     → a concurrent 23505 (name raced with a manual create) degrades to invalid.
 *
 * The pipeline's completion branch (`onSetupFinished`) then only writes the
 * replay marker — there is no Jira side anywhere on this path (Principle III
 * holds trivially; the system creates the agents from the validated report).
 */
@Injectable()
export class SetupApplyService {
  private readonly logger = new Logger(SetupApplyService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: BrigadirDb,
    private readonly jiraFactory: JiraClientFactory,
  ) {}

  async acceptTeamReport(runId: string, report: AgentReport): Promise<TeamAcceptResult> {
    const team = report.team;
    if (report.outcome !== 'team' || !team) {
      // Schema-level rule (team ⇔ payload) already enforced upstream.
      return { kind: 'invalid', issues: [{ path: ['team'], code: 'missing', message: 'team payload required' }] };
    }

    const [run] = await this.db
      .select({
        status: schema.runs.status,
        workspaceId: schema.runs.workspaceId,
        triggerEvent: schema.runs.triggerEvent,
        isOrchestrator: schema.agents.isOrchestrator,
        agentName: schema.agents.name,
      })
      .from(schema.runs)
      .innerJoin(schema.agents, eq(schema.runs.agentId, schema.agents.id))
      .where(eq(schema.runs.id, runId))
      .limit(1);
    if (!run) return { kind: 'conflict' };
    if (!ACTIVE_STATUSES.includes(run.status)) return { kind: 'conflict' };

    // FR-014: only an orchestrator's workspace-setup run may deliver a team.
    const source = (run.triggerEvent as { source?: string } | null)?.source;
    if (!run.isOrchestrator || source !== 'workspace-setup') {
      const recast = await this.finalizeInvalidOutcome(runId, report);
      return recast ? { kind: 'recast_failure' } : { kind: 'conflict' };
    }

    const issues = await this.validate(run.workspaceId, team.agents);
    if (issues.length > 0) {
      this.logger.log(`setup run ${runId}: proposal rejected with ${issues.length} issue(s)`);
      return { kind: 'invalid', issues };
    }

    return this.apply(runId, run.workspaceId, report, team.agents);
  }

  // --- validation (FR-015, all-or-nothing) ---

  private async validate(
    workspaceId: string,
    proposed: NonNullable<AgentReport['team']>['agents'],
  ): Promise<TeamIssue[]> {
    const issues: TeamIssue[] = [];

    // Board statuses — via the workspace's own Jira access. Unavailable board
    // statuses fail the VALIDATION (not the run): the agent may retry later.
    let boardStatuses;
    try {
      const [ws] = await this.db
        .select({ projectKey: schema.workspaces.jiraProjectKey })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .limit(1);
      if (!ws) return [{ path: [], code: 'workspace_missing', message: 'workspace not found' }];
      const jira = await this.jiraFactory.forWorkspace(workspaceId);
      boardStatuses = await jira.getProjectStatuses(ws.projectKey);
    } catch (err) {
      return [
        {
          path: [],
          code: 'statuses_unavailable',
          message: `board statuses could not be fetched (${String(err)}) — fix nothing, retry complete_task`,
        },
      ];
    }

    const existing = await this.db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.workspaceId, workspaceId));
    const existingLintable: LintableAgent[] = existing.map((a) => ({
      id: a.id,
      name: a.name,
      trigger_status: a.triggerStatus,
      trigger_jql: a.triggerJql,
      status_running: a.statusRunning,
      status_success: a.statusSuccess,
      status_failure: a.statusFailure,
      enabled: a.enabled,
    }));
    const existingNames = new Set(existing.map((a) => a.name.toLowerCase()));

    // Executor profiles resolved by NAME — must exist and be enabled.
    const profileNames = [...new Set(proposed.map((p) => p.executor))];
    const profiles = await this.db
      .select({ id: schema.executors.id, name: schema.executors.name, enabled: schema.executors.enabled })
      .from(schema.executors)
      .where(inArray(schema.executors.name, profileNames));
    const profileByName = new Map(profiles.map((p) => [p.name, p]));

    const seenNames = new Set<string>();
    proposed.forEach((agent, index) => {
      const lower = agent.name.toLowerCase();
      if (existingNames.has(lower)) {
        issues.push({
          path: ['team', 'agents', index, 'name'],
          code: 'duplicate_name',
          message: `an agent named "${agent.name}" already exists in this workspace`,
        });
      }
      if (seenNames.has(lower)) {
        issues.push({
          path: ['team', 'agents', index, 'name'],
          code: 'duplicate_name',
          message: `"${agent.name}" appears more than once in the proposal`,
        });
      }
      seenNames.add(lower);

      const profile = profileByName.get(agent.executor);
      if (!profile) {
        issues.push({
          path: ['team', 'agents', index, 'executor'],
          code: 'executor_unknown',
          message: `"${agent.executor}" is not an executor profile — use one of the profiles listed in your handoff`,
        });
      } else if (!profile.enabled) {
        issues.push({
          path: ['team', 'agents', index, 'executor'],
          code: 'executor_disabled',
          message: `executor profile "${agent.executor}" is disabled`,
        });
      }

      // lintAgent: status_absent + duplicate_trigger vs existing enabled agents
      // AND the earlier agents of this same proposal (triggers must not collide
      // within the team either).
      const priorProposal: LintableAgent[] = proposed.slice(0, index).map((p, i) => ({
        id: `proposal-${i}`,
        name: p.name,
        trigger_status: p.trigger_status,
        trigger_jql: null,
        status_running: p.status_running ?? null,
        status_success: p.status_success,
        status_failure: p.status_failure,
        enabled: true,
      }));
      const { errors } = lintAgent(
        {
          name: agent.name,
          trigger_status: agent.trigger_status,
          trigger_jql: null,
          status_running: agent.status_running ?? null,
          status_success: agent.status_success,
          status_failure: agent.status_failure,
          enabled: true,
        },
        [...existingLintable, ...priorProposal],
        boardStatuses,
      );
      issues.push(
        ...errors.map(
          (e: LintIssue): TeamIssue => ({
            path: ['team', 'agents', index, ...e.path],
            code: e.code,
            message: e.message,
          }),
        ),
      );
    });

    return issues;
  }

  // --- application (FR-016, one transaction) ---

  private async apply(
    runId: string,
    workspaceId: string,
    report: AgentReport,
    proposed: NonNullable<AgentReport['team']>['agents'],
  ): Promise<TeamAcceptResult> {
    // Re-resolve profile ids inside the same request (names validated above);
    // the insert below still races a concurrent manual create — the DB unique
    // (agents_workspace_name) is the backstop, degraded to a clean `invalid`.
    const profiles = await this.db
      .select({ id: schema.executors.id, name: schema.executors.name })
      .from(schema.executors)
      .where(inArray(schema.executors.name, [...new Set(proposed.map((p) => p.executor))]));
    const profileByName = new Map(profiles.map((p) => [p.name, p.id]));

    try {
      let applied = false;
      await this.db.transaction(async (tx) => {
        // Guarded finalize FIRST (same predicate as RunsService.guardedFinalize):
        // a concurrent duplicate complete sees 0 rows and rolls back cleanly.
        const finalized = await tx
          .update(schema.runs)
          .set({ status: 'succeeded', finishedAt: sql`now()`, outcome: 'team', report })
          .where(and(eq(schema.runs.id, runId), inArray(schema.runs.status, ACTIVE_STATUSES)))
          .returning({ id: schema.runs.id });
        if (finalized.length === 0) return; // conflict — applied stays false

        await tx.insert(schema.agents).values(
          proposed.map((p) => ({
            workspaceId,
            executorId: profileByName.get(p.executor)!,
            name: p.name,
            description: p.description,
            instruction: p.instruction,
            triggerStatus: p.trigger_status,
            triggerJql: null,
            statusRunning: p.status_running ?? null,
            statusSuccess: p.status_success,
            statusFailure: p.status_failure,
            behavior: {},
            enabled: true,
          })),
        );

        // The review gate (FR-016): one non-blocking, ticketless review task.
        await tx.insert(schema.humanTasks).values({
          workspaceId,
          runId,
          ticketId: null,
          kind: 'review',
          title: 'Team assembled — review the workspace',
          details:
            `The orchestrator proposed ${proposed.length} agent(s): ` +
            proposed.map((p) => `**${p.name}**`).join(', ') +
            '.\n\nReview and edit them in the Agents tab, then start the workspace when ready.',
          blocking: false,
          status: 'open',
        });

        if (report.checks.length > 0) {
          await tx.insert(schema.runChecks).values(
            report.checks.map((check, position) => ({
              runId,
              position,
              name: check.name,
              status: check.status,
              reason: check.reason ?? null,
            })),
          );
        }
        applied = true;
      });

      if (!applied) return { kind: 'conflict' };
      this.logger.log(`setup run ${runId}: team applied — ${proposed.length} agent(s) created (enabled), review task queued`);
      return { kind: 'applied', agentsCreated: proposed.length };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        // Raced a concurrent manual agent create on a name — whole tx rolled
        // back (no partial team), surfaced as a normal validation rejection.
        return {
          kind: 'invalid',
          issues: [
            {
              path: ['team', 'agents'],
              code: 'duplicate_name',
              message: 'an agent with one of the proposed names was created concurrently — adjust and re-submit',
            },
          ],
        };
      }
      throw err;
    }
  }

  /** FR-014: `team` from anything but an orchestrator setup run ⇒ failure. */
  private async finalizeInvalidOutcome(runId: string, report: AgentReport): Promise<boolean> {
    const failure: AgentReport = {
      schema_version: 1,
      outcome: 'failure',
      summary:
        'Agent returned an invalid "team" outcome — only the orchestrator\'s workspace-setup run may propose a team. ' +
        `Original summary: ${report.summary}`,
      checks: report.checks,
    };
    const rows = await this.db
      .update(schema.runs)
      .set({
        status: 'failed',
        finishedAt: sql`now()`,
        outcome: 'failure',
        report: failure,
        error: 'invalid team outcome from a non-setup run',
      })
      .where(and(eq(schema.runs.id, runId), inArray(schema.runs.status, ACTIVE_STATUSES)))
      .returning({ id: schema.runs.id });
    return rows.length > 0;
  }
}
