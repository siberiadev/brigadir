# Feature Specification: Callback-Channel Resilience Ops — Stable Agent-Serving Runtime + Channel-Health Observability

**Feature Branch**: `027-callback-channel-resilience`

**Created**: 2026-07-21

**Status**: Draft

**Input**: User description: "Callback-channel resilience ops — stable agent-serving runtime + channel-health observability. Post-mortem of the 2026-07-19/20 callback failures identified two remaining gaps after the client bug fix (P0) and the durable-finalize safety net: (1) the agent-serving backend is a dev-watch process whose availability is coupled to human editor activity — the remaining SPOF; (2) channel failures are invisible — evidence lands only in agent-side stderr, the dashboard shows nothing, and the operator had to hand-write SQL during the incident. Build: (A) one supported stable agent-serving runtime mode with hard no-double-consumption guarantees, (B) channel-failure breadcrumbs (tool server → worker → run events), (C) an operator-facing channel-health surface on the dashboard."

## Context

Every callback-wired BRIGADIR run depends on the callback channel staying
reachable for its whole lifetime (Principle IV: exactly one completion
channel per run). The 2026-07-19/20 incident closed the client-side bug
(P0) and added the durable-finalize safety net (deployment guard, widened
exit-time reconcile, periodic outbox reconciler, pre-flight probe — feature
026, merged; this feature builds on those primitives). Two gaps remain:

1. **The callback target is a dev-watch process.** All real outage windows
   (2026-07-19 06:02Z, 10:50–11:49Z, 17:14–17:59Z UTC) correlate with human
   dev activity on the same machine: the watch-mode backend restarts or
   breaks whenever the human edits code, switches branches, or a rebuild
   fails — while 20-minute agent runs are in flight. Channel availability
   is coupled to the human's editor. That is the remaining single point of
   failure.
2. **Channel failures are invisible to the system.** The tool server is the
   only witness of failed callbacks; its evidence dies in agent-side stderr.
   The backend never sees the failed attempts, the dashboard shows nothing,
   and the operator learns about a dead channel only when runs pile up with
   no outcome. During the incident the operator had to hand-write SQL to
   understand what was happening.

Source documents: `docs/incident-2026-07-19-fix-prompt.md`,
`docs/incident-2026-07-19-fix-plan.md`, `docs/architecture.md` §4–5,
`docs/local-setup.md`.

Deliverables are three independently mergeable phases: **A** — stable
agent-serving runtime mode (ops/docs plus small config code), **B** —
channel-failure breadcrumbs end-to-end (code), **C** — channel-health
endpoint and dashboard surface (code; consumes B's data, so B lands before
C).

## Clarifications

### Session 2026-07-21

- Q: Which shape should the stable agent-serving runtime mode take? → A:
  **Second native non-watch pair** — backend + worker started from built
  output (`node dist/...`) on a dedicated port, with the worker's callback
  base URL pointing at the stable backend; the dev-watch stack on :3000
  stays free for the human. Keeps the host Claude CLI environment (auth,
  repos, git credentials) that agent runs depend on; the compose-based
  agent stack and discipline-only options are rejected (container CLI-auth/
  path risks and remaining SPOF, respectively).
- Q: How is exactly-one-consumer on the agent queues guaranteed? → A:
  **Exclusive worker lock** held in the shared queue store: the queues keep
  a single namespace, one worker owns the lock and consumes; a second
  worker starting in a competing configuration refuses to consume and
  raises a loud, unmissable error on both sides. Queue-prefix separation
  (strands jobs across modes) and detection-only (race window) are
  rejected. In-flight runs on mode switch: drain — the exiting worker's
  runs finish (or are explicitly cancelled) before the new owner takes the
  lock; the switch procedure surfaces active runs and never silently hands
  them over.
- Q: At what granularity does the tool server record channel-failure
  breadcrumbs? → A: **One summary record per retry exhaustion** (timestamp,
  tool, attempt count, last error, target host). Per-attempt records are
  rejected as unbounded volume; per-attempt detail remains available in the
  tool server's stderr as today.
- Q: What trips the degraded state, and where does the health indicator
  live? → A: **15-minute window; degraded on any pre-flight probe failure
  OR ≥ 3 channel-failure events in the window; a deployment-guard violation
  always shows degraded. The indicator lives in the global dashboard
  layout**, visible from every page. Thresholds and window are
  configuration with these defaults.
- Q: Does degraded channel health trigger anything beyond the UI? → A:
  **No — observability-only.** Admission control remains solely the job of
  feature 026's per-run pre-flight probe; the health aggregate never
  pauses, holds, or gates runs. A second aggregate-driven admission loop is
  explicitly rejected.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Agent runs survive human dev activity (Priority: P1)

The operator puts the system into the supported **stable serving mode**
with a single command. Agent runs launched in this mode deliver their
callbacks to a target whose availability does not depend on what the human
is doing in their editor: the human can edit source files, switch branches,
break a rebuild, or restart their dev-watch stack mid-run, and every
in-flight run's callbacks still succeed. One command exits the mode and
returns to the plain dev workflow.

**Why this priority**: This removes the root cause of every real outage
window in the incident. Breadcrumbs (B) and the health surface (C) only
observe failures; this story prevents them.

**Independent Test**: Enter the stable serving mode, start a callback-wired
run, then touch a source file and kill/restart the dev-watch backend while
the run is in flight. The run completes with all callbacks delivered and no
channel-failure evidence recorded.

**Acceptance Scenarios**:

1. **Given** the stable serving mode is active and a callback-wired run is
   in flight, **When** the human edits source, switches branches, or
   restarts the dev-watch process, **Then** all of the run's callbacks are
   delivered successfully and the run finalizes normally.
2. **Given** a machine in the plain dev state, **When** the operator runs
   the single documented enter command, **Then** the stable serving mode is
   up and serving agent runs, and the command's output states which mode is
   now active.
3. **Given** the stable serving mode is active, **When** the operator runs
   the single documented exit command, **Then** the system returns to the
   plain dev workflow with no leftover processes competing for agent work.
4. **Given** the stable serving mode is active, **When** a callback-wired
   run starts, **Then** the pre-flight channel probe and the deployment
   guard from feature 026 behave exactly as they do in the dev workflow
   (correct paths and environment in the mode's runtime — verified, not
   assumed).
5. **Given** the stable serving mode is active, **When** a Phase-0 run
   (no callback channel) executes, **Then** its behavior is unchanged.

---

### User Story 2 - The double-worker mistake cannot happen silently (Priority: P1)

The operator has (or almost has) two workers alive at once — for example a
dev worker left running while the stable-mode worker starts. An exclusive
worker lock over the single queue namespace makes concurrent consumption
impossible: the second worker refuses to consume and raises an unmissable
error within seconds on both sides, before runs can be raced away by the
wrong worker.

**Why this priority**: Two workers competing for the same queues is the
trap the chosen mode creates the moment it exists. A raced run executes
against the wrong backend and fails in confusing ways worse than the
original outage; this guarantee is part of A's definition of done, not an
add-on.

**Independent Test**: With the stable-mode worker running, deliberately
start a second (dev) worker against the same queue infrastructure. Verify
the second worker does not consume any agent job, an unmissable error is
raised within seconds on both sides, and it is deterministic which worker
owns the queues.

**Acceptance Scenarios**:

1. **Given** one worker holds the queue-ownership lock, **When** a second
   worker starts in a configuration that would consume the same queues,
   **Then** the second worker refuses to consume and an unmissable error is
   produced within seconds on both sides.
2. **Given** runs are in flight, **When** the operator switches between
   modes, **Then** in-flight runs drain under the old owner (finish or are
   explicitly cancelled) before the new owner acquires the lock, and no run
   is left without an owner.
3. **Given** the documentation in the local-setup guide, **When** the
   operator follows it to enter or exit the mode, **Then** the failure
   modes the mode prevents (dev-edit outages, double consumption) are
   explicitly named there.

---

### User Story 3 - Failed callbacks leave a visible trail on the run (Priority: P2)

An agent run experiences callback failures (the channel is down or
unreachable). The tool server — the only witness — records each delivery
failure as durable, compact evidence next to its outbox. When the run
exits (any terminal branch) or when the periodic reconciler next passes,
the system ingests that evidence into the run's event timeline. The
operator opens the run's detail page and sees WHEN and HOW its callbacks
failed — tool name, number of attempts, last error, target host — even
though the backend never received those requests. No manual SQL.

**Why this priority**: This is the observability half of the incident
lesson: even with A in place, failures will still happen (misconfiguration,
genuine crashes), and today they are invisible. B is also the data source
for C.

**Independent Test**: Run a callback-wired agent against an unreachable
callback target so retries exhaust. After the run terminates (or after the
reconciler pass), open the run detail and verify the failure timeline is
shown with timestamps, tool names, attempts, and last error — with no
database access.

**Acceptance Scenarios**:

1. **Given** a callback tool call whose delivery retries exhaust, **When**
   the tool server gives up, **Then** a compact evidence record (timestamp,
   tool, attempt count, last error name and message, target host) is
   durably written per run — best-effort, never throwing, never altering
   the agent-visible behavior of the tool call.
2. **Given** a run with recorded channel-failure evidence, **When** the run
   reaches any terminal branch, **Then** the evidence is persisted as run
   events on that run and the evidence file is consumed.
3. **Given** a run whose exit-path ingestion did not happen (crash, missed
   branch), **When** the periodic reconciler next passes, **Then** the same
   ingestion occurs — and if both paths race, no duplicate run events are
   produced.
4. **Given** ingested channel-failure events, **When** the operator opens
   the run's detail page, **Then** the failure timeline is readable in the
   run's event timeline following the existing timeline conventions (no
   raw JSON dumps).
5. **Given** evidence that cannot be attributed to a known run, **When**
   ingestion encounters it, **Then** it is handled per the same retention
   posture as unresolvable outbox files (kept for a bounded time, then
   removed with a log line) — never crashing the worker.

---

### User Story 4 - Operator sees channel health at a glance (Priority: P3)

The operator glances at the dashboard and immediately knows whether the
callback channel is healthy. A compact indicator shows the aggregate:
time of the last successful callback, recent channel-failure and pre-flight
probe-failure counts, and the deployment-guard status. When failures exceed
the degraded threshold within the recent window, the indicator turns
degraded/red; clicking through leads to the affected runs. When the
evidence window empties, the indicator recovers to healthy on its own.
Runs that experienced failed or undelivered callbacks carry a visible
marker in the runs list and run detail.

**Why this priority**: Turns the incident's "hand-written SQL at midnight"
into a glance. Depends on B's data, hence after it.

**Independent Test**: Seed channel-failure evidence (a run with ingested
failure events and/or failed pre-flight probes) and verify the indicator
goes degraded within one polling interval, links to the affected runs, and
returns to healthy after the window passes with no failures.

**Acceptance Scenarios**:

1. **Given** a healthy system, **When** the first channel-failure evidence
   is ingested or a pre-flight probe fails, **Then** the dashboard
   indicator reflects the degraded state within one polling interval.
2. **Given** a degraded indicator, **When** the operator clicks it,
   **Then** they land on the affected runs.
3. **Given** no new failure evidence, **When** the recent window slides
   past the last failure, **Then** the indicator returns to healthy
   automatically, with no operator action.
4. **Given** a run with failed or undelivered callbacks, **When** the
   operator views the runs list or that run's detail, **Then** the run
   carries a visible marker, surfaced through the same mechanism as
   feature 026's undelivered-report surfacing (one mechanism, not two).
5. **Given** a fresh system with no runs or evidence at all, **When** the
   operator views the indicator, **Then** it shows a sensible healthy/
   no-data state rather than an error.

---

### Edge Cases

- Evidence writing must never harm the run: if the evidence file cannot be
  written (permissions, disk full), the callback tool's agent-visible
  behavior is unchanged and the failure to write is at most logged.
- A long outage produces many failure records for one run: the per-run
  evidence is bounded (summary-level granularity, capped volume) so a
  15-minute outage cannot bloat storage or the run timeline unreadably.
- Exit-path ingestion and the periodic reconciler race on the same evidence
  file: exactly-once outcome for run events (idempotent ingestion), file
  consumed once.
- Evidence for a run that is already long finalized: still ingested and
  attached to that run (late-arriving diagnostics are valid), never
  re-opening or altering the run's status.
- The stable mode's runtime resolves paths/environment differently than the
  dev workflow (built-output entry paths and a dedicated port vs dev-source
  paths): the evidence files, outbox, pre-flight probe, and deployment
  guard must all operate on filesystem locations that both the tool server
  and the ingesting worker actually share in that mode — verified, not
  assumed.
- Mode switching with runs in flight: runs drain under the old owner before
  the lock changes hands; the switch procedure surfaces active runs and
  waits or instructs — no run may end up ownerless.
- The exclusive worker lock must not become its own outage: if the lock
  holder dies uncleanly, ownership must be recoverable without manual
  surgery (bounded takeover), while still never allowing two simultaneous
  consumers.
- Threshold boundary flapping: an indicator that oscillates healthy/degraded
  on a single stale event at the window edge should settle deterministically
  (window and threshold semantics are exact, not fuzzy).
- The health aggregate must stay cheap: derived from existing data on
  demand; polling it at the dashboard's interval must not measurably load
  the system.

## Requirements *(mandatory)*

### Functional Requirements

**A — Stable agent-serving runtime mode**

- **FR-001**: The system MUST define exactly ONE supported stable serving
  mode in which the callback target's availability is decoupled from human
  editing activity (file edits, branch switches, failed rebuilds, dev-watch
  restarts on the same machine). Shape (clarified 2026-07-21): a second
  native non-watch backend + worker pair started from built output on a
  dedicated port, with the worker's callback target pointing at the stable
  backend; the dev-watch stack keeps its usual port for the human.
- **FR-002**: Entering and exiting the mode MUST each be a single
  documented command, and the operator MUST be able to tell which mode is
  currently active.
- **FR-003**: The mode MUST be documented in the local-setup guide,
  including the failure modes it prevents and the switch procedure for
  in-flight runs.
- **FR-004**: Two workers MUST never silently compete for the same agent
  queues. Mechanism (clarified 2026-07-21): an exclusive worker lock in the
  shared queue store over a single queue namespace — exactly one worker
  holds the lock and consumes; a second worker in a competing configuration
  MUST refuse to consume and raise a loud, unmissable error on both sides
  within seconds. On mode switch, in-flight runs drain under the old owner
  (finish or are explicitly cancelled) before the new owner acquires the
  lock; no silent handover, no ownerless runs.
- **FR-005**: The pre-flight channel probe and the deployment guard from
  feature 026 MUST work identically in the stable mode: path and
  environment resolution in the mode's runtime is explicitly verified
  (tool-server entry path, outbox/evidence locations shared between tool
  server and worker).
- **FR-006**: Phase-0 runs (no callback channel) MUST be unaffected by the
  mode in every respect.

**B — Channel-failure breadcrumbs**

- **FR-007**: On retry exhaustion of any callback tool delivery, the tool
  server MUST durably record a compact evidence record per run — timestamp,
  tool name, attempt count, last error name and message, and target host —
  stored alongside the existing outbox. Recording is best-effort: it never
  throws, never delays or changes the agent-visible tool behavior, and its
  absence never affects the run (same posture as the outbox writer).
- **FR-008**: Evidence granularity is summary-per-exhaustion (not one
  record per attempt), and per-run evidence volume MUST be bounded.
- **FR-009**: The worker MUST ingest a run's evidence into the run's event
  timeline at every terminal branch of run exit AND via the periodic
  reconciler, using the existing run-events storage (a dedicated event
  type; no database schema change). Ingestion MUST be idempotent across
  the two paths, and the evidence file is consumed after successful
  ingestion.
- **FR-010**: The run detail page MUST present ingested channel-failure
  events in the run's timeline following the existing timeline readability
  conventions (typed events via the presenter, no raw JSON dumps), so the
  operator can answer "when and how did this run's callbacks fail" without
  database access.
- **FR-011**: Unattributable or unreadable evidence MUST be retained for a
  bounded period and then removed with a log line, mirroring the outbox
  reconciler's posture; it never crashes the worker.

**C — Channel-health surface**

- **FR-012**: The system MUST expose ONE additive read-only aggregate of
  channel health for the operator: timestamp of the last successful
  callback, count of channel-failure events in a recent window, count of
  pre-flight probe failures in the same window, and current
  deployment-guard status. It is derived from existing data (run events and
  probe outcomes); no new durable storage.
- **FR-013**: The dashboard MUST show a compact channel-health indicator in
  the global layout (visible from every page) with at least healthy and
  degraded states. Degraded (clarified 2026-07-21, defaults configurable):
  any pre-flight probe failure OR ≥ 3 channel-failure events within a
  15-minute window, and always while a deployment-guard violation is
  active. The indicator recovers to healthy automatically when the window
  no longer meets the criteria, and links through to the affected runs.
- **FR-014**: The indicator MUST reflect state changes within one polling
  interval of the evidence appearing, using the dashboard's existing
  polling approach.
- **FR-015**: Runs with failed or undelivered callbacks MUST carry a
  visible marker in the runs list and run detail, surfaced through the
  same mechanism as feature 026's undelivered-report surfacing — one
  mechanism, not a parallel one.
- **FR-016**: All new configuration (thresholds, window sizes, mode ports/
  targets) MUST be resolved lazily at context init with no silent localhost
  fallbacks (project Rule 1), and MUST have sensible documented defaults.

**Cross-cutting**

- **FR-017**: Existing callback HTTP endpoints are unchanged; all new
  endpoints are additive. The Jira write path is untouched.
- **FR-018**: No new external dependencies; no database schema changes
  (run-events reuse only).
- **FR-019**: Each phase (A, B, C) MUST be independently mergeable, with B
  merged before C.

### Key Entities

- **Channel-failure evidence record**: one compact record of a callback
  delivery giving up — timestamp, tool name, attempt count, last error
  (name and message), target host. Written by the tool server per run,
  stored durably alongside the outbox until ingested.
- **Channel-failure run event**: the ingested form of an evidence record,
  attached to its run in the existing run-events timeline under a dedicated
  event type; what the run detail page renders.
- **Channel-health aggregate**: an on-demand, derived summary — last
  successful callback time, windowed failure counts (channel failures,
  probe failures), deployment-guard status — never stored, always computed
  from existing data.
- **Serving mode**: the operational state of the machine — plain dev
  workflow vs stable serving mode — with exactly one worker owning the
  agent queues in either state.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With the stable serving mode active, killing or restarting
  the human's dev-watch backend mid-run causes ZERO failed callbacks on
  in-flight runs, demonstrated by the scenario in User Story 1's
  independent test.
- **SC-002**: In every documented mode and transition, exactly one worker
  consumes the agent queues; a deliberately provoked double-worker overlap
  is either impossible or produces an unmissable warning within 10 seconds.
- **SC-003**: For a run that experienced callback failures, the operator
  can answer "when and how did its callbacks fail" from the run detail page
  alone — zero SQL, zero log spelunking — including tool, attempts, last
  error, and target.
- **SC-004**: The dashboard reflects a dead or degraded channel within one
  polling interval of the first evidence, and returns to healthy
  automatically without operator action once the window clears.
- **SC-005**: All gates green: `pnpm typecheck && pnpm lint && pnpm test`
  and `pnpm test:integration`; Phase-0 run behavior is byte-for-byte
  unchanged.
- **SC-006**: Time for the operator to diagnose a dead channel drops from
  "hand-written SQL during an incident" to under one minute using only the
  dashboard (indicator → affected runs → failure timeline).

## Assumptions

- **Feature 026 is merged and available.** The deployment guard, widened
  exit-time reconcile, periodic reconciler, pre-flight probe, and
  undelivered-report surfacing exist; this feature builds on those
  primitives and reuses them rather than duplicating them.
- **Mode shape is decided** (Clarifications, 2026-07-21): a second native
  non-watch pair on a dedicated port. The plan phase details ports, build
  step, and process supervision — not the shape itself.
- **Worker exclusivity is decided** (Clarifications, 2026-07-21): exclusive
  worker lock over a single queue namespace; drain on mode switch. The plan
  phase details lock TTL/renewal and the switch UX, not the mechanism.
- **Breadcrumb granularity is decided** (Clarifications, 2026-07-21): one
  summary record per retry exhaustion; a 15-minute outage stays a handful
  of records per run. Per-attempt detail remains in the tool server's
  stderr as today.
- **Health criteria and placement are decided** (Clarifications,
  2026-07-21): 15-minute window; degraded on any probe failure or ≥ 3
  channel-failure events; guard violation always degraded; indicator in
  the global layout. Values are configurable with these defaults.
- **Degraded health is observability-only** (Clarifications, 2026-07-21):
  it never pauses or gates runs; admission control remains solely the
  pre-flight probe's job (026).
- **Single-operator internal tool**: no auth/RBAC changes; the health
  aggregate is visible to the same audience as the rest of the dashboard.
- **Existing timeline and pagination conventions apply** to any new UI:
  typed timeline events via the presenter, unified server-side pagination
  for any new list views, brand palette via theme tokens only, static
  lucide icons.
