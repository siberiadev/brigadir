import { and, eq } from 'drizzle-orm';
import { type BrigadirDb, schema } from '@brigadir/database';
import type { AgentReport, TriggerEvent } from '@brigadir/contracts';
import { getReworkBudget } from './rework-budget';

/**
 * Handoff section (feature 010, FR-012/013, contract handoff-section.md) — an
 * EPHEMERAL prompt block assembled at `RunContext` build time by the run
 * processors. It is NEVER persisted; the agent's stored `instruction` is
 * untouched (SC-002). Both processors prepend it to the assembled instruction.
 *
 * Contract guarantees:
 *  - Best-effort: any missing source row degrades the section (omits that line),
 *    never throws, never fails the run.
 *  - Size-bounded: every embedded free-text field is truncated to a fixed budget
 *    so the block cannot blow the prompt.
 *  - Read-only, own data: reads only the system's own run history / human tasks
 *    (never Jira, never the repo).
 *  - Returns `''` when the trigger carries no handoff source.
 */
export async function buildHandoffSection(
  triggerEvent: TriggerEvent | null | undefined,
  db: BrigadirDb,
): Promise<string> {
  const source = triggerEvent?.source;
  try {
    switch (source) {
      case 'triage':
        return await buildTriageSection(triggerEvent!, db);
      case 'rework':
        return await buildReworkSection(triggerEvent!, db);
      case 'human-resume':
        return await buildHumanResumeSection(triggerEvent!, db);
      default:
        return '';
    }
  } catch {
    // Best-effort (FR-013): a handoff-assembly fault must never fail the run.
    return '';
  }
}

// Per-field truncation budgets (chars) — keep the block bounded (FR-013).
const SUMMARY_BUDGET = 1500;
const REASON_BUDGET = 400;
const DESCRIPTION_BUDGET = 300;
const TASK_BUDGET = 4000; // already schema-capped; belt-and-suspenders.
const DETAILS_BUDGET = 4000;

function trunc(value: string, budget: number): string {
  return value.length <= budget ? value : `${value.slice(0, budget)}…`;
}

interface FailingRunFacts {
  workspaceId: string;
  ticketId: string;
  report: AgentReport | null;
}

async function loadFailingRun(
  db: BrigadirDb,
  failingRunId: string | undefined,
): Promise<FailingRunFacts | undefined> {
  if (!failingRunId) return undefined;
  const [row] = await db
    .select({
      workspaceId: schema.runs.workspaceId,
      ticketId: schema.runs.ticketId,
      report: schema.runs.report,
    })
    .from(schema.runs)
    .where(eq(schema.runs.id, failingRunId))
    .limit(1);
  if (!row) return undefined;
  return {
    workspaceId: row.workspaceId,
    ticketId: row.ticketId,
    report: (row.report as AgentReport | null) ?? null,
  };
}

/** Failing-summary + failed/warning checks + artifacts lines (shared by both kinds). */
function failureLines(report: AgentReport | null, opts: { includeWarnings: boolean }): string[] {
  const lines: string[] = [];
  if (report?.summary) {
    lines.push(`Failing run: ${trunc(report.summary, SUMMARY_BUDGET)}`);
  }
  const relevant = (report?.checks ?? []).filter((c) =>
    opts.includeWarnings ? c.status === 'fail' || c.status === 'warn' : c.status === 'fail',
  );
  if (relevant.length > 0) {
    lines.push('Failed/warning checks:');
    for (const c of relevant) {
      lines.push(`- ${c.name}: ${c.status}${c.reason ? ` — ${trunc(c.reason, REASON_BUDGET)}` : ''}`);
    }
  }
  const artifacts = report?.artifacts;
  if (artifacts?.branch || artifacts?.pr_url) {
    const parts: string[] = [];
    if (artifacts.branch) parts.push(`branch ${artifacts.branch}`);
    if (artifacts.pr_url) parts.push(`PR ${artifacts.pr_url}`);
    lines.push(`Artifacts: ${parts.join(', ')}`);
  }
  return lines;
}

async function buildTriageSection(triggerEvent: TriggerEvent, db: BrigadirDb): Promise<string> {
  const failing = await loadFailingRun(db, triggerEvent.failing_run_id);

  const lines: string[] = [
    '## Handoff — triage',
    'A worker run failed on this ticket. Decide how to proceed.',
    '',
  ];

  lines.push(...failureLines(failing?.report ?? null, { includeWarnings: true }));
  lines.push('');

  // Worker roster (enabled, non-orchestrator) — name + description (FR-020).
  if (failing?.workspaceId) {
    const roster = await db
      .select({ name: schema.agents.name, description: schema.agents.description })
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.workspaceId, failing.workspaceId),
          eq(schema.agents.enabled, true),
          eq(schema.agents.isOrchestrator, false),
        ),
      );
    if (roster.length > 0) {
      lines.push('Available worker agents (route to one of these by name):');
      for (const a of roster) {
        lines.push(`- ${a.name}${a.description ? `: ${trunc(a.description, DESCRIPTION_BUDGET)}` : ''}`);
      }
      lines.push('');
    }

    const budget = await getReworkBudget(db, failing.ticketId, failing.workspaceId);
    lines.push(`Rework cycles used: ${budget.cycleCount} of ${budget.max}`);
    lines.push('');
  }

  lines.push('Decision protocol:');
  lines.push(
    '- Reply with outcome "routed" (target_agent + task) to send it back to a worker, OR',
  );
  lines.push(
    '- outcome "needs_human" to escalate. Do not exceed the rework budget — the system enforces it.',
  );

  return lines.join('\n');
}

async function buildReworkSection(triggerEvent: TriggerEvent, db: BrigadirDb): Promise<string> {
  const failing = await loadFailingRun(db, triggerEvent.failing_run_id);

  const lines: string[] = [
    '## Handoff — rework (fix of existing work)',
    'This is a FIX of existing work, not a fresh implementation. Continue on the existing branch/PR.',
    '',
  ];

  if (triggerEvent.task) {
    lines.push('Task from the orchestrator:');
    lines.push(trunc(triggerEvent.task, TASK_BUDGET));
    lines.push('');
  }

  const report = failing?.report ?? null;
  if (report?.summary) {
    lines.push(`Original failure: ${trunc(report.summary, SUMMARY_BUDGET)}`);
  }
  const failedChecks = (report?.checks ?? []).filter((c) => c.status === 'fail');
  if (failedChecks.length > 0) {
    lines.push('Failed checks:');
    for (const c of failedChecks) {
      lines.push(`- ${c.name}: fail${c.reason ? ` — ${trunc(c.reason, REASON_BUDGET)}` : ''}`);
    }
  }
  const artifacts = report?.artifacts;
  if (artifacts?.branch || artifacts?.pr_url) {
    const parts: string[] = [];
    if (artifacts.branch) parts.push(`branch ${artifacts.branch}`);
    if (artifacts.pr_url) parts.push(`PR ${artifacts.pr_url}`);
    lines.push(`Continue on: ${parts.join(', ')}`);
  }

  return lines.join('\n');
}

async function buildHumanResumeSection(
  triggerEvent: TriggerEvent,
  db: BrigadirDb,
): Promise<string> {
  const lines: string[] = [
    '## Handoff — human answer',
    'You earlier asked for help. A human responded.',
    '',
  ];

  if (triggerEvent.human_task_id) {
    const [task] = await db
      .select({ title: schema.humanTasks.title, details: schema.humanTasks.details })
      .from(schema.humanTasks)
      .where(eq(schema.humanTasks.id, triggerEvent.human_task_id))
      .limit(1);
    if (task?.title) {
      lines.push(`Question: ${trunc(task.title, SUMMARY_BUDGET)}`);
      if (task.details) lines.push(trunc(task.details, DETAILS_BUDGET));
      lines.push('');
    }
  }

  const answer = triggerEvent.resolution;
  if (answer) {
    lines.push(`Answer: ${trunc(answer, DETAILS_BUDGET)}`);
  }

  return lines.join('\n');
}
