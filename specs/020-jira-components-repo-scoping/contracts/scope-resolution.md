# Contract: `narrowByTicketComponents()` — pure scope resolver

**Module**: `libs/executors/src/claude-cli/scope-ticket.ts` (new, dependency-free, unit-tested like `pick-repository.spec.ts`)

## Signature

```ts
narrowByTicketComponents(input: {
  baseRepos: WorktreeRepo[];        // output of today's resolveRepositoryNames → resolveRepositories (unchanged, fail-loud for config names)
  components: string[] | null;      // RunContext.ticket.components; null = Jira fetch failed
  workspaceRepoNames: string[];     // ALL workspace repository names (for case-2 vs case-3 classification)
  scopingEnabled: boolean;          // WorkspaceSettings.ticket_scoping === true
}): NarrowResult                    // see data-model.md §3
```

Matching: `trim().toLowerCase()` equality on names; duplicates collapse; `resolved.repos`
preserves `baseRepos` order (feature-019 declaration-order convention).

## Decision table (normative — one unit test per row minimum)

| # | scopingEnabled | baseRepos | components | Result | gate |
|---|---|---|---|---|---|
| 1 | false | any | any (incl. null) | `resolved`, repos = baseRepos | `off` |
| 2 | true | length 0 or 1 | any (incl. null) | `resolved`, repos = baseRepos | `skipped_single_repo` (D2a; length 0 = repo-less, nothing to gate) |
| 3 | true | ≥ 2 | `null` | `components_unreadable` (caller fails the run — R5) | `failed:components_unreadable` |
| 4 | true | ≥ 2 | `[]` | `undeterminable`, case `no_components` | `parked:no_components` |
| 5 | true | ≥ 2 | none matches any `workspaceRepoNames` (e.g. `["Design","QA"]`) | `undeterminable`, case `no_repo_components` | `parked:no_repo_components` |
| 6 | true | ≥ 2 | matches workspace repos, but ∩ baseRepos = ∅ | `undeterminable`, case `outside_agent_scope` | `parked:outside_agent_scope` |
| 7 | true | ≥ 2 | subset of baseRepos names | `resolved`, repos = that subset | `passed` |
| 8 | true | ≥ 2 | mix of matching + non-repo names ("A", "Design") | `resolved`, repos = ["A"]; "Design" in `ignored` (D3) | `passed` |
| 9 | true | ≥ 2 | names ⊃ agent scope (base + others) | `resolved`, repos = intersection ONLY (never widens, D1) | `passed` |
| 10 | true | ≥ 2 | case/whitespace variants of repo names | `resolved`, matched case-insensitively on trimmed names (FR-016) | `passed` |

Invariants: `effective ⊆ baseRepos` in every row; rows 4–6 are the ONLY paths to
`undeterminable`; ticket-derived names NEVER reach `pickWorkspaceRepositories`' throw (D3) —
this function only filters the already-resolved base set.

## Question texts (D2 — normative wording, one per case)

Composed by the caller from display-safe fields only (ticket key, component names,
repository names, agent scope names); no scrubber pass needed by construction (FR-009).

| Case | title | details must convey |
|---|---|---|
| `no_components` | `Set Components on <TICKET> so the agent knows which repositories to work in` | Ticket has no Components; list the workspace repository names that are valid choices for this agent. |
| `no_repo_components` | `None of <TICKET>'s components map to a repository — add the repository component` | List the components seen and the repository names that would match. |
| `outside_agent_scope` | `<TICKET> targets repositories this agent is not configured for — check routing or the agent's scope` | List the matched repository names vs the agent's configured scope. Routing defect, not a metadata gap. |

Delivered via `HumanTaskService.createFromRequest(runId, { kind: 'blocker', blocking: true, title, details })`
— guarded park, one-open-task dedup, Jira blocked transition + question comment (existing behavior).

## Error contract at the executor boundary

- `undeterminable` → executor throws `RepositoryScopeUndeterminableError` (carries `case` +
  display fields) BEFORE any clone/worktree call. `ClaudeCliRunProcessor` MUST catch this
  type before its generic `crashed` mapping, delegate to `HumanTaskService`, record the run
  event, and return WITHOUT finalizing the run.
- `components_unreadable` → executor throws a plain `Error` (message names the ticket and
  the fact the gate was active) → existing `crashed` mapping → run `failed` with diagnostics.
- Setup runs (D5) and the mock path (R9) never call this function.
