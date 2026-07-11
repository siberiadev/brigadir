# Feature Specification: Jira Core — The Orchestrator Replaces Jira Automation

**Feature Branch**: `002-jira-core`

**Created**: 2026-07-11

**Status**: Draft

**Input**: User description: "Iteration 2 from docs/plan-internal.md — Jira core: the orchestrator replaces Jira Automation. JiraModule (typed client, rate limiter, per-issue write serialization, transition discovery, ADF composer), reconciliation poller with high-water mark, pipeline status machine on mock Jira; closes iteration-1 deviations F2 and F3."

**Normative sources** (this spec derives from, and defers to, these documents):
`docs/plan-internal.md` (iteration 2 row; "Принятые решения" decisions 1, 3, and 5 — board-scoping, 2026-07-11), `docs/spec.md` §0.1 (`agents.yaml` workspace `board_id`), §0.2 (JiraModule), §0.3 (IngestModule — board-type-dependent poller scope), §0.4 (PipelineModule), §0.5 (worker settings), "Сквозные NFR" items 1–2; `docs/architecture.md` §1 (module responsibilities), §2 (ticket-pipeline sequence + principles), §3 (Postgres schema — implement as-is, do NOT redesign), §4 (`exitStatus` → run-status mapping, reconcile-sweeper duties), §5 ("Семантика" — what `onRunFinished` does per outcome); `docs/research.md` §5 (Jira Cloud API ground truth: `/search/jql` pagination, per-issue write limits 20/2s, transition discovery + 409, ADF, rate-limit headers); `.specify/memory/constitution.md` (Principles I–III, VI in particular); `docs/progress.md` (iteration-1 deviations F2 and F3 — this iteration closes both).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Board-Driven Orchestration Loop (Priority: P1)

As a BRIGADIR operator, when a Jira ticket enters an agent's trigger status, the orchestrator runs that agent and, when the run finishes, moves the ticket to the outcome status and posts a checklist comment — the whole loop that used to live in Jira Automation now runs in BRIGADIR, against real Jira.

**Why this priority**: This is the headline of the iteration — "the orchestrator replaces Jira Automation" — and it closes deviation F2 (iteration 1 performed only the Postgres half of run completion; the Jira transition + comment were stubbed). Without this loop there is no product; every other story in this iteration hardens it.

**Independent Test**: Against a mock Jira, drive one ticket through a trigger status; assert a run is enqueued and executed by the mock executor, then assert the ticket is transitioned to the agent's success status and a structured checklist comment is posted — end to end, no real Jira or LLM.

**Acceptance Scenarios**:

1. **Given** an enabled agent whose trigger status is "Ready for Dev", **When** a ticket is observed entering "Ready for Dev", **Then** exactly one run is created and enqueued for that (ticket, agent) pair.
2. **Given** a run whose mock outcome is `success`, **When** the run finishes, **Then** the ticket is transitioned to the agent's success status and a checklist comment (panel + summary + per-check task list) is posted, in that order after the run result is persisted.
3. **Given** a run whose mock outcome is `failure`, **When** the run finishes, **Then** the ticket is transitioned to the agent's failure status and an explanatory comment is posted.
4. **Given** a run whose mock outcome is `needs_human`, **When** the run finishes, **Then** the ticket is transitioned to the failure status, a comment with the question is posted, and the human task already opened for that run is left as the single open task (no duplicate).
5. **Given** an agent that configures an optional running status, **When** the worker starts the job, **Then** the ticket is transitioned to the running status at job start (not at enqueue time).
6. **Given** the agent's board is misconfigured so no transition to the target status exists from the current status, **When** completion tries to transition, **Then** the run is recorded as failed with a clear no-transition-path diagnostic rather than the ticket being left silently unmoved.

---

### User Story 2 - Guaranteed Ingest: No Jira Event Is Ever Lost (Priority: P1)

As a BRIGADIR operator, I trust that every relevant ticket status change is eventually noticed and acted on even if the orchestrator was offline — a periodic reconciliation against Jira is the guaranteed path, and it never drops or double-fires an event.

**Why this priority**: Constitution Principle I makes reconciliation the guarantee (webhooks are only a speed-up). This closes the polling half of deviation F3 (iteration 1 shipped a no-op reconcile stub). Without a proven catch-up path, an outage silently strands tickets — the exact pain the tool exists to remove.

**Independent Test**: Simulate a one-hour outage during which several tickets changed status in mock Jira; run one reconciliation pass and assert that every missed status change produces exactly one triggered run, and that a second immediate pass produces none (idempotent, no double-fire).

**Acceptance Scenarios**:

1. **Given** a persisted high-water mark and several tickets updated in Jira since then, **When** a reconciliation pass runs, **Then** it queries Jira for tickets updated at/after the mark minus a fixed overlap window, pages through all results, and upserts each ticket.
2. **Given** a ticket whose Jira status differs from its last-seen cached status, **When** reconciliation observes it, **Then** a status-changed event is emitted into the pipeline exactly as if a webhook had delivered it.
3. **Given** a ticket whose Jira status equals its last-seen cached status, **When** reconciliation observes it, **Then** no status-changed event is emitted.
4. **Given** a completed reconciliation pass, **When** it finishes, **Then** the high-water mark is advanced to the maximum observed update time and persisted so the next pass resumes from there.
5. **Given** a one-hour outage with N missed status changes, **When** the poller catches up, **Then** N runs are triggered — no more (dedup holds), no fewer (nothing lost) — and re-running the pass immediately triggers zero additional runs.

---

### User Story 3 - Rate-Limit-Safe, Correct Jira Writes (Priority: P2)

As a BRIGADIR operator, the orchestrator writes to Jira without ever getting throttled into failure or corrupting a ticket through concurrent writes — writes to a single ticket are serialized, rate limits are respected, and transitions are discovered at runtime and retried on conflict.

**Why this priority**: Jira enforces a strict per-issue write budget (20 writes / 2 s) and transition ids are workflow- and state-specific. Getting this wrong turns the happy-path loop (US1) into intermittent board corruption and 429 storms under any real load. It is separable from US1 because the write client can be exercised in isolation.

**Independent Test**: Fire many concurrent writes at one ticket against a mock Jira that enforces per-issue ordering and returns 429/Retry-After and 409 on cue; assert writes to that ticket are applied one at a time, the retry delay is honored, a conflicting transition is re-discovered and retried once, and an impossible transition surfaces a typed no-path error.

**Acceptance Scenarios**:

1. **Given** several concurrent write requests targeting the same ticket, **When** they are submitted, **Then** they are applied one at a time in submission order; writes to different tickets may proceed in parallel.
2. **Given** Jira responds 429 with a Retry-After header, **When** the client sees it, **Then** it pauses for at least the indicated delay before retrying and does not count the pause as a run failure.
3. **Given** a request for a transition to a named target status, **When** the client transitions the ticket, **Then** it discovers the available transitions at runtime, matches the target status by name (case-insensitive), and posts the matched transition id; discovery results are cached per project + issue type + originating status for a bounded time.
4. **Given** a cached transition that Jira rejects with 409 (state changed underneath), **When** the transition is attempted, **Then** the cache entry is invalidated and the transition is re-discovered and retried once.
5. **Given** no transition path exists from the current status to the target status, **When** the client attempts it, **Then** it raises a typed no-transition-path error carrying enough context to diagnose the board misconfiguration.

---

### User Story 4 - Self-Healing Runs: Watchdog and Drift Repair (Priority: P2)

As a BRIGADIR operator, no run hangs forever and the database never permanently disagrees with the queue or with Jira — the same reconciliation job that polls Jira also times out stuck runs and repairs drift between run records, queue jobs, and pending Jira writes.

**Why this priority**: Completes the remaining duties of deviation F3 (repair of run ↔ queue drift) and satisfies NFR item 1 ("no run hangs forever"). It also backstops US1's ordering rule — because the result is persisted before the Jira write, a crash in between must be self-healed rather than left as a silently unmoved ticket.

**Independent Test**: Seed a run that has been running past its timeout-plus-grace and a run whose result is persisted but whose Jira transition never happened; run one reconciliation pass and assert the first is failed/timed-out with diagnostics and the second's pending transition is completed.

**Acceptance Scenarios**:

1. **Given** a run in the running state past its timeout plus a grace period, **When** reconciliation runs, **Then** the run is moved to a terminal timed-out/failed state with diagnostics and its ticket receives the failure outcome treatment.
2. **Given** a run whose result was persisted but whose completion Jira write did not land (simulated crash between the two), **When** reconciliation runs, **Then** the outstanding transition and/or comment are re-applied so ticket and database agree.
3. **Given** a run record marked active but with no corresponding live queue job or child process, **When** reconciliation runs, **Then** the drift is repaired (the run is re-driven or failed per policy) with no duplicate active run created.
4. **Given** any of the above repairs, **When** they run again immediately, **Then** they make no further changes (repairs are idempotent).

---

### User Story 5 - Live Smoke Against a Real Jira Project (Priority: P3)

As the project owner, I confirm the orchestrator works against a real Jira Cloud project with a bot account and API token before declaring the iteration done — one ticket driven through a trigger status to a successful transition and comment, recorded in the progress journal.

**Why this priority**: The automated suite runs on mock Jira; a single manual live pass proves the real API auth, rate-limit headers, transition workflow, and ADF rendering behave as the mock assumes. It is P3 because it is a one-time manual verification gate, not shippable code, and depends on US1–US3 being green.

**Independent Test**: On a real test Jira project, with a dedicated bot account and API token, move one ticket into a trigger status and observe the orchestrator (with the mock executor) transition it to the success status and post a rendered checklist comment; record the run in `docs/progress.md`.

**Acceptance Scenarios**:

1. **Given** a real test Jira project, a bot account, and a valid API token, **When** a ticket is moved into an agent's trigger status, **Then** the orchestrator triggers a mock-executor run, transitions the ticket to the success status, and posts a checklist comment visible in Jira.
2. **Given** the live smoke completed, **When** the iteration is closed, **Then** the outcome is recorded in `docs/progress.md` (iteration 2 entry) noting that deviations F2 and F3 are closed.

---

### User Story 6 - Board-Type-Aware Ingest Scope (Priority: P1)

*(Added by amendment 2026-07-11 — decision 5 in `docs/plan-internal.md`; `docs/spec.md` §0.1, §0.3.)*

As a BRIGADIR operator, a workspace is bound to a specific Jira board, and the orchestrator only acts on the tickets that board considers in scope — a kanban board scopes to all its tickets, while a scrum board scopes to the active sprint only — so agents never fire on backlog or out-of-sprint tickets, and a ticket entering scope while already in a trigger status is treated as a trigger.

**Why this priority**: Board scoping decides *which* tickets the guaranteed ingest path (US2) ever sees. Getting it wrong means either agents fire on backlog items that should be dormant (scrum) or in-sprint tickets are missed after a sprint starts (whose `updated` field never changes). It is P1 because it constrains the correctness of every trigger; it builds directly on US2 and shares its dedup guarantees.

**Independent Test**: Point a workspace at a scrum board and at a kanban board in turn against mock Jira; assert scrum polling is scoped to the active sprint (idle when none is active), scope-entry into a trigger status fires exactly one run, a sprint switch recovers in-status tickets whose `updated` never changed, and kanban behavior is byte-for-byte the pre-amendment behavior.

**Acceptance Scenarios**:

1. **Given** a workspace bound to a scrum board with no active sprint, **When** a reconciliation pass runs, **Then** the pass is an idle no-op and no agent is triggered, regardless of ticket statuses in the backlog.
2. **Given** a scrum workspace with an active sprint, **When** a ticket already sitting in an agent's trigger status is added to that active sprint (entering scope with no prior last-seen status), **Then** the agent fires exactly once — and a repeat pass fires it zero further times (all three dedup layers still apply).
3. **Given** a scrum workspace whose active sprint changes (a new sprint starts) without any issue's update time changing, **When** the poller detects the active-sprint id changed, **Then** it performs a one-off full rescan of the new active sprint ignoring the update-time floor, picks up every in-status ticket, and then resumes normal high-water-mark polling.
4. **Given** a workspace bound to a kanban board, **When** reconciliation runs, **Then** the scope and trigger behavior are unchanged from the pre-amendment specification (project + updated-since-mark, no sprint clause).
5. **Given** a new workspace is connected or seeded with a board id, **When** the connection is established, **Then** the system introspects the board to determine its type (kanban/scrum) and project key, validates access, and persists the board type; an inaccessible or unknown board fails the connection with a clear diagnostic.
6. **Given** a workspace whose scope filter is `scope_jql = "labels = ai-pipeline"`, **When** reconciliation runs, **Then** the scope filter is ANDed into the query for either board type and a ticket without the `ai-pipeline` label never triggers an agent even while sitting in that agent's trigger status, while an otherwise-identical ticket that has the label does trigger.

---

### User Story 7 - Dependency-Gated Triggering (Priority: P2)

*(Added by amendment 2026-07-11 — dependency gate in trigger matching.)*

As a BRIGADIR operator, an agent does not start work on a ticket that is still blocked by another unfinished ticket — and the moment the blocker is finished, the ticket is picked up on its own, without anyone touching it — so agents respect the "is blocked by" dependencies drawn on the board instead of charging ahead on work that cannot succeed yet.

**Why this priority**: Firing an agent on a ticket whose prerequisite is not done produces wasted or wrong work (and a misleading failure comment). Honoring "is blocked by" links makes the emergent pipeline respect declared ordering. It is P2 — a correctness guard on trigger matching, separable from and layered on top of the base loop (US1) and ingest (US2/US6), which function without it. The self-healing catch is subtle: resolving a blocker does not change the *blocked* ticket's update time, so the guarantee that it eventually fires depends on reconciliation re-evaluating it (mirrors the sprint-switch rescan in US6).

**Independent Test**: Against mock Jira, place a ticket in an agent's trigger status with an open "is blocked by" link to an unfinished issue and assert no run is enqueued; then move the blocker to a done-category status and run one reconciliation pass and assert the agent fires exactly once, with a second immediate pass firing zero.

**Acceptance Scenarios**:

1. **Given** a ticket in an agent's trigger status with one or more open "is blocked by" links (a linked blocker whose status is not in a done category), **When** trigger matching evaluates it, **Then** no run is enqueued for that agent and the skip is recorded/logged with the blocking reason.
2. **Given** a ticket in a trigger status whose only "is blocked by" links point to issues that are all in a done category, **When** trigger matching evaluates it, **Then** the agent fires normally (the gate is clear).
3. **Given** a previously-blocked ticket still sitting in the trigger status, **When** its blocker moves to a done-category status (which does not change the blocked ticket's update time) and the next reconciliation pass runs, **Then** the agent fires exactly once; a subsequent pass fires zero (dedup layers hold).
4. **Given** a ticket in a trigger status linked to other issues only by non-blocking link types (e.g. "relates to", or an outward "blocks" link), **When** trigger matching evaluates it, **Then** those links do not gate it and the agent fires normally.

---

### Edge Cases

- **Overlap re-observation**: because reconciliation queries from `high-water mark − overlap`, a ticket may be seen twice with an unchanged status; the diff-on-`last_seen_status` must suppress the second as a no-op (no duplicate trigger).
- **Clock/`updated` ties**: multiple tickets sharing the same `updated` timestamp at the mark boundary must all be processed and none skipped when the mark advances.
- **Concurrent enqueue on the same trigger**: two overlapping ingest sources (poller re-runs, or poller + a future webhook) observing the same status change must still yield at most one active run — all three idempotency layers apply.
- **Transition already applied**: if the ticket is already in the target status (a prior partial success), completion must treat the transition as satisfied rather than erroring.
- **429 during a burst of writes to one ticket**: the per-issue serialization plus rate-limit backoff must not deadlock or drop queued writes for that ticket.
- **Empty or malformed report at completion**: completion Jira actions are driven by the persisted report; a run failing without a valid report still receives failure-outcome treatment (transition to failure status + comment).
- **Long outage beyond the overlap window**: catch-up must still recover every change because the query floor is the persisted high-water mark, not a fixed recent window.
- **Token expiry / auth failure to Jira**: a rejected credential surfaces as an unrecoverable, clearly-diagnosed condition rather than an infinite retry loop.
- **Scrum board idle indefinitely**: a scrum board with no active sprint must poll as a no-op indefinitely without erroring, accumulating no work, and resume normally the moment a sprint becomes active.
- **Scope entry vs. update-time floor**: a ticket entering the active sprint (or a sprint starting) does not change the ticket's `updated` field, so it can be older than the high-water mark; scope-entry handling and the sprint-switch full rescan must catch it despite the update-time floor.
- **Active-sprint id churn**: if the active sprint changes more than once between passes, the rescan must key off the currently-active sprint id so no sprint's in-status tickets are skipped.
- **Scope exit (ticket leaves the sprint)**: a ticket removed from the active sprint leaving scope is not a trigger and does not, by itself, cancel or alter an already-active run for that ticket (out-of-scope departures are not modeled as events this iteration).
- **Multiple blockers**: a ticket with several "is blocked by" links stays gated until *every* blocker is in a done category; one remaining unfinished blocker keeps the agent from firing.
- **Blocker outside board scope**: a "is blocked by" link may point to an issue on another board/project; the gate is evaluated from that linked issue's status category regardless of whether it is in the workspace's ingest scope.
- **Blocker reopened before the run starts**: if a blocker returns from done to a non-done status while the blocked ticket is still waiting, the gate re-closes and the agent does not fire; an already-started run is unaffected (mirrors scope-exit handling).
- **New blocker added while waiting**: a ticket already sitting in a trigger status that gains a new open "is blocked by" link stays gated on the next reconciliation re-evaluation.
- **Blocker-resolution vs. update-time floor**: resolving a blocker changes the *blocker's* update time, not the blocked ticket's, so a plain updated-since-mark query would never re-surface the blocked ticket — reconciliation must re-evaluate tickets sitting in trigger statuses independently of the update-time floor.
- **Gate cleared and status-change arrive together**: if a ticket both enters the trigger status and has its gate cleared around the same pass, it must still fire exactly once (all three idempotency layers apply).

## Requirements *(mandatory)*

### Functional Requirements

**Jira client & write safety**

- **FR-001**: The system MUST authenticate to Jira Cloud REST v3 using basic auth (bot email + API token) read from the workspace's stored credentials, resolved through a dependency-injection factory at context-init time — never eagerly at module-composition time and never with a silent localhost/default fallback (Constitution "Lazy resource resolution").
- **FR-002**: The system MUST apply a client-side rate limit (configurable requests-per-second token bucket, default 5) and a global concurrency cap (default 8) across all Jira calls.
- **FR-003**: On a Jira 429 response the system MUST pause for at least the server-provided Retry-After delay before retrying (falling back to exponential backoff with jitter, capped at 5 minutes, when the header is absent) and MUST log the rate-limit reason; such a pause MUST NOT be counted as a run failure or consume a run attempt.
- **FR-004**: The system MUST serialize all mutating Jira operations (transition, comment, property) per issue key so that at most one write to a given ticket is in flight at a time, while permitting writes to different tickets to proceed concurrently.
- **FR-005**: The system MUST resolve a transition to a named target status by discovering the ticket's available transitions at runtime, matching the target by status name case-insensitively, and issuing the matched transition id.
- **FR-006**: The system MUST cache transition-discovery results keyed by project + issue type + originating status with a bounded time-to-live (default 10 minutes).
- **FR-007**: On a 409 conflict during a transition the system MUST invalidate the relevant cache entry, re-discover transitions, and retry the transition exactly once.
- **FR-008**: When no transition path exists from the current status to the target status, the system MUST raise a typed no-transition-path error that carries the ticket, current status, and target status, and MUST cause the run to be recorded as failed with that diagnostic (a board-configuration fault, not a silent no-op).
- **FR-009**: The system MUST compose ticket comments as structured Atlassian Document Format documents built from a run report: an outcome-appropriate panel (informational for success, error for failure/needs-human), the report summary, and a task list rendering each check with its status (pass / fail / warn / skip) and reason.
- **FR-010**: The system MUST expose Jira access behind a client interface so an alternate auth implementation can be added later without changing callers.

**Ingest & reconciliation**

- **FR-011**: The system MUST run reconciliation as a real scheduled queue job (not a no-op), on a fixed interval (default 5 minutes), proven idempotent when scheduled repeatedly.
- **FR-012**: Each reconciliation pass MUST query Jira for tickets in the workspace's project updated at or after the persisted high-water mark minus a fixed overlap window (60 seconds), requesting only an explicit set of fields, and MUST page through all results using the cursor/next-page-token pagination of the current search endpoint. When the workspace defines an optional global scope filter (`scope_jql`, see FR-038), that filter MUST be ANDed into this query so that tickets outside the scope filter are never ingested or triggered.
- **FR-013**: For each returned ticket the system MUST upsert the ticket record and compare its live Jira status against the cached last-seen status; when they differ it MUST emit a status-changed event into the pipeline identical in shape to a webhook-sourced event, and when they match it MUST emit nothing.
- **FR-014**: The system MUST advance and persist the high-water mark to the maximum observed ticket update time after a pass, storing it in the workspace settings so the next pass resumes from it.
- **FR-015**: The reconciliation job MUST also act as a watchdog: any run still running past its timeout plus a grace period MUST be moved to a terminal timed-out/failed state with diagnostics and given the failure-outcome treatment on its ticket.
- **FR-016**: The reconciliation job MUST repair drift between run records, queue jobs, and pending Jira writes — including completing a Jira transition/comment for a run whose result was persisted but whose Jira write did not land — without ever creating a duplicate active run.
- **FR-017**: Catch-up after an outage of arbitrary length MUST recover every missed status change, because the query floor is the persisted high-water mark rather than a fixed recent window.

**Pipeline: trigger & completion**

- **FR-018**: On a status-changed event the system MUST select enabled agents whose trigger status equals the new status and, for each, create-and-enqueue a run passing through all three idempotency layers (inbound-event dedup, queue deduplication keyed by ticket+agent, and the partial-unique active-run database guard); it MUST NOT start a second active run for a (ticket, agent) pair.
- **FR-019**: When an agent defines an optional running status, the system MUST transition the ticket to that status at job start (when the worker picks up the job), not at enqueue time.
- **FR-020**: On run completion with outcome `success`, the system MUST transition the ticket to the agent's success status and post the checklist comment.
- **FR-021**: On run completion with outcome `failure` or `needs_human`, the system MUST transition the ticket to the agent's failure status and post a comment; for `needs_human` it MUST rely on the single human task already opened for that run (created by run processing) and MUST NOT open a duplicate.
- **FR-022**: The system MUST persist the run result in the database first and perform Jira writes second, so that a crash between the two leaves a recoverable state that reconciliation repairs (FR-016) rather than an inconsistent one.
- **FR-023**: Completion Jira actions MUST be idempotent with respect to the current ticket state: if the ticket is already in the target status the transition MUST be treated as satisfied rather than erroring.
- **FR-024**: All Jira writes for the pipeline (transitions, comments) MUST go through the per-issue write path (FR-004); no pipeline or agent code may call Jira around it (Constitution Principle III — only the system writes to Jira).

**Testing & verification**

- **FR-025**: The system MUST ship automated integration tests against a mock Jira covering: the full loop (status change → enqueue → mock run → transition + ADF comment); the one-hour-outage catch-up proving no lost and no duplicated events; per-issue write serialization under concurrent writes; rate-limit handling honoring Retry-After; and transition discovery including the 409-retry and no-transition-path cases (Constitution Principle VI — pipeline logic ships with tests in the same change).
- **FR-026**: A live smoke against a real Jira project (bot account + API token) MUST be executed once and recorded in `docs/progress.md` as the iteration-2 entry, explicitly noting that deviations F2 and F3 are closed.

**Board scope & sprint awareness** *(added by amendment 2026-07-11 — `docs/plan-internal.md` decision 5, `docs/spec.md` §0.1 & §0.3)*

- **FR-027**: A workspace MUST be bound to a specific Jira board. A migration MUST add `jira_board_id` (integer) and `jira_board_type` (text, one of `kanban` | `scrum`) to the `workspaces` table, and the workspace section of the agents configuration schema MUST be extended with a `board_id` field and an optional `scope_jql` field — both functional this iteration (see FR-038). The same workspace schema MUST also **accept and validate** the additional documented keys `branch_prefix` (string) and `repositories` (array of `{ name, url, default_branch }`) from the `agents.yaml` example in `docs/spec.md` §0.1; these are validated for shape but otherwise unused until iteration 3, so that a config following the documented example passes fail-fast startup validation rather than being rejected as unknown keys. Because the migration changes the schema in `docs/architecture.md` §3, that document MUST be updated in the same change (Constitution governance).
- **FR-028**: At workspace connection/seed time the system MUST introspect the board via the Agile API (`GET /rest/agile/1.0/board/{id}`) to obtain the board type and project key, validate access to the board, and persist `jira_board_type`; an inaccessible or unrecognized board MUST fail the connection with a clear diagnostic rather than defaulting silently.
- **FR-029**: The reconciliation poller's scope MUST depend on the board type: for a **kanban** board it is the project updated at/after the mark-minus-overlap (the FR-012 behavior, unchanged); for a **scrum** board it MUST additionally restrict to the active sprint (`sprint IN openSprints()`). For **both** board types, the optional workspace `scope_jql` (FR-038) MUST be ANDed into the scope in addition to the above (kanban: project + `scope_jql` + updated floor; scrum: project + `sprint IN openSprints()` + `scope_jql` + updated floor).
- **FR-030**: For a scrum board with no active sprint, a reconciliation pass MUST be an idle no-op that triggers no agents and advances no work.
- **FR-031**: Entering scope MUST be treated as a status-changed event: a ticket first observed in scope while already in an agent's trigger status (added to the active sprint, or brought in by a sprint start) MUST be diffed against an absent last-seen status and fire that agent — passing through all three idempotency layers so it fires at most once.
- **FR-032**: The poller MUST persist the active sprint id in the workspace settings; when it detects the active sprint id has changed, it MUST perform a one-off full rescan of the (new) active sprint's issues **without** the update-time floor, then return to normal high-water-mark polling. (Rationale: a sprint start does not modify issues' `updated`, so an update-time-bounded query would miss them.)
- **FR-033**: The system MUST ship automated tests against mock Jira for the board-scope behavior: a scrum board with no active sprint fires no triggers; a ticket added to the active sprint while already in a trigger status fires its agent exactly once (dedup layers applied); a sprint switch causes a full rescan that picks up issues whose `updated` never changed; and a kanban board's behavior is unchanged from the pre-amendment spec.

**Dependency gate in trigger matching** *(added by amendment 2026-07-11)*

- **FR-034**: Trigger matching MUST apply a dependency gate: the system MUST NOT enqueue a run for an agent when the candidate ticket has one or more open "is blocked by" links — that is, an inward "is blocked by" linked issue whose status is not in a done status category. A ticket is eligible only when all of its "is blocked by" blockers are in a done category (or it has none). Only "is blocked by" (inward blocking) links gate; other link types (including an outward "blocks" link, or "relates to") MUST NOT gate.
- **FR-035**: To evaluate the gate the system MUST retrieve, for a candidate ticket, its issue links and the status category of each blocking linked issue (the retrieved field set for reconciliation MUST include issue links accordingly).
- **FR-036**: Because resolving a blocker changes only the blocker's update time and never the blocked ticket's, each reconciliation pass MUST re-evaluate tickets currently sitting in an agent's trigger status that were previously skipped by the dependency gate (independently of the update-time floor) and enqueue the agent once the gate has cleared — passing through all three idempotency layers so at most one run is created.
- **FR-037**: The system MUST ship automated tests against mock Jira for the dependency gate: a ticket in a trigger status with an open "is blocked by" blocker produces no run; when the blocker moves to a done category, the next reconciliation pass fires the agent exactly once and a subsequent pass fires zero.

**Workspace scope filter & config forward-compatibility** *(added by amendment 2026-07-11)*

- **FR-038**: A workspace MAY define an optional global scope filter `scope_jql`. When present it MUST be ANDed into every reconciliation query for the workspace regardless of board type (FR-012, FR-029), so a ticket that does not satisfy `scope_jql` is never ingested and never triggers an agent — even while it sits in an agent's trigger status. This workspace-wide filter is distinct from, and independent of, the per-agent `trigger_jql` (which remains out of scope this iteration). When `scope_jql` is absent the scope is unchanged from the pre-amendment behavior.
- **FR-039**: The system MUST ship a test proving forward-compatibility of the configuration schema: the full workspace example documented in `docs/spec.md` §0.1 — including `board_id`, `scope_jql`, `branch_prefix`, and `repositories[]` — passes fail-fast startup validation and boots, with the validated-but-unused keys (`branch_prefix`, `repositories[]`) neither rejected nor required. A scope-filter test MUST also prove that with `scope_jql = "labels = ai-pipeline"`, tickets lacking the label do not trigger agents even while in a trigger status (mock Jira).

### Out of Scope (this iteration)

- Real `claude_cli` executor (iteration 3) — the mock executor is used throughout.
- Inbound Jira webhook endpoint — optional fast path only; the poller is the guaranteed path. Add only if trivial; the guarantee does not depend on it.
- MCP callback server and per-run callback tools (iteration 5).
- Dashboard / UI (iterations 6–7).
- OAuth 3LO auth (cut per `docs/plan-internal.md`; API-token basic auth only).
- Per-agent `trigger_jql` filtering — trigger matching this iteration keys on `trigger_status` only; the workspace-wide `scope_jql` (FR-038) is in scope, but the per-agent JQL refinement is not.
- Functional use of `branch_prefix` and `repositories[]` — accepted and validated by config this iteration (FR-027) but not consumed until the executor lands in iteration 3.

### Key Entities

- **Workspace**: a connection to one Jira project, bound to a specific Jira board (`jira_board_id`, `jira_board_type` = kanban | scrum); optionally carries a global scope filter (`scope_jql`) ANDed into all ingest queries. Holds the bot credentials (email + API token, encrypted at rest, with expiry tracking) and a settings blob that persists the reconciliation high-water mark and the last-known active sprint id. Source of Jira auth and ingest scope for every call. Its configuration form also accepts the documented forward-compat keys `branch_prefix` and `repositories[]` (validated, unused until iteration 3).
- **Board**: the Jira board the workspace is bound to; its type (kanban vs. scrum), determined once via board introspection, decides the poller's scope. Kanban → whole project; scrum → active sprint only.
- **Sprint / active-sprint id**: for scrum boards, the currently open sprint bounds ingest scope; the last-observed active-sprint id is persisted so a sprint switch can be detected and trigger a full rescan even though issues' update times did not change.
- **Blocking dependency ("is blocked by" link)**: an inward blocking link from a candidate ticket to another issue; the linked issue's status category (done vs. not-done) determines whether the ticket's dependency gate is open. Not persisted as new schema — evaluated from Jira at trigger-match/reconciliation time.
- **Ticket**: the orchestrator's cache of a Jira issue (key, id, summary, last-seen status, last-seen update time). `last_seen_status` is a diff cache only — Jira is the source of truth (Constitution Principle I).
- **Agent**: a configured trigger status and target statuses (running/success/failure) plus timeout and attempt limits; matching a ticket's new status against enabled agents' trigger status is what starts a run.
- **Run**: one execution of an agent against a ticket, with lifecycle status, attempt, outcome, persisted report, and checks; the unit protected by the three idempotency layers and the unit the watchdog times out.
- **Run report & checks**: the structured outcome (`success` / `failure` / `needs_human`), summary, and per-check results that drive the completion transition and the ADF comment.
- **Human task**: an open item created for a `needs_human` (or blocking request) run; completion must not duplicate it.
- **Transition-discovery cache**: an in-memory, time-bounded mapping from (project, issue type, originating status) to the available transitions, invalidated on 409.
- **High-water mark**: the persisted maximum ticket-update timestamp that bounds the next reconciliation query, guaranteeing outage catch-up.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Driving a ticket into a trigger status results in the ticket reaching the correct outcome status with a rendered checklist comment for all three outcomes (success, failure, needs-human) — verified end to end on mock Jira with zero manual steps.
- **SC-002**: After a simulated one-hour outage with N missed status changes, a single catch-up run triggers exactly N runs, and an immediate repeat pass triggers 0 — no event lost, none duplicated.
- **SC-003**: Under many concurrent writes aimed at one ticket, writes to that ticket are observed applied strictly one at a time, with zero out-of-order or overlapping writes, while writes to distinct tickets overlap.
- **SC-004**: When Jira returns 429 with a Retry-After of D, the next write to that resource occurs no earlier than D later, and no run is failed or attempt consumed as a result.
- **SC-005**: A transition attempt against a stale cached id (409) succeeds after exactly one re-discovery + retry; an impossible transition fails fast with a typed no-path error naming the ticket and both statuses.
- **SC-006**: No run remains in a non-terminal running state longer than its timeout plus grace; the watchdog terminates and records any that do within one reconciliation interval.
- **SC-007**: A run whose result is persisted but whose Jira write was interrupted converges to ticket/database agreement within one reconciliation interval, with no duplicate active run.
- **SC-008**: The full integration suite (all scenarios in FR-025) is green on mock Jira, and the one-time live smoke is executed and recorded in `docs/progress.md` with F2 and F3 marked closed.
- **SC-009**: On a scrum workspace, only active-sprint tickets ever trigger runs; a scope-entry into a trigger status fires exactly one run; a sprint switch recovers every in-status ticket even when its update time never changed; a workspace with no active sprint triggers nothing; and a kanban workspace triggers identically to the pre-amendment behavior — all verified on mock Jira.
- **SC-010**: A ticket in a trigger status with an open "is blocked by" blocker never triggers a run; once the blocker reaches a done category, exactly one run is triggered on the next reconciliation pass (never zero, never more than one), even though the blocked ticket's update time did not change — verified on mock Jira.
- **SC-011**: With a workspace `scope_jql` in force, zero tickets outside the filter ever trigger an agent (even in a trigger status), while in-filter tickets behave exactly as without the filter; and the full documented `docs/spec.md` §0.1 example config (with `board_id`, `scope_jql`, `branch_prefix`, `repositories[]`) passes startup validation and boots — both verified automatically.

## Assumptions

- **Auth**: API-token basic auth from a dedicated Jira bot account is the only supported auth path this iteration (decision 1 in `docs/plan-internal.md`); OAuth 3LO is out of scope. Credentials are read from the workspace record via a DI factory.
- **Single writer**: exactly one process performs Jira writes for a workspace, so in-process per-issue serialization is sufficient; a distributed write lock is not required this iteration (per `docs/spec.md` §0.2).
- **Executor**: the deterministic mock executor from iteration 1 stands in for real agents throughout; run outcomes are driven by mock scenarios, not live LLMs.
- **Webhook**: the inbound webhook endpoint is optional and not relied upon; the reconciliation poller is the guaranteed ingest path. If a webhook is added it converges on the same status-changed entry point and inherits the same dedup.
- **Schema**: the Postgres schema from `docs/architecture.md` §3 is otherwise used as-is (`tickets.last_seen_status`/`last_seen_updated`, `workspaces.settings` for the high-water mark and active-sprint id, existing `runs`/`human_tasks`/`run_checks` columns). The one schema change this iteration is the board binding (FR-027): a migration adds `jira_board_id` and `jira_board_type` to `workspaces`; per Constitution governance, `docs/architecture.md` §3 is updated in the same change so the document and the migration stay in agreement.
- **Board scoping** (amendment 2026-07-11): each workspace is bound to exactly one board whose type (kanban/scrum) is fixed at connection time via the Agile API and cached on the workspace. Kanban scope = whole project; scrum scope = active sprint (`sprint IN openSprints()`), with an idle no-op when no sprint is active. Scope entry is a trigger; a sprint switch forces a one-off full rescan because sprint starts do not touch issues' `updated`. The mock Jira reproduces board introspection, `openSprints()` scoping, and sprint membership for tests.
- **Dependency gate** (amendment 2026-07-11): "blocked" means at least one open inward "is blocked by" link whose linked issue is not in a Jira done status category; a blocker is considered cleared when its status category is done. Only "is blocked by" links gate (not "blocks"/"relates to"). The gate is evaluated live from Jira issue links at trigger-match and reconciliation time and needs no new schema — the set of tickets to re-evaluate each pass is derived from tickets currently in an agent's trigger status without an active or completed run for that agent. The mock Jira reproduces issue links and linked-issue status categories for tests.
- **Workspace scope filter** (amendment 2026-07-11): `scope_jql` is an optional workspace-level JQL fragment persisted with the workspace (in the settings blob — no new column) and ANDed into every reconciliation query for both board types; it is distinct from the per-agent `trigger_jql` (out of scope). The mock Jira honors the filter so scoped-out tickets never surface.
- **Config forward-compatibility** (amendment 2026-07-11): the workspace configuration schema validates the full documented `docs/spec.md` §0.1 shape — `board_id` and `scope_jql` are consumed this iteration; `branch_prefix` (string) and `repositories[]` (`{ name, url, default_branch }`) are validated for shape but intentionally unused until iteration 3. Fail-fast startup validation must accept the documented example rather than reject these keys as unknown.
- **Jira API behavior** is taken as ground truth from `docs/research.md` §5: `/search/jql` cursor pagination with explicit fields, per-issue write budget 20/2s, workflow-specific transition ids with 409 on concurrent transition, ADF-only comments in v3, and the documented rate-limit headers. The mock Jira reproduces these behaviors for tests.
- **Reconciliation cadence** is every 5 minutes with a 60-second overlap and a 10-minute transition-cache TTL, matching `docs/spec.md` §0.2–§0.3; these are configurable defaults, not hard constants.
- **Grace period** for the watchdog is a bounded configurable margin added to each agent's `timeout_minutes`; the exact value is an implementation default and does not change observable behavior beyond when termination fires.

## Notes on domain terminology

This feature's problem domain is the Jira Cloud API and the BRIGADIR pipeline; terms such as "status", "transition", "ADF comment", "JQL", "high-water mark", and "run" are domain vocabulary shared with the normative source documents, not leaked implementation choices. Specific libraries, languages, and internal class names are deliberately omitted from the requirements and success criteria and live only in the planning artifacts.

## Revision History

- **2026-07-11 — Amendment: workspace scope filter & config forward-compatibility.** (1) Added an optional workspace-level `scope_jql` global filter ANDed into the reconciliation query for both board types (amended FR-012 and FR-029; added FR-038, US6 acceptance scenario 6, SC-011, Workspace entity note, Workspace scope filter assumption, and an Out-of-Scope note that per-agent `trigger_jql` remains out of scope). (2) Extended FR-027's config schema to add `board_id` + `scope_jql` (functional now) and to accept/validate the documented `branch_prefix` and `repositories[]` keys (validated-but-unused until iteration 3); added FR-039 (full documented example config validates and boots) and a Config forward-compatibility assumption. No existing story, requirement, success criterion, or scenario was renumbered; only FR-012, FR-027, and FR-029 were amended in place as requested.
- **2026-07-11 — Amendment: dependency gate in trigger matching.** Added a dependency gate so an agent does not fire for a ticket with open "is blocked by" links, plus reconciliation re-evaluation to catch blocker resolution (which does not touch the blocked ticket's update time). Added: User Story 7 (Dependency-Gated Triggering, P2); FR-034–FR-037 (gate rule, link retrieval, reconcile re-evaluation, tests); SC-010; new Key Entity (blocking dependency); six new edge cases; a Dependency gate assumption. No schema change (evaluated live from Jira links). No existing requirement, story, success criterion, or scenario was renumbered or rewritten.
- **2026-07-11 — Amendment: board scoping.** Incorporated decision 5 of `docs/plan-internal.md` (workspace bound to a Jira board; scope depends on board type) and the corresponding updates to `docs/spec.md` §0.1 and §0.3. Added: User Story 6 (Board-Type-Aware Ingest Scope, P1); FR-027–FR-033 (board binding + migration, board introspection, board-type-dependent poller scope, idle scrum no-op, scope-entry-as-trigger, sprint-switch full rescan, board-scope tests); SC-009; new Key Entities (Board, Sprint/active-sprint id) and Workspace board fields; four new edge cases; updated the Schema assumption to record the `workspaces` migration and added a Board scoping assumption. No existing requirement, story, success criterion, or scenario was renumbered or rewritten.
- **2026-07-11 — Initial draft.** Iteration-2 spec covering JiraModule, IngestModule reconciliation, PipelineModule trigger/completion, and tests; closes iteration-1 deviations F2 and F3.
