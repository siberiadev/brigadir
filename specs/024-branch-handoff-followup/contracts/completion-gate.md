# Contract — Completion gate for unreported work (US3)

Amends the callback HTTP API contract (feature 004, `contracts/
callback-http-api.md`) for `POST /runs/:id/complete` only. The request BODY
contract is unchanged (`ReportSchema.strict()`); everything here is additive.

## Evidence: `x-brigadir-observed-heads` request header

- Attached by the `brigadir-mcp` tool server (never by the agent's tool
  input — the tool input schema is unchanged) when its env carries
  `BRIGADIR_REPO_DIRS` (JSON map repo name → absolute worktree dir, delivered
  in the per-run 0600 env-block config file the executor already writes).
- Value: JSON object `{ "<repo>": "<40-hex sha>", ... }` — `git rev-parse
  HEAD` (execFile, no shell) run in each listed worktree at `complete_task`
  call time. A repo whose rev-parse fails is omitted. Evidence is observed,
  never fabricated.
- Absent env / no repos / malformed value ⇒ header not sent.

## Gate (backend, before `finalizeWithReport`)

Baseline: this run's `start-ref` run_events (`repo`, `startSha` — recorded at
prepare time). Report side: `normalizeReportArtifacts(report)`.

A completion is REJECTED iff at least one mounted repo satisfies ALL of:

1. `observedHeads[repo]` is present and ≠ that repo's `startSha` (exact
   inequality — amended/reset work still counts), and
2. no normalized artifact entry matches the repo — matching is exact name;
   a legacy flat (v1) report attributes to the single mounted repo only when
   exactly one repo is mounted (feature 023 D5 attribution rule).

Evidence-absent cases NEVER reject: missing header, missing/invalid
`startSha` rows, repo absent from the header, runs with no start-ref rows
(no-repo triage, workspace-setup, Phase-0 structured-output runs).

## Rejection response

Same envelope as report validation failures (422-style, non-retryable by the
MCP client — 4xx is never retried): an error list naming each violating repo
with `startSha` and `observedHead`, and the corrective instruction (push the
branch, add the `artifacts.repos` entry for that repo, call `complete_task`
again). The run stays ACTIVE; the completion marker is NOT written (marker
writes only on 2xx — unchanged).

Side effect: one `run_events` row (`payload.source: 'handoff-violation'`,
see data-model.md §2) per rejected completion.

## Invariants preserved

- Accepted completions finalize exactly as today: `finalizeWithReport` →
  review-task queueing → `onRunFinished`. No ordering change.
- Repeated `complete` for a finished run still 409s (gate runs only while the
  run is active; it never resurrects or re-judges a finalized run).
- `team` reports keep their dedicated accept path; the gate applies before it
  the same way (a setup run has no start-ref rows, so it is silently exempt).
- Exit without an accepted completion still fails closed (Constitution IV);
  the recorded violation event is the operator's diagnostic for WHY the agent
  never completed.
