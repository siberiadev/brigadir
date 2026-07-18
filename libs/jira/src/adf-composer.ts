import {
  normalizeReportArtifacts,
  type ADFDoc,
  type ADFNode,
  type AgentReport,
  type AnswerOption,
} from '@brigadir/contracts';

/**
 * ADF composer (contracts.md C3 / research D6). Pure: a run report → an ADF
 * document with an outcome panel, the summary, and a taskList of checks.
 * Deterministic (stable localIds) so it snapshot-tests cleanly. Comments are
 * ADF-only in Jira v3.
 */

const CHECK_GLYPH = { pass: '✅', fail: '❌', warn: '⚠', skip: '⏭' } as const;

const text = (value: string): ADFNode => ({ type: 'text', text: value });
const paragraph = (value: string): ADFNode => ({ type: 'paragraph', content: [text(value)] });

const PANEL_BY_OUTCOME = {
  success: { panelType: 'info', heading: 'Run succeeded' },
  failure: { panelType: 'error', heading: 'Run failed' },
  needs_human: { panelType: 'warning', heading: 'Run needs a human' },
  // feature 010 (FR-024): an orchestrator triage run that routed the ticket
  // back to a worker with a rework task.
  routed: { panelType: 'info', heading: 'Routed for rework' },
  // feature 011: a workspace-setup run's team proposal. Setup runs are
  // ticketless, so this panel is never actually posted to Jira — present for
  // outcome-map totality only.
  team: { panelType: 'info', heading: 'Agent team assembled' },
} as const;

export function buildRunComment(report: AgentReport): ADFDoc {
  const panelMeta = PANEL_BY_OUTCOME[report.outcome];

  const content: ADFNode[] = [
    {
      type: 'panel',
      attrs: { panelType: panelMeta.panelType },
      content: [paragraph(panelMeta.heading)],
    },
    paragraph(report.summary),
  ];

  // Name the routing target + task on a `routed` report (FR-024). Free text
  // (`task`) is already scrubbed upstream like every other report field.
  if (report.outcome === 'routed' && report.routing) {
    content.push(paragraph(`→ ${report.routing.target_agent}: ${report.routing.task}`));
  }

  if (report.checks.length > 0) {
    content.push({
      type: 'taskList',
      attrs: { localId: 'brigadir-checks' },
      content: report.checks.map((check, i) => ({
        type: 'taskItem',
        attrs: { localId: `check-${i}`, state: check.status === 'pass' ? 'DONE' : 'TODO' },
        content: [
          text(
            `${CHECK_GLYPH[check.status]} ${check.name}${check.reason ? ` — ${check.reason}` : ''}`,
          ),
        ],
      })),
    });
  }

  // Feature 019: one artifact line per repo the run reported (already scrubbed
  // upstream, like every other report field). Both forms ride the shared
  // normalizer — a legacy flat report renders one line without a repo prefix.
  const artifacts = normalizeReportArtifacts(report);
  if (artifacts.length > 0) {
    content.push({
      type: 'bulletList',
      content: artifacts.map((a) => ({
        type: 'listItem',
        content: [paragraph(formatArtifactLine(a))],
      })),
    });
  }

  return { version: 1, type: 'doc', content };
}

/** `<repo>: <branch> — <pr_url> (<n> commits, <m> files)`, absent fields omitted. */
function formatArtifactLine(a: {
  repo?: string;
  branch?: string;
  pr_url?: string;
  commits?: string[];
  files_changed?: number;
}): string {
  const head = [a.repo, a.branch].filter((v) => v !== undefined && v !== '').join(': ');
  const parts: string[] = [];
  if (head) parts.push(head);
  if (a.pr_url) parts.push(parts.length > 0 ? `— ${a.pr_url}` : a.pr_url);
  const counts: string[] = [];
  if (a.commits !== undefined) counts.push(`${a.commits.length} commit${a.commits.length === 1 ? '' : 's'}`);
  if (a.files_changed !== undefined) counts.push(`${a.files_changed} file${a.files_changed === 1 ? '' : 's'}`);
  if (counts.length > 0) parts.push(`(${counts.join(', ')})`);
  return parts.join(' ');
}

const HUMAN_TASK_KIND_HEADING = {
  question: 'Agent has a question',
  blocker: 'Agent is blocked',
  review: 'Review requested',
} as const;

/**
 * ADF comment for a human-task escalation (feature 004, FR-012). Free text
 * (`title`/`details`/`options`) MUST already be scrubbed by the caller before
 * this is built — the composer itself does no scrubbing (libs/scrubber owns
 * that). Options (feature 013) render as a plain bullet list — Jira has no
 * buttons; answering happens in the dashboard. `value` is the machine-submitted
 * string and is never rendered here.
 */
export function buildHumanTaskComment(input: {
  kind: 'question' | 'blocker' | 'review';
  title: string;
  details?: string;
  options?: AnswerOption[];
}): ADFDoc {
  const content: ADFNode[] = [
    {
      type: 'panel',
      attrs: { panelType: 'warning' },
      content: [paragraph(HUMAN_TASK_KIND_HEADING[input.kind])],
    },
    paragraph(input.title),
  ];
  if (input.details) {
    content.push(paragraph(input.details));
  }
  if (input.options && input.options.length > 0) {
    content.push(paragraph('Suggested answers:'));
    content.push({
      type: 'bulletList',
      content: input.options.map((option) => ({
        type: 'listItem',
        content: [paragraph(option.description ? `${option.label} — ${option.description}` : option.label)],
      })),
    });
  }
  return { version: 1, type: 'doc', content };
}
