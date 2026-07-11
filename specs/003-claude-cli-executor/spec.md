# Feature Specification: claude_cli Executor

**Feature Branch**: `003-claude-cli-executor`

**Created**: 2026-07-11

**Status**: Draft

**Input**: User description: "Feature 003: claude_cli executor — the first real agent executor replacing mock for actual coding runs."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run a real coding agent on a ticket (Priority: P1)

A ticket reaches an agent's trigger status. Instead of the mock producing a canned report, the system launches a real Claude coding agent that works on an isolated copy of the workspace repository, does the coding task described in the ticket, and returns a final structured report. The system finalizes the run from that report exactly as it already does for the mock: outcome recorded, Jira transitioned, worktree cleaned up.

**Why this priority**: This is the entire point of the feature — it turns BRIGADIR from a pipeline demo into a tool that does real work. Nothing else in this iteration has value without it.

**Independent Test**: Configure an agent with the `claude_cli` executor whose spawned binary is a fake CLI script that emits a recorded, schema-valid event stream and final report. Trigger a run on a test ticket and confirm the run finalizes with the expected outcome, the report is persisted, and the working directory was an isolated git worktree on the expected branch that no longer exists after the run.

**Acceptance Scenarios**:

1. **Given** an agent configured with `claude_cli` and a ticket at its trigger status, **When** the run starts, **Then** the agent process is launched with the wrapped instruction and its working directory is a dedicated git worktree of the configured workspace repository on a branch named from the agent's branch prefix and the ticket key.
2. **Given** the agent process emits a final output that validates against `ReportSchema`, **When** the process exits, **Then** the run is finalized with the report's outcome, the report is persisted to the run, and the worktree is removed.
3. **Given** the agent process emits a final output that does NOT validate against `ReportSchema` (missing/invalid fields), **When** the process exits, **Then** the run is finalized as failed with a diagnostic explaining the validation failure, and no report outcome is guessed or fabricated.
4. **Given** the agent process exits without ever producing a final report, **When** finalization runs, **Then** the run is recorded as failed with a diagnostic.

---

### User Story 2 - Protect the operator's subscription auth (Priority: P1)

The real agent runs on the operator's Claude subscription via the official CLI. A stray `ANTHROPIC_API_KEY` in the host environment would silently switch the agent onto pay-per-use API billing, and any host secret leaking into the child environment or command line would be exposed. The system must guarantee the child process only ever sees an explicit, minimal set of environment variables and that no secret is ever passed on the command line.

**Why this priority**: This is a CRITICAL correctness-and-cost guarantee called out in the ToS matrix and the constitution (Secret Isolation). Getting it wrong means either silent surprise billing or leaked credentials, and it is cheapest to build in from the first real run.

**Independent Test**: With a canary `ANTHROPIC_API_KEY` and other known secret variables present in the worker's own environment, start a run and assert that none of them appear in the spawned process's environment or in its command-line arguments; only the allowlisted variables are present.

**Acceptance Scenarios**:

1. **Given** the worker environment contains `ANTHROPIC_API_KEY` and other secret variables, **When** the agent process is spawned, **Then** those variables are absent from the child environment and only an explicit allowlist (plus variables the agent config declares) is passed through.
2. **Given** any credential or token needed by the run, **When** the process is spawned, **Then** that value never appears in the process's command-line arguments (i.e. it is not visible via a process listing).

---

### User Story 3 - Enforce time, cancellation, and budget limits (Priority: P2)

A run must never outlive its configured timeout, must stop promptly when an operator cancels it, and must not exceed its cost ceiling. Because the agent spawns child processes of its own, stopping it means stopping the entire process tree, not just the top process.

**Why this priority**: Real agents consume real money and real time and can hang; without hard limits a single stuck run could burn the whole budget or occupy a worker indefinitely. Needed as soon as real runs exist, but only after the core run works.

**Independent Test**: Using a fake CLI that sleeps and spawns a child, verify that on timeout and on cancellation the whole process group is terminated (no orphaned children survive) and the run is finalized with the corresponding status. Using a fake CLI that reports escalating cost, verify the run is killed and failed once reported cost crosses the ceiling.

**Acceptance Scenarios**:

1. **Given** a run whose timeout elapses, **When** the timeout fires, **Then** the entire process group is terminated and the run is finalized as timed out.
2. **Given** a run an operator cancels, **When** the cancellation is observed, **Then** the entire process group is terminated and the run is finalized as cancelled; a report arriving after cancellation does not revive it.
3. **Given** a run whose reported cumulative cost crosses the configured budget ceiling, **When** that threshold is crossed, **Then** the process group is terminated and the run is finalized as failed with a budget-exceeded diagnostic.
4. **Given** any of the above terminations, **When** finalization completes, **Then** the run's worktree is cleaned up (subject to the keep-failed-worktrees configuration).

---

### User Story 4 - Live progress and cost visibility (Priority: P2)

While the agent works, the system parses its event stream incrementally and records meaningful events (tool use, text snippets, retry notices) so the run's timeline is populated for later UI viewing, and it captures the run's usage and cost data onto the run record.

**Why this priority**: Visibility is what lets a human trust and supervise autonomous runs, and cost capture feeds budgeting and reporting. It rides on the same event stream the core run already consumes, so it is valuable but secondary to the run completing correctly.

**Independent Test**: Feed a recorded event stream through a run and assert that the expected timeline events are persisted and that final usage and cost values are stored on the run.

**Acceptance Scenarios**:

1. **Given** the agent emits tool-use and text events, **When** the stream is parsed, **Then** meaningful events are persisted to the run timeline in order.
2. **Given** the agent emits final usage and cost figures, **When** the run finalizes, **Then** those figures are stored on the run record.
3. **Given** the agent emits diagnostic output on its error channel, **When** the run finalizes, **Then** a bounded tail of that output is retained for troubleshooting.

---

### User Story 5 - Tolerate subscription rate limits without burning an attempt (Priority: P3)

Subscription plans have usage windows. When the CLI signals that the run hit a subscription rate limit, the system must treat this as "try again later," not as an agent failure — the run must not consume one of its limited retry attempts.

**Why this priority**: Without this, hitting a usage window would permanently fail runs that would have succeeded minutes later, wasting attempts and confusing operators. Important for reliability but only matters once real runs are hitting real limits.

**Independent Test**: Using a fake CLI that emits a rate-limit signal, verify the run surfaces a distinct rate-limited outcome, the run stays eligible to run again later, and its attempt counter is not spent.

**Acceptance Scenarios**:

1. **Given** the CLI reports a subscription rate limit, **When** the run ends, **Then** the outcome is a distinct rate-limited signal rather than a generic failure.
2. **Given** a rate-limited outcome, **When** the system reschedules, **Then** the run is retried later without counting the occurrence as a spent attempt or a failure.

---

### User Story 6 - Configure claude_cli while mock keeps working (Priority: P3)

An operator can declare a `claude_cli` executor in the agents configuration — choosing the model, deriving allowed tools from the agent behavior, and pointing at a repository from the workspace's repository list. Adding this does not disturb the mock executor: every existing pipeline test continues to pass against mock.

**Why this priority**: Configuration is the seam that lets the feature be used at all, but it is only meaningful once the executor behind it works; the coexistence guarantee protects the existing test suite.

**Independent Test**: Add a `claude_cli` executor to the configuration alongside the existing mock executor and confirm the configuration validates, the executor is resolvable by type, and the full existing mock-based integration suite still passes unchanged.

**Acceptance Scenarios**:

1. **Given** a configuration declaring a `claude_cli` executor with a model, behavior-derived allowed tools, and a repository from the workspace list, **When** the system boots, **Then** the configuration validates and the executor is registered and resolvable by its type.
2. **Given** both mock and `claude_cli` executors are configured, **When** the existing pipeline/integration tests run, **Then** they all pass against the mock executor with no behavioral change.

---

### Edge Cases

- The agent process crashes (non-zero exit) without a rate-limit signal and without a valid report → recorded as failed with diagnostics; eligible for normal backoff retry within the agent's attempt budget.
- The workspace repository cannot be prepared (fetch fails, branch already exists from a prior crashed run, disk full) → the run fails with a clear diagnostic rather than running the agent against a wrong or missing tree.
- The event stream contains malformed or partial lines → parsing is resilient: a bad line does not abort the whole run; the run still reaches finalization.
- The process crosses both the budget ceiling and the timeout near-simultaneously → the run is finalized exactly once with a single, deterministic status.
- A cancelled or timed-out run leaves child processes → no orphaned processes remain after termination.
- A late report arrives after the run was already finalized (cancelled/timed out/failed) → it is ignored; the finalized status stands.
- The real CLI or subscription is unavailable in an automated test environment → tests never require them; they exercise a substitutable fake CLI, and the real path is covered only by the manual live-smoke gate.

## Requirements *(mandatory)*

### Functional Requirements

**Process lifecycle & workspace**

- **FR-001**: The system MUST provide a `claude_cli` executor that implements the existing `AgentExecutor` contract without modifying that contract, and that runs a single headless Claude CLI process for the full lifecycle of one run.
- **FR-002**: The executor MUST run the agent inside a dedicated git worktree of the configured workspace repository, on a branch named from the agent's branch prefix and the ticket key.
- **FR-003**: The executor MUST pass the wrapped instruction to the agent using the single hardcoded instruction-wrapper template from architecture §7 (Phase-0 form), with no additional wrapper logic.
- **FR-004**: On timeout or cancellation the executor MUST terminate the entire process group (parent and all descendants), not only the direct child, allowing a short grace period before a forceful kill.
- **FR-005**: The executor MUST clean up the run's worktree after the run finishes, subject to the configured option to retain worktrees of failed runs for debugging.
- **FR-006**: The executor MUST map process outcomes to run statuses consistently with the mapping already defined in architecture §4 (completed→by-report, crashed→failed, timeout→timed out, rate_limited→retry-without-burning-attempt, cancelled→cancelled).

**Report channel**

- **FR-007**: The executor MUST obtain the final agent report from the process output and validate it against the versioned `ReportSchema`; a run is finalized from a valid report only.
- **FR-008**: If the final output is missing or fails `ReportSchema` validation, the run MUST be finalized as failed with a diagnostic; the system MUST NOT guess, synthesize, or partially accept a report.
- **FR-009**: The finalized report and the derived outcome MUST flow through the same finalization path the mock executor already uses, so downstream behavior (persistence, checks, Jira transition) is unchanged.

**Streaming, events & cost**

- **FR-010**: The executor MUST parse the CLI event stream incrementally as the process runs (not only after it exits).
- **FR-011**: The executor MUST persist meaningful stream events (at least tool use, text snippets, initialization, and retry notices) to the run timeline in order, sampled as needed to stay bounded.
- **FR-012**: The executor MUST capture the run's usage and cost data onto the run record.
- **FR-013**: The executor MUST retain a bounded tail of the process's diagnostic (error-channel) output on the run for troubleshooting.
- **FR-014**: Stream parsing MUST be resilient to malformed or partial lines: a single bad line MUST NOT abort the run.

**Budget enforcement**

- **FR-015**: When the reported cumulative cost crosses the configured budget ceiling, the executor MUST terminate the process group and finalize the run as failed with a budget-exceeded diagnostic.

**Environment sanitization (security)**

- **FR-016**: The child process environment MUST be an explicit allowlist; the parent/worker environment MUST NOT be passed through wholesale.
- **FR-017**: `ANTHROPIC_API_KEY` and other known host secret variables MUST be absent from the child environment so the agent runs on subscription auth via the official CLI.
- **FR-018**: No secret (token, key, credential) may appear in the process's command-line arguments.
- **FR-019**: The feature MUST include an automated test asserting that `ANTHROPIC_API_KEY` and known secret variables are absent from the spawned environment.

**Rate-limit / capacity handling**

- **FR-020**: When the CLI signals a subscription rate limit, the executor MUST surface a distinct rate-limited outcome separate from generic failure.
- **FR-021**: A rate-limited outcome MUST NOT consume one of the run's limited retry attempts; the run MUST remain eligible to be retried later.

**Configuration & coexistence**

- **FR-022**: The configuration MUST support a `claude_cli` executor type carrying at least a model, allowed tools derived from agent behavior, and a working repository selected from the workspace's repository list.
- **FR-023**: Invalid `claude_cli` configuration MUST fail validation at boot with a clear, path-qualified error rather than starting in a broken state.
- **FR-024**: The mock executor MUST remain fully functional and all existing pipeline/integration tests MUST continue to pass unchanged.

**Testability**

- **FR-025**: The spawned binary MUST be substitutable in tests so integration tests can drive a fake CLI emitting recorded event streams, without requiring the real Claude CLI or a subscription.
- **FR-026**: The real CLI path MUST be covered by a manual live-smoke Definition-of-Done gate (analogous to iteration 2's live-smoke helper), not by the automated test suite.

### Key Entities *(include if feature involves data)*

- **Run**: An in-progress or finished agent execution against one ticket. Gains, in this feature, real values for status, outcome, cost/usage, worktree path, external reference, diagnostics, and the validated report. (Existing entity; no schema change expected.)
- **Run Event**: A timeline entry for a run. Populated from the parsed CLI stream (tool use, text, init, retry, log). (Existing entity.)
- **Report**: The `ReportSchema`-valid structured result the agent produces; the sole basis for finalizing a completed run. (Existing contract.)
- **Executor Configuration**: The `claude_cli` declaration in the agents configuration — model, behavior-derived allowed tools, workspace repository. (Existing config surface, extended with the new type.)
- **Worktree**: The isolated git working directory for one run, created from the workspace repository on a per-run branch and cleaned up afterward.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The manual live-smoke gate completes at least one real coding run end-to-end on the operator's own subscription within about 15 minutes, ending with a schema-valid report and the ticket transitioned accordingly.
- **SC-002**: 100% of the existing pipeline/integration tests pass unchanged with the `claude_cli` executor added to the codebase (mock coexistence).
- **SC-003**: An automated test confirms that a canary `ANTHROPIC_API_KEY` and known secret variables present in the worker environment are 0% present in the spawned agent environment and its arguments.
- **SC-004**: In automated tests exercising timeout, cancellation, and budget-exceeded terminations, no orphaned child processes remain after the run is finalized (0 survivors in each case).
- **SC-005**: A final output that fails report validation results in a failed run with a diagnostic in 100% of cases, with 0 fabricated report outcomes.
- **SC-006**: A run that hits a subscription rate limit is retried later without spending an attempt, in 100% of simulated rate-limit cases.
- **SC-007**: The entire automated test suite for this feature runs with 0 dependency on the real Claude CLI or a subscription.

## Assumptions

- **Simplified Phase-0 instruction wrapper**: This iteration uses the single hardcoded wrapper template from architecture §7 with the MCP-tools section omitted (MCP callback tools arrive in iteration 5). The report is obtained from process output rather than a callback; escalation is expressed via the report's `needs_human` outcome.
- **Report delivery mechanism is a planning detail**: Exactly how the schema-valid report is extracted from the stream (e.g. a structured-output flag on the streaming format vs. a fallback output format) is deferred to `/speckit-plan` and the first prototype, per the open question noted in spec §0.5. The spec only requires that a schema-valid report be obtained or the run fails.
- **Single repository / single real executor scope**: Only the `claude_cli` executor is implemented in this iteration; `anthropic_api`, `deepseek_api`, and `claude_routines` remain unimplemented behind the existing interface. The working repository is taken from the workspace repository list (default when unspecified).
- **Outcome-to-status mapping is fixed**: The `ExecutorResult.exitStatus` → run-status mapping and the rate-limit rescheduling behavior already defined in architecture §4 are reused as-is, not redesigned here.
- **Out of scope** (explicitly deferred): MCP callback server and per-run JWT (iteration 5); sandboxing/containers (we are at the "trusted team" security rung — bare process + git worktree + env sanitization); `anthropic_api` and `deepseek_api` executors; session resume/`--resume` (iteration 8+); any instruction-wrapper generality beyond the single §7 template.
- **Security rung**: Per architecture §8, isolation for this iteration is a bare process plus git worktree plus environment sanitization; no container or gVisor isolation is expected.
- **Keep-failed-worktrees**: A configuration option governs whether failed runs' worktrees are retained for debugging; default behavior mirrors the existing spec §0.5 note.
