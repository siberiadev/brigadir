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
      'it to be scannable; keep `title` a plain-text one-liner. You may attach ' +
      '`options: [{label, value?, description?}]` (max 5; value defaults to label) — one-click ' +
      'suggested answers, also accepted on complete_task\'s human_task; offer them whenever the ' +
      'answer is a choice, not an essay.',
    '- mcp__brigadir__complete_task(schema_version, outcome, summary, checks[, human_task]' +
      '[, artifacts]) — finish the run. This is the single normal way to end a session.',
    'You also have read-only Jira tools — eyes, not voice: ' +
      'mcp__brigadir__get_project_overview() for the board type, workflow status names, issue ' +
      'types, and active sprint; mcp__brigadir__search_tickets(text?, status?, issue_type?) to ' +
      'find tickets in this workspace; mcp__brigadir__get_ticket(key) for a ticket\'s full ' +
      'description, latest comments, and links. Use them whenever you need more context than ' +
      'this prompt carries; they cannot change anything in Jira.',
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

/** One prepared repository as listed in the wrapper (feature 019, research D9). */
export interface WrapperRepoInfo {
  name: string;
  absPath: string;
  defaultBranch: string;
  /**
   * Feature 023: a branch a previous stage on this ticket pushed — the
   * worktree is parked at its tip. Absent ⇒ the worktree is at the default
   * branch and there is no prior work to build on.
   */
  continueBranch?: string;
  /**
   * Feature 023: the name to create if the agent branches — `branch_prefix`
   * applied to the ticket key. A HINT, not an instruction to the system: the
   * system no longer creates branches at all.
   */
  suggestedBranch?: string;
}

export interface WrapperOptions {
  useCallbackChannel: boolean;
  /** Feature 004 US6 (T115): pre-compiled, budget-bounded feature-context block. Omitted when empty. */
  featureContextSection?: string;
  /**
   * Feature 019: every repository prepared in this run's workspace. Present ⇒
   * the wrapper renders the `## Repositories` section + multi-repo conduct
   * rules (spec FR-013). Absent/empty (no-repo triage runs) ⇒ the wrapper is
   * byte-identical to the pre-019 form.
   */
  repos?: WrapperRepoInfo[];
  /**
   * Feature 020 (D4): repositories EXCLUDED by ticket-component narrowing.
   * Non-empty ⇒ the repositories section appends the `.repos/<name>` on-demand
   * self-clone note (the same escape hatch the setup protocol uses), so a
   * slightly-too-narrow scope never strands the run. Absent/empty (non-narrowed
   * runs) ⇒ the section renders byte-identical to feature 019.
   */
  onDemandRepos?: { name: string; url: string }[];
}

/**
 * The `## Repositories` section (feature 019, spec FR-013): lists every
 * prepared repo with its absolute path and branches, and instructs the agent
 * to (a) pick the repos the ticket actually needs, (b) commit/push only
 * there, (c) cross-reference dependent PRs, (d) report per-repo artifacts.
 * Deliberately NOT a behavior→wrapper compiler (research D9 — that stays
 * cut per the constitution's scope discipline).
 */
function repositoriesSection(
  repos: WrapperRepoInfo[],
  useCallbackChannel: boolean,
  onDemandRepos: { name: string; url: string }[] = [],
): string[] {
  const reportTarget = useCallbackChannel
    ? 'the `artifacts.repos` array of your complete_task call'
    : 'the `artifacts.repos` array of your final JSON report';
  // Feature 020 (D4): narrowing is a fast path, not a wall — excluded repos
  // stay reachable via the setup protocol's on-demand self-clone idiom.
  const escapeHatch =
    onDemandRepos.length > 0
      ? [
          "This ticket's Components scoped the run to the repositories above. These workspace " +
            'repositories were NOT mounted; if the task genuinely needs one, clone it on demand ' +
            'into `.repos/<name>` inside your workspace directory:',
          ...onDemandRepos.map((r) => `- ${r.name}: ${r.url}`),
        ]
      : [];
  return [
    '## Repositories',
    'Your workspace directory contains one sub-directory per repository. Each is checked out ' +
      'in DETACHED HEAD at the commit this run must start from — creating and pushing branches ' +
      'is your job, not the system\'s:',
    ...repos.map((r) =>
      r.continueBranch
        ? `- ${r.name}: ${r.absPath} (continue branch ${r.continueBranch}, based on ${r.defaultBranch})`
        : `- ${r.name}: ${r.absPath} (no prior branch; at ${r.defaultBranch}` +
          `${r.suggestedBranch ? ` — create ${r.suggestedBranch}` : ''})`,
    ),
    'Rules for working across repositories:',
    '- Decide from the ticket which of these repositories actually need changes; leave the ' +
      'others completely untouched.',
    '- Before your first commit in a repository you change, put yourself on a branch: ' +
      '`git switch -C <branch>`, using the branch named above for that repository. Never ' +
      'commit on the detached HEAD.',
    '- A "continue branch" is prior work on this ticket by an earlier stage, and your worktree ' +
      'is already at its tip. Build on it; never start a competing branch.',
    '- Commit and push only in repositories you actually changed (`git push -u origin ' +
      '<branch>`). Never commit, push, or open a PR in a repository you did not change.',
    '- If your changes in different repositories depend on each other, open a separate PR per ' +
      'repository and reference each dependent PR in the other PR\'s description.',
    '- Run the required checks/tests inside each repository you changed (and only there).',
    `- Report exactly one entry per CHANGED repository in ${reportTarget} — ` +
      '{repo, branch, pr_url, commits, files_changed} with schema_version: 2, using the ' +
      'repository names exactly as listed above. Do not report untouched repositories. The ' +
      'next stage on this ticket starts from the branch you report here, so a repository you ' +
      'changed but did not report will be invisible to it.',
    ...escapeHatch,
  ];
}

export function buildWrapperText(ctx: RunContext, worktreeDir: string, options: WrapperOptions): string {
  // Ticketless workspace-setup runs (feature 011, D4): no ticket header, no
  // description — the setup handoff (prepended to ctx.instruction) carries the
  // workspace digest and the team-proposal protocol instead.
  const header = ctx.ticket
    ? [
        `You are an autonomous coding agent working on Jira ticket ${ctx.ticket.key}: ${ctx.ticket.summary}`,
        ctx.ticket.description ? `\n${ctx.ticket.description}` : '',
      ]
    : ['You are the workspace orchestrator preparing this workspace. There is no Jira ticket for this run.'];
  const lines = [
    ...header,
    '',
    '## Your task',
    ctx.instruction,
    '',
    ...(options.repos && options.repos.length > 0
      ? [...repositoriesSection(options.repos, options.useCallbackChannel, options.onDemandRepos), '']
      : []),
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
