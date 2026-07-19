# Research — Branch Handoff Between Pipeline Stages (023)

## D1 — Detached worktree, not "attach the existing branch"

Attaching (`git worktree add <dir> <branch>`) needs a local `refs/heads/<branch>` that is not checked out in another worktree. Both are stateful preconditions on a long-lived shared cache clone, and both are what produced ST3-780. `--detach` takes any commit-ish with no preconditions.

Decided: always detached. Consequences worth stating plainly:

- `git branch -D` leaves the codebase. There is no longer any code path that CAN discard prior work, which is why the leftover guard needs no replacement rather than a weaker successor.
- The cache's `refs/heads/*` stops accreting one branch per run forever.
- The agent must `git switch -C <branch>` before its first commit; the wrapper says so. `-C` (not `-c`) so an inert leftover local branch from a pre-023 run cannot break the agent's first command.

Rejected: keeping system-created branches with a smarter reuse rule. It preserves the system's need to defend a name it invented, and every rule for "may this run reuse it?" is an inference about intent — the class of reasoning that broke.

## D2 — Report-driven, verified against git

Three options were weighed:

| | Catches | Cost |
|---|---|---|
| Report only | the happy path | a missing branch becomes a hard git error or a silent wrong base |
| Discovery only (glob origin for the ticket key) | crash-before-report, mis-reports | reintroduces a naming convention as load-bearing; ambiguous when several refs mention the ticket |
| Report, verified on origin | the happy path + a named-but-absent branch, loudly | one extra ref check |

Decided: the third. Note that discovery would have been ambiguous on ST3-780 itself — both `016-st3-780-…` and `run/ST3-780` mention the key — precisely in the situation it was supposed to rescue. The report is what disambiguates; git is what verifies.

Deferred, not dismissed: discovery remains the right rescue for "the agent committed, pushed, and died before reporting". It needs a decision about ambiguity that this change does not have to make.

## D3 — Verify against `refs/remotes/origin/*`, and prune

A local head in the shared cache may be an inert leftover from a pre-023 run and proves nothing about what a previous stage pushed. Only origin is evidence.

This makes `git fetch --prune` load-bearing rather than hygiene: without it, a branch deleted upstream lingers in `refs/remotes/*` forever and a run would silently start from its stale tip — a failure with no error message anywhere. `--prune` removes remote-tracking refs only (never local branches, never objects) and rides the fetch already performed. Rejected `git ls-remote` for the same job: a second network round-trip and a second auth surface per repo, for information the fetch already carries.

A dedicated test pins this by deleting a branch upstream after the cache is warm.

## D4 — Fail loud on an explicitly-named miss; stay silent on absence

The asymmetry is the safety property:

- **Named but absent → crash.** The alternative is a reviewer silently reviewing `main`, finding nothing, and returning `outcome: success`. A wrong success in an autonomous pipeline is invisible until the ticket ships unreviewed.
- **Not named → default branch, silently.** A repo the previous stage never touched has no prior work, which is ordinary, not exceptional.

Without this asymmetry the feature degenerates into the same implicit magic it replaced, wearing a different hat.

## D5 — Strict repo-name matching

`artifacts.repos[].repo` is unconstrained (`min(1).max(200)`), secret-scrubbed, agent-authored text that now decides which commit a stage starts from. Matching is exact, then one case-insensitive fallback, then nothing. No substring or fuzzy matching: starting a stage on the wrong repository is worse than starting it from the default branch.

The flat v1 form carries no repo name. It is single-repo by definition, so it is attributed only when exactly one repository is mounted; with two, attribution would be a guess.

An unmatched name is recorded, not fatal — under feature 020 an agent may legitimately have self-cloned an out-of-scope repo into `.repos/<name>` and reported it.

## D6 — Prior-work lookup: prefer the named run, scan a window

`failing_run_id` (rework / human-resume / triage) is loaded **without** a status filter: a `needs_human` or `failed` attempt that committed and reported a branch is a legitimate continuation point, and human-resume targets exactly that shape.

If that run reported nothing, the lookup falls through to the latest `succeeded` run rather than to the default branch — this is the ST3-780 reviewer's own shape (crashed before reporting), and its rework belongs on the developer's branch.

The scan uses `limit(5)`, not `limit(1)`: a successful stage that changed nothing (a reviewer that only read) reports no artifacts and must not blank the chain. Same reasoning and same constant as `latestArtifacts` in `feature-context.ts`. The query is served by the existing `runs_ticket` index; `ticketId` is workspace-unique via the tickets FK, so no workspace filter is needed.

The lookup is deliberately NOT best-effort: a failed read means we cannot tell whether prior work exists, and silently starting from the default branch is the D4 false-success mode arriving through the back door.

## D7 — Where the code lives

`prior-work.ts` sits beside `feature-context.ts` in `libs/executors/src/claude-cli/`, which already owns "read a previous run's report artifacts" and already imports `normalizeReportArtifacts`. Shape follows `getReworkBudget` (`libs/pipeline/src/rework-budget.ts`): a pure function taking `db`, no Nest DI. Not placed in `libs/pipeline` — `libs/executors` does not import it, and a new cross-library edge buys nothing.

`worktree.ts` stays a pure git layer: it receives `continueBranches` keyed by repo name and knows nothing about reports.

## D8 — Observability as a durable mount record

One `start-ref` timeline entry per mounted repository, written unconditionally (including `decision: 'default_branch'`), following the `recordScopingEvent` precedent.

Writing the boring case has a second payoff: it is the durable, per-run record of which repositories a run actually mounted. The integration suites previously inferred that from the system-created branch left in the cache — a signal this feature removes — and now read these entries instead, which is both more direct and correct across the cache's cross-test persistence.

## D9 — `branch_prefix` survives as a hint

It stops feeding git and starts feeding the wrapper's suggested name. Every schema, settings screen, API response and stored `behavior` blob keeps working with no migration — a strong argument for keeping it over deprecating it.

Residual risk, stated: the agent may ignore the suggestion. Anything downstream that pattern-matches `run/*` (dashboards, Jira automation, branch protection) would break silently. Nothing in this repository does today.

## Deferred — the largest residual risk

The chain now rests on the agent reporting honestly, with no deterministic check. If a developer pushes but returns empty `artifacts`, the reviewer starts from `main`, finds nothing, and reports success — the D4 failure mode arriving through the front door. The wrapper explains why reporting matters, but "we asked the model nicely" is not a control, and the codebase elsewhere is explicit that the model is never trusted to enforce a rule (`getReworkBudget`).

The cheap deterministic backstop: before `cleanupWorkspace`, compare `git rev-parse HEAD` against the recorded start ref per repo. HEAD moved and the report names no branch for that repo ⇒ the agent did work it did not report, and the next stage is guaranteed to start from the wrong place. Two local `rev-parse` calls over state already in hand. Scoped out of this change by decision; it is the natural next step.
