# Research — Branch Handoff Follow-Up (024)

All decisions below were made against the code on `main@89ae75e` (post-023). No
runtime observations were possible in this session (no backend/worker, no
Docker); every claim about ordering is grounded in code, cited by file.

## D1 — Handoff sections route through `normalizeReportArtifacts`, rendering stays line-per-repo

**Decision**: Replace both flat-field reads in `libs/pipeline/src/handoff.ts`
(`failureLines` ~112–118, `buildReworkSection` ~263–269) with
`normalizeReportArtifacts(report)` from `@brigadir/contracts`, and render one
line per normalized entry: `repo` prefix when present (v2), none for the legacy
flat form (v1), parts joined as today (`branch X, PR Y`). Line labels stay
`Artifacts:` (triage/answer-triage) and `Continue on:` (rework).

**Rationale**: The normalizer is documented as the ONE precedence
implementation (report.schema.ts:217–224 names its consumers and forbids
re-derivation); handoff.ts predates v2 and was simply missed by feature 019.
Rendering v1 via the same path yields a single-element list with `repo`
undefined — the existing v1 line renders byte-identically, which is what keeps
the forward-compat assertion green without a special case.

**Alternatives considered**: Reading `artifacts.repos` directly at both sites —
rejected, that is exactly the re-derivation the contract forbids; any future
precedence change would fork behavior between Jira comments and handoff
prompts.

**Bounds**: entries are schema-capped (`repos[].max(20)`, branch ≤300, pr_url
≤1000), so per-repo lines cannot blow the FR-013 size budget; no new truncation
needed. Best-effort contract untouched — `normalizeReportArtifacts` never
throws on schema-valid reports, and the whole builder keeps its try/catch.

## D2 — The wrapper's "create <name>" hint is removed, not made configurable

**Decision**: Delete `WrapperRepoInfo.suggestedBranch` and its rendering (the
`— create <name>` tail in `repositoriesSection`); the no-prior-branch line
becomes `- <name>: <path> (no prior branch; at <defaultBranch>)` and the
existing rule line "put yourself on a branch: `git switch -C <branch>`, using
the branch named above" is reworded to: continue the named branch when one is
listed, otherwise create a branch of your own choosing and report it. In the
executor, `suggestedBranch` computation and `branchPrefix` (`behavior.
branch_prefix ?? 'run'`, claude-cli.executor.ts:738) go away;
`setupRunBranchIdentity` (worktree.ts) is deleted with its call site — a setup
run gets no suggested name either (it never pushes; spec 015 FR-015 — the name
was cosmetic).

**Rationale**: Operator decision (option (a), Clarifications 2026-07-19): the
system stops naming branches at all; the only first stage in practice follows
its own convention (spec-kit). A configurable suggestion (option (b)) keeps
dead machinery for a value nobody sets — `branch_prefix` is unset on all five
agents and at workspace level.

**Blast radius check**: `branch_prefix` remains in `WorkspaceResponse`
(nullable), settings PUT validation, agents-yaml schema, and stored
`agents.behavior` — all untouched (inert field, FR-007, no migration).
Grep confirms no other reader of `behavior.branch_prefix` in `libs/` beyond the
executor's `loadRunConfig`. Integration specs setting `branch_prefix: 'feat'`
keep passing — the field is accepted and stored; only the wrapper text changes
(the wrapper integration assertions that mention `create feat/...` must be
updated in the same change).

## D3 — The backstop gates `complete_task`; the 023 exit-time sketch is not a control

**Decision**: The unreported-work check runs when the backend processes
`complete_task`, BEFORE `finalizeWithReport`. The 023 research sketch
("compare HEAD before `cleanupWorkspace`, fail the run") is abandoned.

**Rationale** (code-proven ordering): `CallbackService.complete` →
`runs.finalizeWithReport` (status set from outcome immediately —
runs.service.ts:67–98) → `pipeline.onRunFinished` (Jira transition enqueued —
callback.service.ts:189–197). All of this happens while the agent process is
still alive. By the time the executor's post-process code runs, the target
scenario ("success with no artifacts") has already produced a `succeeded` run
and a moving ticket; the rule-7 guard (`WHERE status='running'`) would make an
executor-side fail a 0-row no-op, and an unguarded write would clobber
callback state — the exact bug class hard-won rule 7 exists to prevent. An
exit-time check can only ever be a breadcrumb; the operator explicitly chose a
control ("fail the run"), and the only point where the run's fate is still
undecided is the completion itself. Operator confirmed this placement
(Clarifications 2026-07-19, second session).

**Precedent**: an invalid `team` report already gets a 422 with the run left
active "so the agent can correct the proposal and call complete_task again"
(callback.service.ts:173–180). The gate extends the same posture to
artifact honesty. Constitution IV is satisfied: completion still happens only
through a schema-valid accepted report; an uncorrected violation ends in the
existing exit-without-completion `failed` path.

**Alternatives considered**:
- Exit-time event + `failIfStillRunning` — cheap, but demonstrably not a
  control for the main scenario (above); rejected by operator.
- Backend pulls git state itself — impossible: worktrees live with the worker
  process (potentially another host); the backend is deliberately gitless.
- Deferring finalization of callback runs to process exit — violates
  Constitution IV (exactly one completion channel, callback is authoritative)
  and rewrites the entire completion contract for one check. Rejected.

## D4 — Evidence: the MCP server observes HEADs; the backend decides

**Decision**: Split evidence from decision.
- `packages/mcp-server` `complete_task` handler: before POSTing, run
  `git rev-parse HEAD` (execFile, no shell) in each worktree listed in a new
  env var `BRIGADIR_REPO_DIRS` (JSON map `{repoName: absWorktreeDir}`, written
  by the executor into the tool-server env block of the per-run MCP config file
  it already writes — same 0600 delivery as the run token, Constitution V).
  Observed heads go to the backend in a request header
  `x-brigadir-observed-heads: {"<repo>":"<sha>", ...}`. A repo whose
  `rev-parse` fails is omitted (evidence-absent, never fabricated). Env var
  absent (old config, no-repo runs) ⇒ no header, gate silent.
- Backend `CallbackService.complete`: parse the header (zod, bounded; invalid
  header ⇒ ignored as absent), load this run's `start-ref` run_events, and for
  each mounted repo where `observedHead` is present, differs from the recorded
  `startSha`, and `normalizeReportArtifacts(report)` has no entry for that
  repo — reject: 422-style validation failure listing each violating repo with
  both SHAs and the instruction to push, add the entry, and complete again;
  plus one `run_events` row (`source: 'handoff-violation'`) per rejection.

**Rationale**: The worktree is the only place the evidence exists, and the
tool server is the only system-owned process colocated with it at completion
time (main.ts: it already holds run id, token, marker path in its own env —
the agent's env never sees any of it). The backend is the only place that can
still change the run's fate and the only place with the report + start
records. The MCP server stays a thin client in spirit: it gains observation
(two read-only git calls), zero decision logic, zero DB access. Keeping the
decision in the backend makes it unit-testable against Postgres rows and JSON
— Constitution VI.

**Why a header, not a body change**: the POST body IS the report and is parsed
with `ReportSchema.strict()`; wrapping it in an envelope would break the
endpoint contract (contracts/callback-http-api.md, feature 004) and every
existing consumer/test for a field the agent must never author. A header keeps
the body contract byte-stable, is invisible to the report schema, and is
naturally absent from old callers (forward-compatible in both directions).
The agent cannot spoof it through the tool: the header is attached by the tool
server itself, outside the tool's input schema. (An agent curling the callback
API directly would need the run token — out of the agent's env by Constitution
V; that trust boundary is unchanged by this feature.)

**v1 flat-report attribution**: same rule as D5 of 023 — a flat report (no
repo names) is attributed only when exactly ONE repository is mounted; with
several mounted repos the flat form cannot vouch for any specific moved repo,
and the gate treats moved repos as unreported. In practice this workspace's
agents report v2; v1 producers are single-repo by definition.

**Satisfying the gate without a push**: an artifact entry for the moved repo
is what the gate checks (`repo` present in the normalized list) — `branch` is
demanded by the rejection message but not schema-enforceable. An agent that
cannot push (e.g. broken auth) can still report honestly
(`{repo, files_changed}` + outcome `failure`); the next stage then starts from
the default branch by the 023 asymmetry, and nothing false-succeeds. Catching
negligence deterministically is the goal; a deliberately lying agent was and
stays out of scope (the model is never the enforcement layer — `getReworkBudget`
precedent).

## D5 — Start SHA: resolved at prepare time, recorded in the existing start-ref event

**Decision**: `addRepoWorktree` resolves the concrete commit
(`git rev-parse HEAD` in the fresh worktree, which IS the start ref) and
returns it as `RepoStart.startSha`; `recordStartRefEvent` moves to AFTER
`prepareAll` and adds `startSha` to each event payload. The gate compares
observed HEAD against `startSha` from these rows.

**Rationale**: The event already exists per repo per run ("doubles as the
durable record of which repos a run mounted" — claude-cli.executor.ts:843–847)
and run_events is the sanctioned place for run facts; no new table (the
deferred `run_repo_artifacts` stays deferred). A symbolic ref
(`origin/main`) recorded today is useless as a baseline — the remote moves;
only the resolved SHA pins what the worktree actually started at. Moving the
write after `prepareAll` changes failure-path behavior only: a run whose
prepare crashes writes no start-ref rows — acceptable, such a run fails
loudly before any agent starts and hands nothing off; and the record becomes
strictly more truthful (it now describes worktrees that actually exist).

**Comparison semantics**: exact inequality (`observed !== startSha`), not
ancestry — an amend/reset in place is still unreported work (spec edge case).

## D6 — Gate scope: ticket runs only, all outcomes, evidence-gated

The gate activates only when this run has start-ref rows (written only for
ticket runs with repos — executor guards on `ctx.ticket && ticketId`) AND the
observed-heads header is present. Naturally silent for: no-repo triage runs
(scratch dir, no repos), workspace-setup runs (ticketless ⇒ no start-ref
rows; they never push by spec 015), Phase-0 structured-output runs (no MCP
server at all), and blocking `request_human` parking (no completion
submitted). All completion outcomes pass through the same gate — a `failure`
or `needs_human` report must be artifact-honest too, since rework/resume
continuation (US1's prompt and 023's worktree mounting) reads exactly those
reports. The idempotent-completion 409 for already-finalized runs is checked
by `finalizeWithReport` as today; gate rejections happen before it and leave
the run active, so the 409 contract is unchanged.

## D7 — Test strategy (Constitution VI)

- `libs/pipeline/src/handoff.spec.ts`: v2 multi-repo rendering (rework +
  triage + answer-triage), v1 unchanged (existing assertions untouched), both
  forms present ⇒ repos[] wins, empty/absent artifacts ⇒ no line, partial
  entries (branch-only / pr-only).
- `libs/executors/src/claude-cli/wrapper.spec.ts`: no-prior-branch line has no
  suggested name; continue-branch line byte-identical to 023; rules line
  updated.
- `packages/mcp-server/src/tools.spec.ts`: complete_task attaches the header
  from injected exec results; omits repos whose rev-parse fails; no env ⇒ no
  header (fetchImpl capture — existing pattern in that spec).
- `libs/callback`: unit tests for the gate decision function (pure:
  startRefs × observedHeads × normalized artifacts → violations) and
  service-level accept/reject including the run_event write and run-stays-
  active; team-report path unaffected.
- Executor: `RepoStart.startSha` resolution + event-after-prepare ordering
  (existing worktree/executor spec seams).
- Integration (vitest + testcontainers): extend `callback-completion` /
  lifecycle suites with a moved-HEAD reject→correct→accept flow. **Docker is
  unavailable in this session** — these are written but their execution is
  deferred to the operator's stand, stated per the iteration-29 precedent.

## Resolved Technical-Context unknowns

None remain: language/stack fixed by the constitution (TS strict, NestJS 11,
BullMQ 5, Postgres 16); no new dependencies; no schema migration (run_events
payload is jsonb, additive keys only).
