import type { WorktreeRepo } from './worktree';

/**
 * Ticket-component repository narrowing (feature 020). Pure and dependency-
 * free, like the feature-019 resolvers it composes with: the caller resolves
 * the BASE SET via `resolveRepositoryNames`/`pickWorkspaceRepositories`
 * (config-derived names stay fail-loud there), then this function FILTERS that
 * output by the ticket's Jira Components (D1 — intersection, never widening;
 * D3 — ticket-derived names filter silently, never throw). Contract + decision
 * table: specs/020-jira-components-repo-scoping/contracts/scope-resolution.md.
 */

/** The three fail-closed park conditions (D2) — each gets its own question text. */
export type ScopeCase = 'no_components' | 'no_repo_components' | 'outside_agent_scope';

/** What scoping saw and decided — recorded verbatim on the run timeline (R6/FR-015). */
export interface NarrowingDecision {
  /** Component names as seen on the ticket (null ⇔ the Jira fetch failed). */
  components: string[] | null;
  /** Components that named a workspace repository. */
  matched: string[];
  /** Components filtered out silently — no repository behind them (D3). */
  ignored: string[];
  /** Final repository names the run mounts (canonical, base-set order). */
  effective: string[];
  gate:
    | 'off'
    | 'skipped_single_repo'
    | 'passed'
    | `parked:${ScopeCase}`
    | 'failed:components_unreadable';
}

export type NarrowResult =
  | { kind: 'resolved'; repos: WorktreeRepo[]; decision: NarrowingDecision }
  | { kind: 'undeterminable'; case: ScopeCase; decision: NarrowingDecision }
  | { kind: 'components_unreadable'; decision: NarrowingDecision };

/** FR-016: exact comparison of trimmed names, case-insensitive. */
const norm = (s: string): string => s.trim().toLowerCase();

export function narrowByTicketComponents(input: {
  baseRepos: WorktreeRepo[];
  components: string[] | null;
  workspaceRepoNames: string[];
  scopingEnabled: boolean;
}): NarrowResult {
  const { baseRepos, components, workspaceRepoNames, scopingEnabled } = input;
  const baseNames = baseRepos.map((r) => r.name);

  // D2b: flag off ⇒ components are not consulted at all — byte-identical legacy path.
  if (!scopingEnabled) {
    return {
      kind: 'resolved',
      repos: baseRepos,
      decision: { components, matched: [], ignored: [], effective: baseNames, gate: 'off' },
    };
  }

  // D2a: a 0/1-element base set leaves components nothing to decide — never gate.
  if (baseRepos.length <= 1) {
    return {
      kind: 'resolved',
      repos: baseRepos,
      decision: { components, matched: [], ignored: [], effective: baseNames, gate: 'skipped_single_repo' },
    };
  }

  // R5: fetch failure means UNKNOWN, not "none" — the caller fails the run
  // rather than park with a misleading "set Components" question.
  if (components === null) {
    return {
      kind: 'components_unreadable',
      decision: {
        components: null,
        matched: [],
        ignored: [],
        effective: [],
        gate: 'failed:components_unreadable',
      },
    };
  }

  const undeterminable = (scopeCase: ScopeCase, matched: string[], ignored: string[]): NarrowResult => ({
    kind: 'undeterminable',
    case: scopeCase,
    decision: { components, matched, ignored, effective: [], gate: `parked:${scopeCase}` },
  });

  // D2 case 1: the human never expressed intent.
  const seen = components.map((c) => c.trim()).filter((c) => c.length > 0);
  if (seen.length === 0) return undeterminable('no_components', [], []);

  // D3: split components into workspace-repo names vs unrelated human vocabulary
  // ("Design", "QA", …) — the latter filter out silently, never error.
  const workspaceSet = new Set(workspaceRepoNames.map(norm));
  const matched: string[] = [];
  const ignored: string[] = [];
  const matchedSet = new Set<string>();
  for (const c of seen) {
    if (workspaceSet.has(norm(c))) {
      if (!matchedSet.has(norm(c))) {
        matchedSet.add(norm(c));
        matched.push(c);
      }
    } else if (!ignored.includes(c)) {
      ignored.push(c);
    }
  }

  // D2 case 2: intent given but unmappable — nothing names a repository.
  if (matched.length === 0) return undeterminable('no_repo_components', matched, ignored);

  // D1: intersect with the base set — components select, the base set bounds
  // and orders (never widens beyond the agent's configured scope).
  const repos = baseRepos.filter((r) => matchedSet.has(norm(r.name)));

  // D2 case 3: ticket and routing contradict each other — a routing defect.
  if (repos.length === 0) return undeterminable('outside_agent_scope', matched, ignored);

  return {
    kind: 'resolved',
    repos,
    decision: {
      components,
      matched,
      ignored,
      effective: repos.map((r) => r.name),
      gate: 'passed',
    },
  };
}

/** Display-safe inputs for the parked question — ticket key + names only (FR-009). */
export interface ScopeDisplay {
  ticketKey: string;
  components: string[];
  agentRepoNames: string[];
  workspaceRepoNames: string[];
}

/**
 * The three system-composed question texts (D2, normative wording —
 * contracts/scope-resolution.md §Question texts). Built ONLY from the ticket
 * key, component names, and repository names, so no scrubber pass is needed
 * (feature-010 system-composed precedent).
 */
export function composeScopeQuestion(
  scopeCase: ScopeCase,
  display: ScopeDisplay,
): { title: string; details: string } {
  const { ticketKey, components, agentRepoNames, workspaceRepoNames } = display;
  const list = (names: string[]): string => names.map((n) => `\`${n}\``).join(', ');
  switch (scopeCase) {
    case 'no_components':
      return {
        title: `Set Components on ${ticketKey} so the agent knows which repositories to work in`,
        details:
          `${ticketKey} has no Components, so the repository set for this run cannot be determined ` +
          `(ticket repository scoping is enabled for this workspace).\n\n` +
          `Set the ticket's **Components** field to the repositories the work touches, then resolve ` +
          `this task. Valid repository choices for this agent: ${list(agentRepoNames)}.`,
      };
    case 'no_repo_components':
      return {
        title: `None of ${ticketKey}'s components map to a repository — add the repository component`,
        details:
          `${ticketKey} carries Components ${list(components)}, but none of them names a workspace ` +
          `repository, so the repository set for this run cannot be determined.\n\n` +
          `Add the component matching the repository the work touches, then resolve this task. ` +
          `Repository components in this workspace: ${list(workspaceRepoNames)}.`,
      };
    case 'outside_agent_scope':
      return {
        title: `${ticketKey} targets repositories this agent is not configured for — check routing or the agent's scope`,
        details:
          `${ticketKey}'s Components name repositories outside this agent's configured scope — the ` +
          `ticket and the routing contradict each other (this is a routing problem, not missing ` +
          `metadata).\n\n` +
          `Ticket repositories: ${list(components)}. Agent scope: ${list(agentRepoNames)}.\n\n` +
          `Either route the ticket to the agent that owns those repositories, or widen this agent's ` +
          `repository scope, then resolve this task.`,
      };
  }
}

/**
 * Thrown by the claude_cli executor when an active gate cannot determine the
 * repository set — BEFORE any clone/worktree work. The run processor catches
 * this type specifically and delegates to HumanTaskService (guarded park);
 * it must never fall through to the generic crashed mapping.
 */
export class RepositoryScopeUndeterminableError extends Error {
  constructor(
    readonly scopeCase: ScopeCase,
    readonly display: ScopeDisplay,
    readonly decision: NarrowingDecision,
  ) {
    super(
      `repository scope undeterminable for ${display.ticketKey} (${scopeCase}) — parking to the human queue`,
    );
    this.name = 'RepositoryScopeUndeterminableError';
  }
}
