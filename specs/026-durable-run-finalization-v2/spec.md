# Feature Specification: Durable Run Finalization v2 — Deployment Guard + Outbox Safety Net

**Feature Branch**: `026-durable-run-finalization-v2`

**Created**: 2026-07-21

**Status**: Draft

**Input**: User description: "Durable run finalization v2 — deployment guard + outbox safety net that actually rescues. Post-mortem of run 3f60c1a1 (2026-07-20): a QA agent computed a correct PASS verdict, retried callbacks against a dead channel for 15 minutes, and the run ended cancelled with outcome = NULL. Five gaps: stale deployed artifact undetected, exit-time reconcile too narrow (timed_out only), no retroactive rescue of orphaned outbox reports, no pre-flight channel check, plus the (already fixed) client-side channel bug. Build: (A) deployment guard for the agent tool-server artifact, (B) widened exit-time outbox reconcile, (C) periodic outbox reconciler, (D) pre-flight callback-channel check."

## Context

BRIGADIR runs are completed by a callback from the agent's tool server
(Principle IV: exactly one completion channel per run). When the callback
channel is unavailable, the agent writes its final report to a local
**outbox** file (durable-finalize fix, incident 2026-07-19 Phase 4) so the
verdict survives the process. The post-mortem of run `3f60c1a1` showed the
safety net does not actually rescue: the deployed tool-server artifact was
stale (no outbox code), the only reconcile path ran solely for timed-out
runs, nothing ever re-scanned orphaned outbox files, and a run could burn
its whole time budget against a channel that was provably dead before the
agent started. This feature closes those four gaps. The client-side channel
bug itself (P0) is already merged and is a prerequisite, not part of this
feature.

## Clarifications

### Session 2026-07-21

- Q1 (guard failure surface): **Hybrid.** At worker startup the guard runs
  and, on violation, emits a loud, unmissable error signal (error-level
  log + startup warning) but the worker still starts; every callback-wired
  run then hard-fails at pickup with the explicit stale-artifact error
  before any process spawns. Phase-0/mock runs are never blocked.
- Q2 (undelivered-report surfacing): **Run-events record.** The rescued
  report is attached as a run-event of a new dedicated type
  (`undelivered_report`) carrying the full report payload; the dashboard
  shows it as a card in the run's timeline. No database schema change, no
  one-click re-finalization in this feature (manual follow-up if needed).
- Q3 (pre-flight hold mechanism): **Reuse the existing rate-limit hold
  path** with a distinct hold reason (`channel_down`) so no attempt is
  burned and the run requeues with the proven backoff mechanics; after
  **3 consecutive failed probes** for the same run an operator-facing
  alert signal is raised (visible in the dashboard, error-level log). No
  new verdict/status is introduced.
- Q4 (reconciler cadence & retention): defaults confirmed — scan every
  **60 seconds with jitter**; consumed files deleted immediately;
  unresolvable files (invalid/unknown-run) retained **7 days**, then
  deleted with a log line.
- Q5 (outbox lifetime): confirmed — the outbox directory's lifetime is
  **decoupled from per-run cleanup**; run cleanup never touches outbox
  files, and the periodic reconciler is the sole owner of outbox hygiene.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Verdict rescued at process exit (Priority: P1)

An agent finishes its session having computed a verdict, but none of its
completion callbacks reached the system; its report exists only in the
outbox. When the run's process exits and the run is still `running`, the
system reads the outbox report and finalizes the run through the normal
report-processing path — same validation, checks, and human-task creation
as a live callback — instead of fail-closing the run with no outcome.

**Why this priority**: This is exactly the `3f60c1a1` loss: a correct PASS
verdict existed on disk and was discarded. It is the highest-value, most
direct fix — every other story reduces the odds of reaching this state;
this one guarantees the verdict survives it.

**Independent Test**: Start a callback-wired run whose callbacks are
blocked; let the agent write an outbox report and exit normally. Verify the
run finalizes with the report's outcome (checks and human tasks created)
and no fail-closed `failed` write occurs.

**Acceptance Scenarios**:

1. **Given** a run in `running` whose agent wrote an outbox report and
   exited with a `completed`-mapped exit, **When** the worker processes the
   exit, **Then** the run is finalized with the report's outcome via the
   standard report path and the outbox file is consumed.
2. **Given** the same exit but the outbox report fails schema validation,
   **When** the worker processes the exit, **Then** the run fail-closes as
   before (`failed`, diagnostics recorded) and the invalid report is
   preserved for inspection rather than silently deleted.
3. **Given** a run that ended `timed_out`, **When** the worker processes
   the exit, **Then** the existing timed-out reconcile behavior is
   unchanged.
4. **Given** a run stopped as `cancelled` or `rate_limited` with an outbox
   report present, **When** the worker processes the exit, **Then** the
   run's status is NOT changed, the report is attached to the run as an
   undelivered report visible to the operator, and the file is consumed.
5. **Given** a live callback finalizes the run concurrently with the
   exit-time reconcile, **When** both race, **Then** exactly one
   finalization wins (status-guarded) and the loser is a no-op — no double
   finalization, no overwrite.

---

### User Story 2 - Stale artifact cannot run silently (Priority: P2)

An operator (or developer) starts the worker after merging changes to the
agent tool server but without rebuilding its deployable artifact. Before
any callback-wired agent spawns, the system detects that the artifact is
missing or older than its sources and fails loudly with an explicit,
actionable error. The routine dev workflow and the container build are
wired so the artifact is always rebuilt, making the guard a tripwire that
almost never fires.

**Why this priority**: The stale artifact is why the Phase 4 outbox fix was
inert during the incident — every downstream safety net is worthless if the
deployed binary predates it. Cheap to build, prevents a whole class of
"merged ≠ deployed" failures.

**Independent Test**: Delete or backdate the artifact, start the worker (or
submit a callback-wired run, per the chosen failure surface), and verify a
loud, unmissable failure naming the stale artifact before any agent
process spawns. Rebuild and verify normal operation resumes.

**Acceptance Scenarios**:

1. **Given** the tool-server artifact is missing, **When** the guard runs,
   **Then** a loud failure occurs before any callback-wired agent spawns,
   with an error message naming the artifact path and the remedy (build
   command).
2. **Given** the artifact exists but is older than the newest source file
   of the tool-server package, **When** the guard runs, **Then** the same
   loud failure occurs — no silent fallback, no degraded mode.
3. **Given** the artifact is up to date, **When** the guard runs, **Then**
   runs proceed with no observable difference.
4. **Given** the standard dev workflow or the container image build is
   used, **When** the worker starts, **Then** the artifact has been built
   as part of that workflow and the guard passes without manual steps.

---

### User Story 3 - Orphaned reports rescued retroactively (Priority: P3)

The worker died mid-run, an exit-time reconcile lost a race, or an operator
cancelled a run — and an outbox report is sitting on disk with no process
left to deliver it. A periodic reconciler scans the outbox directory and,
for each orphaned report, resolves it against the run's current state:
finalize the run if it still has no outcome, attach as an undelivered
report if the stop was intentional, or discard (with a log) if the run is
already finalized or unknown.

**Why this priority**: This is the last line of defense — it converts
"orphaned file sits on disk forever" into "rescued on the next scan". It
matters less often than P1/P2 but is the only path that covers worker
death.

**Independent Test**: Place outbox report files for runs in various states
(running, failed-without-outcome, cancelled, already-finalized,
nonexistent) into the outbox directory and trigger a reconciler pass;
verify each file is resolved per its run's state and no file is processed
twice.

**Acceptance Scenarios**:

1. **Given** an outbox report for a run still `running` (worker died) or
   terminal-without-outcome (`failed`/`timed_out`, `outcome IS NULL`),
   **When** the reconciler scans, **Then** the run is finalized with the
   report through the standard, status-guarded report path and the file is
   consumed.
2. **Given** an outbox report for a `cancelled` or `rate_limited` run,
   **When** the reconciler scans, **Then** the status is untouched, the
   report is attached as an undelivered report, and the file is consumed.
3. **Given** an outbox report for a run already finalized with an outcome,
   or for a run id the system does not know, **When** the reconciler
   scans, **Then** the file is consumed/discarded and the event is logged.
4. **Given** a live callback lands while the reconciler is processing the
   same run, **When** both race, **Then** exactly one finalization wins and
   the other is a no-op (idempotent, status-guarded).
5. **Given** two consecutive reconciler passes over the same directory,
   **When** nothing new appears, **Then** the second pass performs no
   writes (idempotent re-scan).

---

### User Story 4 - Dead channel detected before spawning (Priority: P4)

A callback-wired run is about to start, but the callback endpoint is down
(e.g. the backend process is not running). The system probes the channel
before spawning the agent; on failure it does not spawn, does not consume
one of the run's attempts, holds/requeues the run with backoff, and
surfaces an operator-visible signal. When the channel recovers, the run
proceeds normally.

**Why this priority**: Pure waste-prevention — it saves the 20+ minute run
budget and the retry-ladder minutes per callback attempt, and makes an
environment outage visible immediately instead of after a burned run. It
does not by itself save any verdict, hence lowest of the four.

**Independent Test**: With the callback endpoint down, enqueue a
callback-wired run; verify no agent process spawns, no attempt is consumed,
and an operator-visible signal appears. Bring the endpoint up; verify the
run then executes normally.

**Acceptance Scenarios**:

1. **Given** the callback endpoint is unreachable, **When** a
   callback-wired run reaches the worker, **Then** no agent process is
   spawned, the run's attempt count is not incremented, and the run is
   held/requeued with backoff.
2. **Given** the run is held due to a dead channel, **When** an operator
   looks at the dashboard, **Then** the hold and its reason are visible.
3. **Given** the callback endpoint recovers, **When** the held run is next
   picked up, **Then** it spawns and executes normally with its full
   attempt budget.
4. **Given** a Phase-0 run (no callback channel), **When** it reaches the
   worker, **Then** no probe is performed and behavior is byte-identical to
   today.
5. **Given** the health probe endpoint is queried by an unauthenticated
   client, **When** it responds, **Then** it exposes no sensitive
   information (liveness only).

### Edge Cases

- Outbox report exists for a run currently `awaiting_human`: the run has a
  live completion path (human answer → resume); the reconciler must not
  finalize it — treat as "not eligible", leave status untouched, and do not
  consume the file until the run reaches an eligible state.
- Multiple outbox writes for the same run (agent retried `complete_task`
  then `request_human`): the outbox holds the latest report per run
  (existing single-file-per-run semantics); reconcile processes exactly
  one report per run.
- Invalid/corrupt outbox file (truncated JSON, schema mismatch): never
  finalize from it; preserve the file (quarantine or leave with a marker)
  and log loudly so an operator can inspect — do not retry it on every
  scan forever.
- Artifact-freshness comparison across filesystems/clock skew: the guard
  compares local file mtimes only (build output vs sources on the same
  machine); a source file touched without content change may cause a false
  positive — acceptable, the remedy is a rebuild, which is cheap.
- Outbox directory does not exist (fresh machine, tmpdir cleared on
  reboot): reconciler treats it as empty, no error.
- Pre-flight probe passes but the channel dies mid-run: out of scope for
  the probe (stated limitation) — the outbox + reconcile paths (P1/P3) are
  the coverage for mid-run death. The probe protects against
  environment-level outages present before spawn, not client-side bugs or
  mid-run failures.
- Run cleanup (worktree/config removal) already ran but the outbox file
  survives: the outbox directory's lifetime is decoupled from per-run
  cleanup; the reconciler must handle reports whose run has no remaining
  on-disk context.

## Requirements *(mandatory)*

### Functional Requirements

**A — Deployment guard**

- **FR-001**: The system MUST verify, before any callback-wired agent
  process is spawned, that the agent tool-server artifact it would spawn
  exists and is not older than the newest source file of the tool-server
  package.
- **FR-002**: On guard violation the system MUST fail loudly with an error
  that names the offending artifact path, the reason (missing vs stale, with
  timestamps), and the rebuild remedy. There MUST be no silent fallback or
  degraded mode. Failure surface (per Clarifications Q1): at worker
  startup the violation is reported as a loud error-level signal but the
  worker still starts; each callback-wired run then hard-fails at pickup
  with the same explicit error before any agent process spawns.
  Phase-0/mock runs are never blocked by the guard.
- **FR-003**: The standard developer workflow (worker dev script) and the
  container image build MUST produce a fresh tool-server artifact so the
  guard passes without manual build steps.

**B — Exit-time reconcile widening**

- **FR-004**: When a run process exits with a `completed`-mapped result and
  the run is still `running`, the system MUST check the outbox before
  fail-closing; if a valid report exists, it MUST finalize the run through
  the same report-processing path as a live callback (validation, checks,
  human tasks) and consume the file, skipping the fail-closed write.
- **FR-005**: The existing `timed_out` reconcile behavior MUST be
  preserved unchanged.
- **FR-006**: For runs ending `cancelled` or `rate_limited` with an outbox
  report present, the system MUST NOT change the run status, MUST attach
  the report to the run as an operator-visible "undelivered report", and
  MUST consume the file. Surfacing mechanism (per Clarifications Q2): a
  run-event of a dedicated `undelivered_report` type carrying the full
  report payload, rendered as a card in the run's dashboard timeline; no
  one-click re-finalization action is in scope for this feature.
- **FR-007**: An outbox report that fails schema validation MUST NOT
  finalize a run; the run follows its normal (fail-closed) path, the
  invalid file is preserved for inspection, and the failure is logged.

**C — Periodic reconciler**

- **FR-008**: A recurring worker-side job MUST scan the outbox directory
  for report files and resolve each against its run's current state:
  finalize (standard report path) when the run is `running` or terminal
  without outcome (`failed`/`timed_out` with `outcome IS NULL`); attach as
  undelivered report when `cancelled`/`rate_limited`; consume/discard with
  a log when already finalized with an outcome or the run is unknown; skip
  without consuming when the run is `awaiting_human`.
- **FR-009**: Reconciler processing MUST be idempotent and race-safe
  against concurrent live callbacks and exit-time reconciles: all
  finalizations go through the status-guarded path, and losing a race MUST
  result in a no-op plus file consumption per FR-008's already-finalized
  rule.
- **FR-010**: The reconciler MUST run on a modest periodic cadence
  (default: every 60 seconds; see Assumptions) and MUST tolerate a missing
  outbox directory as an empty scan.
- **FR-011**: The reconciler MUST apply a retention policy to files it can
  never resolve (invalid/quarantined, unknown-run) so the directory does
  not grow unboundedly (default: delete after 7 days; see Assumptions).

**D — Pre-flight channel check**

- **FR-012**: Before spawning a callback-wired run's agent process, the
  worker MUST probe the callback channel's liveness with a cheap request.
  A dedicated unauthenticated health endpoint MAY be added; it MUST expose
  liveness only and no sensitive data.
- **FR-013**: On probe failure the worker MUST NOT spawn the agent, MUST
  NOT consume a run attempt, and MUST hold/requeue the run with backoff
  while preserving the run's status-guard discipline (no status
  clobbering). Hold mechanism (per Clarifications Q3): reuse the existing
  rate-limit hold path with a distinct `channel_down` hold reason (no new
  verdict/status); after 3 consecutive failed probes for the same run,
  raise an operator-facing alert signal (dashboard-visible, error-level
  log).
- **FR-014**: A held run MUST be visible to the operator with the hold
  reason, and MUST proceed normally (full attempt budget) once the channel
  recovers.
- **FR-015**: Runs without a callback channel (Phase-0,
  `useCallbackChannel = false`) MUST be entirely unaffected by all of
  A–D: no probe, no guard-induced failure, no behavior change.

**Cross-cutting**

- **FR-016**: No changes to the callback HTTP API contract for existing
  tools; any health endpoint is purely additive.
- **FR-017**: No database schema changes unless `docs/architecture.md` §3
  is updated first; designs that need no schema change are preferred (the
  run-events timeline is the natural home for "undelivered report").
- **FR-018**: All finalization writes introduced by this feature MUST
  follow the established guard discipline: process-outcome writes are
  status-guarded, and the report path's "did I win the race" signal is
  honored — a lost race is a silent no-op, never an overwrite.

### Key Entities

- **Outbox report**: The agent's final structured report persisted to a
  local file when the live callback could not be delivered; keyed by run
  id; the payload is the same versioned report the callback would have
  carried. Survives the agent process; its directory's lifetime is
  decoupled from per-run cleanup.
- **Run**: The orchestration record whose status/outcome the feature
  protects; eligible-for-rescue states are `running` and terminal states
  with no outcome (`failed`, `timed_out`); protected-from-overwrite states
  are `cancelled`, `rate_limited` (intentional stops) and `awaiting_human`
  (live human completion path).
- **Undelivered report**: An operator-visible record attaching a rescued
  report to a run whose status must not change; preserves the verdict's
  content without flipping the run's lifecycle state.
- **Deployment guard verdict**: The result of comparing the tool-server
  artifact's build time against its sources — pass, missing, or stale —
  produced before any callback-wired spawn.
- **Channel probe**: A cheap liveness check of the callback endpoint
  performed per callback-wired run before spawn; its failure produces a
  hold, never a consumed attempt.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With the tool-server artifact missing or stale, 0
  callback-wired agent processes spawn, and the operator-facing failure
  appears within one worker start (or first run pickup, per the chosen
  failure surface) naming the artifact and remedy.
- **SC-002**: In each of the three loss scenarios — `completed`-exit with
  undelivered report, `timed_out` with undelivered report, and worker
  death with an orphaned report — the run reaches the report's correct
  outcome without human intervention (worker-death case: within two
  reconciler cadence intervals of worker restart).
- **SC-003**: A `cancelled` run with an outbox report retains status
  `cancelled` in 100% of cases, and its report content is visible to the
  operator on the run — zero silently discarded reports.
- **SC-004**: With the callback endpoint down, a queued callback-wired run
  spawns 0 agent processes and consumes 0 attempts for the duration of the
  outage, is visibly held to the operator, and completes normally after
  the endpoint recovers — replayed against the 2026-07-19 incident
  conditions, the `3f60c1a1` run would have been held, not burned.
- **SC-005**: Re-running the reconciler over an already-processed outbox
  directory produces zero additional writes (verified by test); no report
  file is ever processed into two finalizations.
- **SC-006**: Phase-0 runs show byte-identical behavior before and after
  the feature (existing test suite passes unmodified).
- **SC-007**: All quality gates green: `pnpm typecheck && pnpm lint &&
  pnpm test` and `pnpm test:integration`, with the reconciler and
  pre-flight hold paths covered by integration tests against real
  Postgres/Redis.

## Assumptions

- **P0 prerequisite**: the client-side callback-channel bug fix
  (`packages/mcp-server` dispatcher removal, merged as #44) is in the base
  branch; this feature assumes a functionally correct channel client.
- **Reconciler cadence** (confirmed, Clarifications Q4): every 60 seconds
  with small jitter — orphan rescue latency of ≤2 minutes is acceptable
  for an internal tool, and a scan of a near-empty directory is cheap.
- **Outbox retention** (confirmed, Clarifications Q4): consumed files are
  deleted immediately at consumption; unresolvable files (invalid,
  unknown run) are kept 7 days then deleted, each with a log line.
- **Outbox lifetime decoupling** (confirmed, Clarifications Q5): the
  outbox directory intentionally survives per-run worktree/config
  cleanup, and the periodic reconciler is the sole component responsible
  for its hygiene; run cleanup never deletes outbox files.
- **Freshness definition**: "not older than sources" means the artifact's
  modification time is ≥ the newest modification time under the
  tool-server package's source tree; same-machine mtime comparison is
  sufficient (no content hashing) for both dev and container contexts.
- **`awaiting_human` is not rescue-eligible**: a run awaiting a human has
  a live completion path; automated finalization from an outbox report
  would race the human answer, violating the single-completion-channel
  contract.
- **Probe scope limitation**: the pre-flight probe detects
  environment-level outages present before spawn (backend down); it does
  not and cannot detect client-side bugs in the tool server or channels
  that die mid-run — those are covered by the outbox + reconcile paths.
- **Constitution IV compatibility**: rescue paths finalize only from a
  schema-valid structured report authored by the agent's completion tools
  — the outbox is a deferred delivery of the single completion channel,
  not a second channel; runs with no valid report anywhere still fail
  closed. No silent fallback is introduced.
- **No new external dependencies**; scheduling uses the existing queue
  infrastructure with lazy resource resolution (constitution Technology
  Constraints).
- **Independently mergeable phases**: A (guard + build wiring), B
  (exit-time reconcile), C (periodic reconciler), D (pre-flight) are
  separately shippable; B/C/D depend on A operationally (fresh artifact)
  but not at compile time.

## Out of Scope

- Fixing or hardening the callback client itself (done separately, P0).
- Mid-run channel-death detection or in-flight probing.
- Changes to the callback HTTP API contract for existing tools.
- Any behavior change for Phase-0 (non-callback) runs.
- Multi-host outbox aggregation (worker and outbox share one machine).
