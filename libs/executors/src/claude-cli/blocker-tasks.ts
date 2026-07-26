/**
 * The three human-attention cases branch inheritance can produce (feature 032,
 * data-model.md §6).
 *
 * Each is a run-less ticket task whose TITLE carries the whole dedup tuple —
 * workspace, dependent ticket, blocker, repository, kind — behind a machine
 * prefix, so `HumanTaskService.createTicketBlockedKeyed` can dedup on title
 * equality without a new column and without widening the agent-facing
 * `HumanTaskKind` enum (plan.md Complexity Tracking).
 *
 * Details are Markdown: the queue viewer renders them, and a person triaging
 * one of these needs the fix to be scannable, not a wall of prose.
 */

export type BlockerTaskKind =
  | 'blocker_branch_lost'
  | 'blocker_merge_conflict'
  | 'blocker_repo_unmounted';

export interface BlockerTask {
  kind: BlockerTaskKind;
  title: string;
  details: string;
}

/**
 * The blocker is NOT done, yet nothing usable came back from it for this
 * repository — no succeeded run, no reported branch, or a branch that is no
 * longer on origin. The run proceeded from the default branch, which means the
 * agent cannot see work it was supposed to build on. Loud on purpose: the
 * mirror case (blocker already done ⇒ its branch is merged and gone) is silent.
 */
export function blockerBranchLostTask(opts: {
  ticketKey: string;
  blockerKey: string;
  repo: string;
  blockerStatus: string;
  defaultBranch: string;
}): BlockerTask {
  return {
    kind: 'blocker_branch_lost',
    title: `[blocker_branch_lost] ${opts.ticketKey}: no usable branch from ${opts.blockerKey} for ${opts.repo}`,
    details: [
      `**${opts.ticketKey}** is blocked by **${opts.blockerKey}**, which is still open ` +
        `(status \`${opts.blockerStatus}\`), but no branch of its work could be found for ` +
        `repository \`${opts.repo}\`.`,
      '',
      `The run started from \`${opts.defaultBranch}\` instead, so it does **not** contain ` +
        `${opts.blockerKey}'s changes.`,
      '',
      'What to check:',
      `- Did ${opts.blockerKey}'s run push its branch, and does the branch still exist on origin?`,
      `- Does ${opts.blockerKey}'s report name \`${opts.repo}\` in \`artifacts.repos\`?`,
      `- If the work is genuinely elsewhere, re-run ${opts.ticketKey} once the branch is pushed.`,
    ].join('\n'),
  };
}

/**
 * Two or more blockers left work in the SAME repository and their branches do
 * not merge cleanly. The run failed before the agent started — a
 * machine-resolved merge of two agents' work would be silent wrongness.
 */
export function blockerMergeConflictTask(opts: {
  ticketKey: string;
  repo: string;
  startBranch: string;
  mergeBranches: string[];
  blockerKeys: string[];
}): BlockerTask {
  return {
    kind: 'blocker_merge_conflict',
    title: `[blocker_merge_conflict] ${opts.ticketKey}: blocker branches conflict in ${opts.repo}`,
    details: [
      `**${opts.ticketKey}** inherits work from several blockers ` +
        `(${opts.blockerKeys.join(', ')}) in repository \`${opts.repo}\`, and their branches ` +
        'do not merge cleanly. **The run failed before the agent started** — nothing was ' +
        'committed, pushed, or resolved automatically.',
      '',
      'Merge order attempted:',
      `1. \`${opts.startBranch}\` (start point)`,
      ...opts.mergeBranches.map((b, i) => `${i + 2}. \`${b}\``),
      '',
      'How to fix:',
      '- Reconcile the blocker branches yourself (merge one into the other and push), then',
      `- re-trigger ${opts.ticketKey}; it will start from the reconciled branch.`,
    ].join('\n'),
  };
}

/**
 * A blocker reported work in a repository this run does not mount. The run
 * proceeded (the other repositories are still correct), but the dependent
 * cannot see that part of the chain — a repository-scope gap, not a git fault.
 */
export function blockerRepoUnmountedTask(opts: {
  ticketKey: string;
  blockerKey: string;
  repo: string;
}): BlockerTask {
  return {
    kind: 'blocker_repo_unmounted',
    title: `[blocker_repo_unmounted] ${opts.ticketKey}: blocker ${opts.blockerKey} has work in unmounted ${opts.repo}`,
    details: [
      `**${opts.blockerKey}** reported work in repository \`${opts.repo}\`, which the run for ` +
        `**${opts.ticketKey}** does not mount — so that work is invisible to the agent.`,
      '',
      'Either fix works:',
      `- add the Jira Component that maps to \`${opts.repo}\` to **${opts.ticketKey}**, or`,
      `- widen the agent's repository scope (\`behavior.repositories\`) to include \`${opts.repo}\`.`,
      '',
      'Repository mounting is never widened automatically — inheritance follows the scope, it ' +
        'does not override it.',
    ].join('\n'),
  };
}
