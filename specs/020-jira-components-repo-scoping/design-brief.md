# Design brief (verbatim input to /speckit-specify, 2026-07-18)

> This is the original feature description as provided. Decisions D1–D5 are settled —
> do not re-litigate them during planning. The "Implementation notes" section contains
> code pointers verified against the tree at the time of writing and is input for
> `/speckit-plan`, not part of the business specification.

# Feature: per-ticket repository scoping via Jira Components

## Context

BRIGADIR runs AI coding agents against Jira tickets. Feature 019 (commit `1513cbc`,
merged) gave a run MULTIPLE repositories: an agent declares
`behavior.repositories: string[]`, the executor resolves that to a repo list, creates
one git worktree per repo on a shared ticket branch, and the agent works across all
of them.

That scope is STATIC — a property of the agent, not the ticket. An agent configured
with 5 repositories clones all 5 for every ticket, even when the ticket touches one.
Feature 019 explicitly deferred the fix (`specs/019-multi-repo-runs/spec.md:142`):
"Inferring the repository subset from Jira labels/components — future optimization."

This feature implements it. The team already names Jira components to match
repository names.

## Target flow

    ticket Components → filter workspace repos by matching name
                      → intersect with the agent's configured scope
                      → if the result is empty/undeterminable → park to human queue
                      → else clone + worktree ONLY that set, then start the agent

## Why Components, not Labels

Components are a controlled vocabulary defined per Jira project by an admin; a user
picks from a list. Labels are free-text and instance-global, so a typo (`backand`)
would silently drop a repository from a run's scope. For a field that decides what
gets cloned, the controlled vocabulary is the correct source.

## Design decisions (settled — do not re-litigate)

**D1 — Intersection, not replacement.** Ticket components INTERSECT the agent's
scope; they never widen it. The agent's `behavior.repositories` (when non-empty) is
the BASE SET that components then filter; when the agent declares no scope, the base
set is all workspace repositories. Narrowing therefore works for configured and
unconfigured agents alike. Neither layer may expand beyond the other: a frontend-only
agent must never receive the backend repo just because the ticket lists both.

**D2 — Fail-CLOSED: undeterminable scope parks the run to the human queue.** When the
repository set cannot be determined, do NOT fall back to cloning everything — park
the run and ask a human. Three distinct conditions, each with its OWN question text
(an operator must be able to tell from the queue what to fix):

| # | Condition | What it means | Question should say |
|---|---|---|---|
| 1 | Ticket has no components | Human never expressed intent | "Set Components on this ticket so the agent knows which repositories to work in" |
| 2 | Components present, none match a workspace repo (e.g. only "Design") | Intent given but unmappable | "None of this ticket's components map to a repository — add the repository component" |
| 3 | Intersection with the agent's scope is empty | Ticket and routing contradict each other | "This ticket targets repositories this agent is not configured for — check routing or the agent's scope" |

Case 3 is a ROUTING defect, not a metadata gap. Falling back would have the wrong
agent work the ticket — strictly worse than parking.

**D2a — Gate only on genuine ambiguity.** Skip the gate entirely (use the resolved
set, no parking) when the effective base set contains exactly ONE repository — the
workspace has one repo, or the agent's scope names one. Components add no information
there and parking would be pure friction.

**D2b — Per-workspace rollout flag, default OFF.** The gate must be opt-in per
workspace. Blast radius: today no ticket is required to carry Components, so
switching this on globally would park nearly every incoming ticket at once and turn
BRIGADIR into a human-task generator that has to be drained by hand. The flag lets
the team enable one board, watch the queue, backfill Components, then widen. Without
it, rollback requires a deploy.

**D3 — Ticket-derived names FILTER; they never throw.** A real trap in the existing
code: `pickWorkspaceRepositories()` (`claude-cli.executor.ts:79`) THROWS on an unknown
repository name (line 88). That is correct for config-derived names — those passed
linter validation, so a mismatch is a bug. Jira components are the opposite contract:
humans use that field for their own purposes and it will legitimately contain values
with no repository behind them ("Design", "QA", "Documentation"). Non-matching
components must be filtered out silently while building the candidate set; only the
EMPTY RESULT is then a park condition (D2 case 2). Do NOT route config-derived and
ticket-derived names through the same fail-loud branch.

**D4 — Escape hatch for normal runs.** Worktrees are created before the agent starts,
so an agent that discovers mid-run it needs another repository is stuck. Give
ordinary runs the same self-clone escape hatch the setup protocol already has: clone
an extra repository into `.repos/<name>` on demand (see the setup-run comment at
`claude-cli.executor.ts:600`). Narrowing is a fast path, not a wall.

**D5 — Setup runs unaffected.** Setup runs keep their deliberate one-element scope
(feature 019 research D5, `claude-cli.executor.ts:598-603`).

## Resulting precedence

    base set  = agent behavior.repositories (non-empty)
              > agent behavior.repository (deprecated, one-element)
              > ALL workspace repositories
    effective = base set ∩ repos named by ticket components
    empty or undeterminable → human queue (D2), subject to D2a/D2b

## Implementation notes (verified against the tree)

The plumbing is already the right shape — repository resolution happens BEFORE any
cloning (`claude-cli.executor.ts:592-613`) and worktrees are built from the resolved
list, so there is one natural insertion point and parking there wastes no clone work.
Most of the effort is carrying a new field through the layers:

1. **Jira client** — `components` is fetched NOWHERE today. `getIssue()`
   (`libs/jira/src/basic-auth-jira.client.ts:157`) requests only
   `fields=summary,description`. Add components there and to whichever other call
   feeds the run context; extend `libs/jira/src/jira-client.interface.ts` and the
   lazy client.

2. **Execution context** — `ExecutionContext.ticket` is
   `{ key, summary, description, url } | null`
   (`libs/executors/src/agent-executor.interface.ts:23`); it needs the component
   names. DISCOVERY REQUIRED: locate what builds this object and populate it there —
   a grep for `ExecutionContext` did not surface the producer.

3. **Resolver** — `resolveRepositoryNames(behavior)` (`claude-cli.executor.ts:54`) is
   pure and unit-tested. Extend or wrap it to take the ticket's components and apply
   D1/D2a/D3, returning either a resolved set or a typed "undeterminable" reason
   (which of the three D2 cases). Keep it pure and directly unit-testable — that is
   how feature 019 built the equivalent logic.

4. **Call site** — `claude-cli.executor.ts:611` for normal runs; line 603 (setup)
   keeps today's behavior per D5.

5. **Parking** — use `HumanTaskService.createFromRequest(runId, { blocking: true, … })`
   (`libs/human-tasks/src/human-task.service.ts:62`). It parks the run, drives the
   Jira blocked-status transition and posts the question comment. Precedent for
   system-composed (non-agent) tasks: `createNonBlocking`, feature 010. Two
   constraints:
   - Parking is guarded to `status='running'` only (service comment L31, update L117).
     The run IS running at the resolution point, but honour the guard explicitly —
     CLAUDE.md rule 7 forbids process-outcome writes that clobber callback state.
   - Titles/details must be scrubbed by the caller; these are system-composed, so
     compose them safely.

6. **Resume loop already closes** — resolving the task supersedes the parked run and
   inserts a fresh `queued` run for the same ticket
   (`libs/human-tasks/src/resume.service.ts:226-245`). The new run re-resolves from
   scratch and re-reads the ticket, so: park → human sets Components → resolve → new
   run picks them up → scoped clone. No extra wiring needed for this path.

7. **Observability** — surface the narrowing decision (which components matched, which
   were ignored, whether the gate fired and under which case) so an operator can tell
   "scoped to 1 repo on purpose" from "scoping misfired". Consider the run report and
   the Jira comment composer (`libs/jira/src/adf-composer.ts`).

## Constraints

- **No DB schema change expected** — components come from Jira at run time. The
  per-workspace flag (D2b) belongs in existing workspace settings. If you conclude a
  migration is needed, STOP and justify it first: schema changes require updating
  `docs/architecture.md` §3 (CLAUDE.md rule 5).
- **Full back-compat with the flag OFF.** With D2b disabled, behaviour must be
  byte-for-byte today's: tickets without components, single-repo workspaces, agents on
  the deprecated `behavior.repository`, repo-less runs, setup runs.
- **Tests ship in the same iteration** (CLAUDE.md rule 4). Unit tests for the pure
  resolver: no components; components matching none; partial match; empty
  intersection; components naming MORE than the agent's scope (must not widen);
  deprecated-field agents; single-repo base set (D2a skip). Integration coverage
  against real Postgres/Redis via testcontainers, following
  `test/integration/claude-cli-repository.spec.ts`, plus a parking→resume→rescope
  round trip.
- Follow the repo's spec-kit process — this becomes feature 020 with the usual
  spec / plan / tasks artifacts under `specs/`.

## Acceptance criteria

1. A ticket whose components match a subset of the base set clones and mounts only
   that subset.
2. Components can never add a repository outside the agent's configured scope.
3. A component with no matching repository is ignored when others match; it does not
   fail the run.
4. With the flag ON, each of the three D2 conditions parks the run with its own
   distinct question text.
5. With the flag OFF, behaviour is identical to today in every case.
6. The gate never fires when the base set holds exactly one repository (D2a).
7. Resolving the human task produces a new run that picks up the newly-set Components
   and scopes correctly.
8. An agent can still obtain an out-of-scope repository mid-run via `.repos/<name>`.
9. Setup runs are unchanged.
10. The narrowing decision is visible to an operator after the run.
