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
    'Infrastructure failure handling: if any `mcp__brigadir__*` tool fails three times in a row ' +
      'with `network error` or `fetch failed`, immediately call ' +
      "mcp__brigadir__request_human(blocking=true, title='MCP callback channel unreachable', " +
      'details=...) and stop the session. Do not retry the same tool more than three times ' +
      'yourself.',
    // Token-spend problem 1 (analysis 2026-07-28): every polling turn re-reads
    // the whole cached context — waiting must END the session, never loop in
    // it. Enforced at the boundary by the PreToolUse bash-guard.
    'Never wait in-session for ANY precondition — not CI, not a deploy, not another ticket, not ' +
      'a human answer, not infrastructure recovery. Do not use `ScheduleWakeup`, `Bash sleep`, ' +
      'or `until false` polling loops to wait; sleep-based waiting is blocked by the harness. ' +
      'If forward progress needs a condition that does not hold right now, end the session ' +
      'instead: call mcp__brigadir__request_human(blocking=true, ...) when a person must act or ' +
      'answer, or mcp__brigadir__complete_task(outcome="failure" or "needs_human") describing ' +
      'exactly what you are waiting for — the platform restarts the run when the condition ' +
      'holds.',
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

/**
 * QA / verification conduct (incident 2026-07-19, Problem 4). A QA agent
 * (Cyrus Smith on ST3-872) booted a full dev stack inside its run — `docker
 * compose`, `npm ci`, `nohup npm run start:dev`, live JSON-RPC — and burned the
 * entire 45-minute budget into a `timed_out`. Callback-channel only: the escape
 * hatch is `mcp__brigadir__request_human(blocking=true)`, which does not exist
 * on the Phase-0 structured-output channel (kept byte-identical). Mirrors the
 * `callbackToolsSection()` style.
 */
function verificationSection(): string[] {
  return [
    '## Verification and QA',
    'When you verify or QA changes, do the cheap thing first — do NOT stand up a full ' +
      'development stack inside this run.',
    '- Do not boot a full dev stack (`docker compose up`, `npm ci`, a long-running ' +
      '`npm run start:dev` / `npm run dev`, or any equivalent) if bringing it up would take more ' +
      'than about 5 minutes. It routinely eats the whole run budget and is a leading cause of ' +
      'runs timing out with nothing to show.',
    '- Prefer unit tests, integration tests, and static analysis (type-check, lint, build) — they ' +
      'give you the same confidence in seconds instead of minutes, and are what the required ' +
      'checks actually gate on.',
    '- If live end-to-end testing is genuinely critical, first check whether the services are ' +
      'ALREADY running and reachable (e.g. curl / health-check the expected host:port) and use ' +
      'them if so. If they are NOT reachable, do not try to boot them yourself — call ' +
      "mcp__brigadir__request_human(blocking=true, title='Live test environment unavailable', " +
      'details=...) explaining exactly what environment you need, and stop.',
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
   * branch and there is no prior work to build on, and the agent names its
   * own branch (feature 024 dropped the system-suggested name).
   */
  continueBranch?: string;
  /**
   * Feature 032: where this repository's start point came from. Absent ⇒
   * `default` / `continue_own` as implied by `continueBranch`, so pre-032
   * callers render byte-identically (FR-016).
   */
  provenance?: 'default' | 'continue_own' | 'inherited_blocker' | 'merged_blockers';
  /** The blocker whose branch this repository starts from (`inherited_blocker`). */
  blockerKey?: string;
  /** Every blocker branch folded into the start point, in merge order. */
  mergedFrom?: { key: string; branch: string }[];
}

/** One direct blocker of this ticket, as listed in the wrapper (feature 032). */
export interface LinkedTicketEntry {
  key: string;
  status: string;
  branch?: string;
  prUrl?: string;
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
  /**
   * Feature 032: this ticket's DIRECT blockers and what they left behind.
   * Non-empty ⇒ the wrapper renders the `## Linked tickets` block. Facts only
   * (D7) — the agent is told what exists, never instructed to merge or chase
   * anything. Rendered for BOTH channels: workspace facts are not a channel
   * protocol. Absent/empty ⇒ byte-identical to feature 020 (FR-016).
   */
  linkedTickets?: LinkedTicketEntry[];
}

/** Cap on the `## Linked tickets` block — a prompt is a budget, not a dump. */
const LINKED_TICKETS_MAX = 10;
const LINKED_TICKET_LINE_MAX = 200;

/**
 * The `## Linked tickets` block (feature 032): this ticket's direct blockers,
 * nearest first (direct blockers only — the transitive closure is not the
 * agent's problem), sorted by key for determinism, capped so a fan-in of 40
 * cannot crowd out the actual task.
 */
function linkedTicketsSection(entries: LinkedTicketEntry[]): string[] {
  const sorted = [...entries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const shown = sorted.slice(0, LINKED_TICKETS_MAX);
  const lines = shown.map((e) => {
    const parts = [`- ${e.key} [${e.status}]`];
    if (e.branch) parts.push(`branch: ${e.branch}`);
    if (e.prUrl) parts.push(`PR: ${e.prUrl}`);
    const line = parts.join(' ');
    return line.length > LINKED_TICKET_LINE_MAX ? `${line.slice(0, LINKED_TICKET_LINE_MAX - 1)}…` : line;
  });
  return [
    '## Linked tickets',
    'This ticket is blocked by the ticket(s) below. Where a branch is named, your worktree for ' +
      'that repository already starts from it — the work is present, not something you need to ' +
      'fetch or merge:',
    ...lines,
    ...(sorted.length > shown.length
      ? [`(+${sorted.length - shown.length} more blocker(s) not listed)`]
      : []),
  ];
}

/**
 * The `## Repositories` section (feature 019, spec FR-013): lists every
 * prepared repo with its absolute path and branches, and instructs the agent
 * to (a) pick the repos the ticket actually needs, (b) commit/push only
 * there, (c) cross-reference dependent PRs, (d) report per-repo artifacts.
 * Deliberately NOT a behavior→wrapper compiler (research D9 — that stays
 * cut per the constitution's scope discipline).
 */
/**
 * One repository's line in the `## Repositories` list.
 *
 * The two feature-032 variants state FACTS about the start point and the PR
 * base (D7) — they never tell the agent to merge or to chase a blocker. The
 * "do not modify unless the task says so" clause on an inherited repo is the
 * load-bearing part: a dependent's agent looking at unfamiliar code in a repo
 * it merely READS would otherwise be tempted to "fix" its blocker's work.
 */
function repoLine(r: WrapperRepoInfo): string {
  const provenance =
    r.provenance ?? (r.continueBranch ? 'continue_own' : 'default');
  switch (provenance) {
    case 'inherited_blocker':
      return (
        `- ${r.name}: ${r.absPath} (DEPENDENCY — branch ${r.continueBranch} from ${r.blockerKey}, ` +
        `not yet in ${r.defaultBranch}; read it and build against it, do not modify it unless the ` +
        'task says so)'
      );
    case 'merged_blockers': {
      const from = (r.mergedFrom ?? [])
        .map((m) => `${m.branch} from ${m.key}`)
        .join(' merged with ');
      return (
        `- ${r.name}: ${r.absPath} (continues ${from} — already in your start point; open your PR ` +
        `against ${r.continueBranch}, not ${r.defaultBranch})`
      );
    }
    case 'continue_own':
      return `- ${r.name}: ${r.absPath} (continue branch ${r.continueBranch}, based on ${r.defaultBranch})`;
    default:
      return `- ${r.name}: ${r.absPath} (no prior branch; at ${r.defaultBranch})`;
  }
}

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
    ...repos.map((r) => repoLine(r)),
    'Rules for working across repositories:',
    '- Decide from the ticket which of these repositories actually need changes; leave the ' +
      'others completely untouched.',
    '- Before your first commit in a repository you change, put yourself on a branch with ' +
      '`git switch -C <branch>`: continue the branch listed above when there is one; otherwise ' +
      'create a branch of your own choosing and report it. The system suggests no name and ' +
      'creates no branch. Never commit on the detached HEAD.',
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
      'changed but did not report will be invisible to it — and completing with local commits ' +
      'in a repository you did not report is rejected: you will be asked to push and report it.',
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
    // Feature 032: what this ticket is chained to. Facts, both channels.
    ...(options.linkedTickets && options.linkedTickets.length > 0
      ? [...linkedTicketsSection(options.linkedTickets), '']
      : []),
    '## How to report your result',
    ...(options.useCallbackChannel ? callbackToolsSection() : structuredOutputSection()),
    // Problem 4 (incident 2026-07-19): keep QA runs from booting a full dev
    // stack. Callback channel only — Phase 0 stays byte-identical.
    ...(options.useCallbackChannel ? ['', ...verificationSection()] : []),
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
