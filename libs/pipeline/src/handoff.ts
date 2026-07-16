import { and, eq } from 'drizzle-orm';
import { type BrigadirDb, schema, getWorkspaceSetupInstruction } from '@brigadir/database';
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
  // feature 011: the workspace-setup section is anchored on the RUN's workspace
  // (the trigger carries no run refs) — processors pass it; absent ⇒ the setup
  // branch degrades to '' like any other missing source (best-effort).
  ctx?: { workspaceId?: string },
): Promise<string> {
  const source = triggerEvent?.source;
  try {
    switch (source) {
      case 'triage':
        return await buildTriageSection(triggerEvent!, db);
      case 'answer-triage':
        return await buildAnswerTriageSection(triggerEvent!, db);
      case 'rework':
        return await buildReworkSection(triggerEvent!, db);
      case 'human-resume':
        return await buildHumanResumeSection(triggerEvent!, db);
      case 'workspace-setup':
        return ctx?.workspaceId
          ? await buildWorkspaceSetupSection(triggerEvent!, db, ctx.workspaceId)
          : '';
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
// The editable workspace-setup protocol is schema-capped at 20k; same cap here
// so a stored value never exceeds what the PUT would accept.
const SETUP_PROTOCOL_BUDGET = 20000;

function trunc(value: string, budget: number): string {
  return value.length <= budget ? value : `${value.slice(0, budget)}…`;
}

interface FailingRunFacts {
  workspaceId: string;
  // Null when the referenced run is ticketless (feature 011) — the roster/budget
  // block degrades away (best-effort, FR-013 of 010).
  ticketId: string | null;
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

/**
 * Worker roster (enabled, non-orchestrator; FR-020) + the rework-cycle count —
 * shared by the triage and answer-triage sections, byte-identical to the
 * original triage rendering.
 */
async function rosterAndBudgetLines(
  db: BrigadirDb,
  workspaceId: string,
  ticketId: string,
): Promise<{ lines: string[]; budgetAvailable: boolean }> {
  const lines: string[] = [];
  const roster = await db
    .select({
      key: schema.agents.key,
      name: schema.agents.name,
      role: schema.agents.role,
      description: schema.agents.description,
    })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.workspaceId, workspaceId),
        eq(schema.agents.enabled, true),
        eq(schema.agents.isOrchestrator, false),
      ),
    );
  if (roster.length > 0) {
    // feature 014: route by KEY — target_agent = the key, copied EXACTLY as listed.
    lines.push('Available worker agents (to route, set routing.target_agent to the KEY — the first token on each line — copied exactly):');
    for (const a of roster) {
      const who = a.role ? `${a.name} (${a.role})` : a.name;
      lines.push(`- ${a.key} — ${who}${a.description ? `: ${trunc(a.description, DESCRIPTION_BUDGET)}` : ''}`);
    }
    lines.push('');
  }

  const budget = await getReworkBudget(db, ticketId, workspaceId);
  lines.push(`Rework cycles used: ${budget.cycleCount} of ${budget.max}`);
  lines.push('');
  return { lines, budgetAvailable: budget.available };
}

const DECISION_PROTOCOL_LINES = [
  'Decision protocol:',
  '- Reply with outcome "routed" (target_agent = the worker KEY from the roster above, + task) to send it back to a worker, OR',
  '- outcome "needs_human" to escalate. Do not exceed the rework budget — the system enforces it.',
];

async function buildTriageSection(triggerEvent: TriggerEvent, db: BrigadirDb): Promise<string> {
  const failing = await loadFailingRun(db, triggerEvent.failing_run_id);

  const lines: string[] = [
    '## Handoff — triage',
    'A worker run failed on this ticket. Decide how to proceed.',
    '',
  ];

  lines.push(...failureLines(failing?.report ?? null, { includeWarnings: true }));
  lines.push('');

  if (failing?.workspaceId && failing.ticketId !== null) {
    const rb = await rosterAndBudgetLines(db, failing.workspaceId, failing.ticketId);
    lines.push(...rb.lines);
  }

  lines.push(...DECISION_PROTOCOL_LINES);

  return lines.join('\n');
}

/**
 * Answer-triage (delta on feature 010): a human resolved a blocking task with
 * the orchestrator as the resume target. Same decision material as `triage`,
 * plus the Q&A up top — the answer is the primary input to the decision. When
 * the budget is exhausted, the section says routing is still permitted: the
 * human answer grants one more cycle (`processOrchestratorDecision` exempts
 * this decision from the exhausted-budget override).
 */
async function buildAnswerTriageSection(
  triggerEvent: TriggerEvent,
  db: BrigadirDb,
): Promise<string> {
  const failing = await loadFailingRun(db, triggerEvent.failing_run_id);

  const lines: string[] = [
    '## Handoff — triage (human answered)',
    'A blocked question on this ticket received a human answer. Read the Q&A first and let the answer drive your decision.',
    '',
  ];

  const qa = await questionAnswerLines(triggerEvent, db);
  if (qa.length > 0) {
    lines.push(...qa);
    lines.push('');
  }

  lines.push(...failureLines(failing?.report ?? null, { includeWarnings: true }));
  lines.push('');

  if (failing?.workspaceId && failing.ticketId !== null) {
    const rb = await rosterAndBudgetLines(db, failing.workspaceId, failing.ticketId);
    lines.push(...rb.lines);
    if (!rb.budgetAvailable) {
      lines.push(
        'The rework budget above is exhausted, but because a human answered, the system permits ONE more rework cycle for this decision.',
      );
      lines.push('');
    }
  }

  lines.push(...DECISION_PROTOCOL_LINES);

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

/**
 * `Question:`/`Answer:` lines from the human task + operator resolution —
 * shared by the human-resume and answer-triage sections, byte-identical to the
 * original human-resume rendering.
 */
async function questionAnswerLines(
  triggerEvent: TriggerEvent,
  db: BrigadirDb,
): Promise<string[]> {
  const lines: string[] = [];
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
  return lines;
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

  lines.push(...(await questionAnswerLines(triggerEvent, db)));

  return lines.join('\n');
}

/**
 * Workspace-setup section (feature 011, D13 / contracts/handoff-setup.md):
 * the project digest (DB-only — workspace row, repositories, enabled executor
 * profiles) + the study/deliver protocol. Live board data (workflow statuses,
 * issue types, tickets) deliberately arrives through the read-only Jira tools,
 * keeping this assembly non-blocking on Jira like every other handoff branch.
 * When resumed from a parked question, the Q&A block is appended.
 */
async function buildWorkspaceSetupSection(
  triggerEvent: TriggerEvent,
  db: BrigadirDb,
  workspaceId: string,
): Promise<string> {
  const [ws] = await db
    .select({
      name: schema.workspaces.name,
      projectKey: schema.workspaces.jiraProjectKey,
      boardType: schema.workspaces.jiraBoardType,
      settings: schema.workspaces.settings,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  if (!ws) return '';

  const lines: string[] = [
    '## Workspace setup',
    `You are preparing the agent team for workspace "${trunc(ws.name, DESCRIPTION_BUDGET)}" ` +
      `(Jira project ${ws.projectKey}${ws.boardType ? `, ${ws.boardType} board` : ''}).`,
    'No worker agents exist yet. Study the project, then propose the team.',
    '',
  ];

  const repositories = ((ws.settings as { repositories?: { name?: string }[] } | null)?.repositories ?? [])
    .map((r) => r?.name)
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
  if (repositories.length > 0) {
    lines.push(`Repositories: ${repositories.map((r, i) => (i === 0 ? `${r} (default)` : r)).join(', ')}`);
  }

  const profiles = await db
    .select({
      name: schema.executors.name,
      type: schema.executors.type,
      config: schema.executors.config,
    })
    .from(schema.executors)
    .where(eq(schema.executors.enabled, true));
  if (profiles.length > 0) {
    lines.push('Executor profiles available (reference by NAME):');
    for (const p of profiles) {
      const model = (p.config as { model?: string } | null)?.model;
      lines.push(`- ${p.name} — ${p.type}${model ? ` (${model})` : ''}`);
    }
  }
  lines.push('');

  // The study/name/deliver protocol is an OPERATOR-EDITABLE global setting
  // (2026-07-16, `workspace_setup_instruction`), read live so an edit applies
  // to the very next generate-agents run. The built-in default lives in
  // @brigadir/contracts (orchestrator-defaults.ts). Bounded like every other
  // handoff field — an oversized custom text must not blow the prompt.
  lines.push(trunc(await getWorkspaceSetupInstruction(db), SETUP_PROTOCOL_BUDGET));

  const qa = await questionAnswerLines(triggerEvent, db);
  if (qa.length > 0) {
    lines.push('', 'Earlier question and the operator\'s answer:');
    lines.push(...qa);
  }

  return lines.join('\n');
}
