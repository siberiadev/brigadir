import type { RunContext } from '../agent-executor.interface';

/**
 * Instruction wrapper text (extracted from claude-cli.executor.ts, feature
 * 004 D6). Channel selection is explicit: callback-wired runs get the
 * MCP-tools section (the three `mcp__brigadir__*` tools as the ONLY voice —
 * FR-001/FR-011); everything else keeps the Phase-0 "return JSON" section
 * byte-for-byte for iteration-3 (`useCallbackChannel` omitted/false) runs.
 */

function structuredOutputSection(): string[] {
  return [
    'No MCP tools are available in this session (Phase 0). When you are completely finished, ' +
      'return your final answer strictly as JSON conforming to the provided report schema. ' +
      'Do not include any other text after the JSON.',
    '- outcome="success" ONLY if every required check actually passed in this session. Never ' +
      'claim a check passed without running it.',
    '- outcome="failure" if something required failed — report each check honestly with its ' +
      'status and reason.',
    '- outcome="needs_human" if you are blocked or requirements are ambiguous and cannot ' +
      'proceed — include a human_task describing the question or blocker.',
  ];
}

function callbackToolsSection(): string[] {
  return [
    'You have three tools to communicate with the orchestrator — they are your ONLY voice. Do ' +
      'not print a JSON report; call the tools instead.',
    '- mcp__brigadir__report_progress(stage, message[, percent]) — call this at stage boundaries ' +
      'so your progress is visible on the run timeline.',
    '- mcp__brigadir__request_human(kind, title, details, blocking) — ask a human a question or ' +
      'flag a blocker. blocking=true pauses the run until a person answers; blocking=false leaves ' +
      'a note without stopping your work. Write `details` in Markdown (headings, lists, `code`, ' +
      'fenced code blocks, **bold**, links) — a person reads it in a rendered viewer, so structure ' +
      'it to be scannable; keep `title` a plain-text one-liner.',
    '- mcp__brigadir__complete_task(schema_version, outcome, summary, checks[, human_task]' +
      '[, artifacts]) — finish the run. This is the single normal way to end a session.',
    '- outcome="success" ONLY if every required check actually passed in this session. Never ' +
      'claim a check passed without running it.',
    '- outcome="failure" if something required failed — report each check honestly with its ' +
      'status and reason.',
    '- outcome="needs_human" if you are blocked or requirements are ambiguous and cannot ' +
      'proceed — include a human_task describing the question or blocker.',
    '- You must call complete_task, or request_human with blocking=true, before your session ' +
      'ends — a session that ends silently is recorded as a failed run.',
  ];
}

export interface WrapperOptions {
  useCallbackChannel: boolean;
  /** Feature 004 US6 (T115): pre-compiled, budget-bounded feature-context block. Omitted when empty. */
  featureContextSection?: string;
}

export function buildWrapperText(ctx: RunContext, worktreeDir: string, options: WrapperOptions): string {
  const lines = [
    `You are an autonomous coding agent working on Jira ticket ${ctx.ticket.key}: ${ctx.ticket.summary}`,
    ctx.ticket.description ? `\n${ctx.ticket.description}` : '',
    '',
    '## Your task',
    ctx.instruction,
    '',
    '## How to report your result',
    ...(options.useCallbackChannel ? callbackToolsSection() : structuredOutputSection()),
    '',
    '## Rules',
    `- Work only inside this workspace directory (${worktreeDir}).`,
    '- Do not transition or comment the Jira ticket yourself — the system does that from your report.',
    ...(options.useCallbackChannel
      ? [
          '- If you cannot finish, still call complete_task with outcome="failure" or ' +
            '"needs_human" — never end the session without calling complete_task or a blocking ' +
            'request_human.',
        ]
      : [
          '- If you cannot finish, still return a JSON report with outcome="failure" or ' +
            '"needs_human" — never exit the session without one.',
        ]),
  ];

  if (options.featureContextSection) {
    lines.push('', options.featureContextSection);
  }

  return lines.join('\n');
}
