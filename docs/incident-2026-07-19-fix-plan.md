# Fix Plan: Mass `timed_out` Runs in BRIGADIR

**Source incident doc:** [`docs/incident-2026-07-19-fix-prompt.md`](./incident-2026-07-19-fix-prompt.md)  
**Scope:** Implement fixes for Problems 1–7 identified in the incident report.  
**Primary goals:** Stabilize the MCP callback channel, fail-fast on persistent MCP failures, fix `rate_limit` termination, restrict QA live-stack booting, persist stderr on timeout, add durable finalize, and reduce concurrency.

---

## Guiding principles

1. Each phase is self-contained and can be merged independently.
2. Every change is covered by a unit test.
3. Phase 0 runs (`useCallbackChannel = false`) must keep working unchanged.
4. Do not change the HTTP callback API contract without updating `packages/mcp-server`.
5. Link each phase back to the incident doc section it addresses.

---

## Phase map

| Phase | Priority | Problems addressed | Files touched | Validation |
|-------|----------|-------------------|---------------|------------|
| [Phase 1](#phase-1-stabilize-mcp-callback-channel--fail-fast-on-persistent-mcp-failure-p0) | P0 | 1, 2 | `packages/mcp-server/src/tools.ts`, `libs/executors/src/claude-cli/wrapper.ts`, `libs/callback/src/callback.service.ts`, `libs/executors/src/claude-cli/claude-cli-run.processor.ts` | Unit tests + 5-min outage simulation |
| [Phase 2](#phase-2-fix-terminate-on-rate_limit-p1) | P1 | 3 | `libs/executors/src/claude-cli/claude-cli.config.ts`, `libs/executors/src/claude-cli/process-group.ts`, `apps/worker/src/claude-cli-run.processor.ts` | Unit tests + rate-limit integration test |
| [Phase 3](#phase-3-restrict-qa-live-stack-booting--persist-stderr-on-timeout-p1) | P1 | 4, 5 | `libs/executors/src/claude-cli/wrapper.ts`, `libs/executors/src/claude-cli/claude-cli.executor.ts` | Unit tests |
| [Phase 4](#phase-4-durable-finalize--outbox-p2) | P2 | 6 | `packages/mcp-server/src/tools.ts`, `apps/worker/src/claude-cli-run.processor.ts` or reconcile processor | Unit tests + reconcile test |
| [Phase 5](#phase-5-reduce-concurrency--add-monitoring-p2) | P2 | 7 | `apps/worker/src/executor-concurrency.ts`, `apps/worker/src/executor-gate.ts` | Unit tests |

---

## Phase 1: Stabilize MCP callback channel & fail-fast on persistent MCP failure (P0)

Linked incident sections: [Problem 1](incident-2026-07-19-fix-prompt.md#problem-1-mcp-callback-channel-unreachable-7-runs), [Problem 2](incident-2026-07-19-fix-prompt.md#problem-2-agent-does-not-give-up-on-persistent-mcp-failure), [Fix Requirements P0](incident-2026-07-19-fix-prompt.md#p0-stabilize-the-mcp-callback-channel).

### 1.1 Strengthen retry logic in `packages/mcp-server/src/tools.ts`

**Changes:**
- Distinguish `network error` from HTTP 4xx/5xx retries.
- For `network error` and transient 5xx: exponential backoff with ceiling (e.g., `Math.min(2^attempt * 100ms, 30000ms)`), max total attempts ≈ 10 over ~5 minutes.
- For HTTP 4xx: do not retry; fail immediately.
- Add explicit `fetch` timeout (e.g., 10 seconds) and an `AbortController`.
- Reuse HTTP keep-alive agent where possible.
- Write diagnostic lines to `stderr`: `URL`, `attempt`, `error.name`, `error.message`, `status` (if any).

**Implementation options for retry policy:**

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| A (recommended) | Keep `maxRetries = 3` for HTTP errors, add a separate `maxNetworkErrorRetries = 10` with exponential backoff for `network error` only. | Minimal blast radius; directly targets the incident root cause. | Slightly more state to track. |
| B | Single configurable `maxRetries` with exponential backoff for all retryable errors. | Simpler mental model. | Retrying 5xx 10× may hide backend bugs and delay fail-fast. |
| C | Use a circuit-breaker: after 3 consecutive network errors, fail immediately and let the wrapper escalate to `request_human`. | Fastest fail-fast. | Needs coordination between MCP server and wrapper; harder to test. |

**Decision:** Implement **Option A** in this phase; the fail-fast rule in `wrapper.ts` (1.3) provides the circuit-breaker behavior.

### 1.2 Make `complete_task` return fast in `libs/callback/src/callback.service.ts`

**Changes:**
- In `POST /api/callbacks/runs/:runId/complete` handler, call `finalizeWithReport` synchronously to persist outcome/report.
- Return `200` immediately.
- Trigger `PipelineService.onRunFinished` asynchronously (fire-and-forget via existing queue/job or `Promise.resolve().then(...)` with its own error handling).
- Add a log line if the async Jira write fails so an operator can retry.

**Trade-offs:**
- Fire-and-forget is simplest and meets the <1-second success criterion, but Jira write failures become observable only via logs/queue DLQ.
- Background job adds durability but requires a new job handler; defer to Phase 4 if needed.

### 1.3 Add fail-fast rule in `libs/executors/src/claude-cli/wrapper.ts`

**Changes in `callbackToolsSection()`:**
- Add an instruction: "If any `mcp__brigadir__*` tool fails three times in a row with `network error` / `fetch failed`, immediately call `mcp__brigadir__request_human(blocking=true, title='MCP callback channel unreachable', ...)` and stop the session."
- Add a second instruction: "Do not use `ScheduleWakeup`, `Bash sleep`, or `until false` loops to wait for infrastructure recovery inside a run."

### 1.4 Fix callback URL default to avoid dual-stack ambiguity

**Changes in `libs/executors/src/claude-cli/claude-cli-run.processor.ts`:**
- Read `BRIGADIR_CALLBACK_BASE_URL` from env/options.
- Default to explicit `http://127.0.0.1:3000/api/callbacks` instead of `localhost`.
- If IPv6 is required, allow `http://[::1]:3000/api/callbacks` via env.

### 1.5 Tests for Phase 1

- `packages/mcp-server/src/tools.spec.ts` (new or existing):
  - Simulate `fetch` throwing `TypeError: fetch failed` 3× then succeeding — assert retry count and increasing backoff.
  - Simulate `fetch` throwing `TypeError: fetch failed` 11× — assert final error and diagnostic stderr output.
  - Simulate HTTP 400 — assert no retries.
  - Simulate 5-second `fetch` hang — assert timeout abort and retry.
- `libs/callback/src/callback.service.spec.ts`:
  - Mock slow `PipelineService.onRunFinished`; assert HTTP response returns in <1 second.
  - Assert `finalizeWithReport` is called synchronously and `onRunFinished` is called eventually.
- `libs/executors/src/claude-cli/wrapper.spec.ts`:
  - Assert the new fail-fast rule appears in `callbackToolsSection()` output.
  - Assert the sleep-loop prohibition appears.
- `libs/executors/src/claude-cli/claude-cli-run.processor.spec.ts`:
  - Assert default callback URL is `127.0.0.1:3000/api/callbacks` and `BRIGADIR_CALLBACK_BASE_URL` overrides it.

### 1.6 Validation

- Run unit tests for `mcp-server` and `callbacks`.
- Manual / integration: block `localhost:3000/api/callbacks` for 5 minutes, launch a run, verify it calls `request_human(blocking=true)` and exits instead of looping.

---

## Phase 2: Fix terminate on `rate_limit` (P1)

Linked incident section: [Problem 3](incident-2026-07-19-fix-prompt.md#problem-3-rate-limit--watchdog-1-run-captain-nemo).

### 2.1 Default and validate `killGraceMs`

**Changes in `libs/executors/src/claude-cli/claude-cli.config.ts`:**
- In `resolveClaudeCliConfig`, set `killGraceMs` default to `10_000` if missing.
- Validate that `killGraceMs` is a positive integer ≤ 60 seconds; throw a config error otherwise.

### 2.2 Ensure `terminate()` kills all descendants

**Changes in `libs/executors/src/claude-cli/process-group.ts`:**
- After SIGTERM + `killGraceMs`, if the group leader is still alive, send SIGKILL to the whole process group (`-pid`).
- Optionally, collect child PIDs via `pgrep -P <pid>` tree and SIGKILL them too.
- Add `stderr` logging for which signals were sent and which PIDs survived.

### 2.3 Respect `killGraceMs` on `rate_limited` exit

**Changes in `apps/worker/src/claude-cli-run.processor.ts`:
- When `exitStatus === 'rate_limited'`, enforce that the worker does not wait beyond `killGraceMs` for the run process to disappear.
- If still alive, log and force-cleanup the run record so the next scheduler tick can re-queue or park it correctly.

### 2.4 Tests for Phase 2

- `libs/executors/src/claude-cli/claude-cli.config.spec.ts`:
  - Assert default `killGraceMs = 10_000`.
  - Assert invalid values throw.
- `libs/executors/src/claude-cli/process-group.spec.ts`:
  - Spawn a stubborn grandchild that ignores SIGTERM; assert it receives SIGKILL after `killGraceMs`.
- `apps/worker/src/claude-cli-run.processor.spec.ts`:
  - Simulate `rate_limited` exit with a hanging process; assert run ends in `rate_limited` status within `killGraceMs + delta`.

### 2.5 Validation

- Run executor/worker unit tests.
- Integration: trigger a `rate_limit` via mock; verify run status becomes `rate_limited`, not `timed_out`.

---

## Phase 3: Restrict QA live-stack booting & persist stderr on timeout (P1)

Linked incident sections: [Problem 4](incident-2026-07-19-fix-prompt.md#problem-4-qa-agent-boots-a-full-dev-stack-inside-the-run), [Problem 5](incident-2026-07-19-fix-prompt.md#problem-5-stderr-is-lost-on-timed_out).

### 3.1 Restrict QA agent behavior

**Changes in `libs/executors/src/claude-cli/wrapper.ts`:**
- Add a QA/verification section:
  - "Do not boot a full dev stack (`docker compose up`, `npm ci`, long-running `npm run start:dev`) if it would take more than 5 minutes."
  - "Prefer unit/integration tests and static analysis."
  - "If live testing is critical, first verify services are already reachable; otherwise call `request_human(blocking=true)` and explain the missing environment."

### 3.2 Persist stderr on `timed_out`

**Changes in `libs/executors/src/claude-cli/claude-cli.executor.ts`:**
- In `handleClose`, when `abortReason === 'timeout'`:
  - Write `stderrTail.text` to `run_events(type='error')` or `runs.error`.
  - Limit stored text to 16 KB (last bytes), matching the success criterion.

### 3.3 Tests for Phase 3

- `libs/executors/src/claude-cli/wrapper.spec.ts`:
  - Assert QA restriction instructions are present in the wrapper output.
- `libs/executors/src/claude-cli/claude-cli.executor.spec.ts`:
  - Simulate a timeout close event with `stderrTail.text = '...'`, assert the persisted error record contains the tail (truncated to 16 KB).

### 3.4 Validation

- Run executor unit tests.
- Manual: force a run to timeout, verify the last stderr appears in the database.

---

## Phase 4: Durable finalize / outbox (P2)

Linked incident section: [Problem 6](incident-2026-07-19-fix-prompt.md#problem-6-no-durable-finalize--outbox).

### 4.1 Write local outbox on `complete_task`

**Changes in `packages/mcp-server/src/tools.ts`:**
- On `complete_task`, after forming the result, write it to a file next to `BRIGADIR_MARKER_PATH` (e.g., `<marker-dir>/.brigadir-outbox/<runId>.json`).
- Include `runId`, `outcome`, `report`, `timestamp`, and a signed/verified checksum or simple JSON signature if the file is security-sensitive.

### 4.2 Reconcile timed_out runs against outbox

**Changes:**
- In `apps/worker/src/claude-cli-run.processor.ts` or a dedicated reconcile processor, when a run is found in `timed_out`:
  - Check for the outbox file.
  - If present and valid, call `finalizeWithReport` using the outbox content instead of leaving `outcome = NULL`.
  - Mark the outbox as consumed (move/delete).

### 4.3 Tests for Phase 4

- `packages/mcp-server/src/tools.spec.ts`:
  - Assert `complete_task` writes an outbox file with correct fields.
- `apps/worker/src/claude-cli-run.processor.spec.ts` (or reconcile spec):
  - Create a fake `timed_out` run and a valid outbox file; assert reconciliation sets the run outcome.
  - Create a fake `timed_out` run with no outbox; assert it stays `timed_out` with `outcome = NULL`.

### 4.4 Validation

- Run unit tests.
- Integration: simulate callback failure after agent already wrote `complete_task`; verify the run is finalized from the outbox.

---

## Phase 5: Reduce concurrency & add monitoring (P2)

Linked incident section: [Problem 7](incident-2026-07-19-fix-prompt.md#problem-7-high-concurrency-overloads-the-host).

### 5.1 Lower default concurrency

**Changes in `apps/worker/src/executor-concurrency.ts` / `executor-gate.ts`:**
- Reduce default `max_parallel_runs` for `claude_cli` profile from 22 to a safe local value (start with 4–6).
- Add a per-model limit for `claude-opus-4-8` (e.g., max 2 concurrent).
- Expose both values via config/env so operators can tune without redeploying.

### 5.2 Add basic overload guard

**Changes:**
- Log a warning when the gate admits a run and current concurrency is ≥ 75% of limit.
- Optionally emit a metric event.

### 5.3 Tests for Phase 5

- `apps/worker/src/executor-concurrency.spec.ts`:
  - Assert default `max_parallel_runs` is 4–6.
  - Assert `claude-opus-4-8` limit is 2.
- `apps/worker/src/executor-gate.spec.ts`:
  - Assert the gate blocks the N+1th concurrent run.
  - Assert warning is logged at 75% threshold.

### 5.4 Validation

- Run worker unit tests.
- Verify ten runs cannot all start at once.

---

## Cross-phase concerns

- **Dependency direction:** Phase 1 has no dependencies. Phases 2–5 can be done in parallel after Phase 1 merges, except Phase 4 depends on Phase 1’s outbox location convention.
- **Database migrations:** None required for the described changes; all new persistence is file-based or uses existing `run_events`/`runs.error` columns.
- **Observability:** Add structured `stderr` logs in every changed file; avoid `console.log` if the project uses a logger.
- **Backwards compatibility:** Phase 0 runs must not use the MCP channel; verify via existing Phase-0 tests after each phase.

---

## Definition of done for the whole fix

1. All six [success criteria](incident-2026-07-19-fix-prompt.md#success-criteria) from the incident doc are met.
2. Each phase has passing unit tests.
3. A single integration run demonstrates: 5-minute callback outage → `request_human`; slow Jira → `200` in <1s; `rate_limit` → `rate_limited` status; timeout → stderr persisted.
4. The incident doc is updated with a "Resolution" section referencing this plan file and the merged PRs.

---

## Resolution

- **Phase 1 (P0, Problems 1–2)** — merged in commit `8c12942` (MCP callback retry
  hardening, async `complete_task` finalize, fail-fast wrapper rule, explicit
  `127.0.0.1` callback default). The separate kimi-429 TTL sub-fix (`sanitizeRateLimitTtl`)
  landed in `035ada8`.
- **Phase 2 (P1, Problem 3 — `rate_limit` → `timed_out`)** — implemented on branch
  `claude/incident-2026-07-19-phase-2-dc94f1` (PR #39, commit `13c289f`); see
  `docs/progress.md` "Iteration 34". Root cause was a branch-precedence bug in `handleClose`
  (**not** in the original Phase 2 scope): `abortReason` was evaluated before `rateLimited`,
  so a rate-limit that outlived a wedged `terminate()` was reclassified as `timed_out` once
  the watchdog fired. Fixed by reordering to `cancelled > rate_limited > timeout`, hardening
  `terminate()` to reap `setsid()`-escaped descendants (recursive `pgrep -P` snapshot →
  per-pid SIGKILL) so the worker slot frees promptly, and clamping `killGraceMs` to
  `[1000, 60000]` (default 10s). The processor's `rate_limit_ttl_ms` override was
  intentionally left un-sanitized (a trusted, exact-by-construction operator/test input).
  Gates green (`pnpm typecheck && lint && test`, unit 406); acceptance test = executor
  incident reproduction (rate_limit event + late timeout abort ⇒ `rate_limited`), satisfying
  Success Criterion #3.
- **Phase 3 (P1, Problems 4–5 — QA live-stack + stderr-on-timeout)** — this branch; see
  `docs/progress.md` "Iteration 35". Problem 4: new `## Verification and QA` section in
  `wrapper.ts` (`verificationSection()`), callback-channel only — restricts full dev-stack
  boots (`docker compose up`, `npm ci`, long-running `start:dev`), prefers unit/integration
  tests + static analysis, and escalates via `request_human(blocking=true)` when a live env
  is genuinely needed but not already reachable. Problem 5: builds on Phase 2's reordered
  `handleClose` — the `abortReason === 'timeout'` branch persists the last ≤16 KB of
  `stderrTail.text` as a `run_events(type='error')` row via the existing `persistRunEvent`
  (Success Criteria #4/#5); `cancelled`/`rate_limited` (handled above) stay silent. Unit
  tests in `wrapper.spec.ts` + `claude-cli.executor.spec.ts`. No callback HTTP-contract
  change, no DB migration, no new external deps.
- **Phase 4 (P2, Problem 6 — durable finalize / outbox)** — this branch; see
  `docs/progress.md` "Iteration 36". The tool server now persists every `complete_task`
  report to a local outbox file (`<marker-dir>/.brigadir-outbox/<runId>.json`) BEFORE the
  HTTP callback and removes it on a 2xx (new `packages/mcp-server/src/outbox.ts`, wired into
  `tools.ts`), so a callback that never reaches the backend (the incident's `fetch failed`)
  no longer loses the outcome. The worker reconciles it in
  `apps/worker/src/claude-cli-run.processor.ts`: in the callback-wired `finalize` branch,
  before writing `timed_out` (run still `running`), it reads the outbox
  (`libs/executors/src/claude-cli/outbox.ts` → `readOutboxReport`) and, if a report exists,
  finalizes via the normal `RunsService.finalizeWithReport` — same validation / `run_checks`
  / `human_tasks` path as a live callback — then consumes the file (Success Criterion #6).
  Scoped to `timed_out` only (`cancelled`/`rate_limited` are intentional stops and must not
  be clobbered); a malformed report or a lost race falls through to the unchanged `timed_out`
  path. The `libs/ingest` watchdog (worker-death safety net) is a documented non-goal for this
  phase. Unit tests: `packages/mcp-server/src/tools.spec.ts` (outbox written on network
  failure, dropped on 2xx, write failure never breaks completion) + new
  `libs/executors/src/claude-cli/outbox.spec.ts`; the processor wiring is integration-covered.
  Gates green (`pnpm typecheck && lint && test`, unit 416). No callback HTTP-contract change,
  no DB migration, no new external deps.
- **Phase 5 (P2, Problem 7 — concurrency reduction + monitoring)** — this branch; see
  `docs/progress.md` "Iteration 37". The per-profile default (2) is already low, so the
  actionable levers are a ceiling, a per-model cap, and an overload signal — not lowering a
  hardcoded default. **G1**: `applyExecutorConcurrency` (`apps/worker/src/executor-concurrency.ts`)
  now clamps the summed type capacity to an optional operator ceiling —
  `EXECUTOR_MAX_TYPE_CONCURRENCY_<TYPE>` (uppercased) over the generic
  `EXECUTOR_MAX_TYPE_CONCURRENCY`, read lazily, integer ≥ 1 or ignored; unset ⇒ pure sum; the
  quiet-no-op-on-unchanged contract is preserved and the clamp is logged only when it bites.
  **G2** (the real protection): a per-model cap in the gate
  (`apps/worker/src/executor-gate.ts`) — `EXECUTOR_MODEL_LIMITS` (JSON map model → positive
  integer, lazy `parseModelLimits`) caps `running` runs across all profiles sharing
  `config->>'model'` (any type); over the cap ⇒ held via the same rate-limit path with a new
  `model_at_capacity` verdict (no attempt burned). The decision core is the pure `decideGate`
  (unit-tested without Docker); ordering is `disabled` → profile → model, and the model query
  runs only when the model actually has a cap. **G3**: on admit at ≥75% post-admit occupancy
  of the tightest applicable limit the gate returns a `nearCapacity` hint and the processor
  emits an operator `warn`. `claude-cli-run.processor.ts` threads `model_at_capacity` through
  the existing hold branch and logs the overload warn; `KimiRunProcessor` inherits it; the mock
  processor and Phase-0 are untouched (the gate's model tier short-circuits for uncapped
  models). Unit tests: new `apps/worker/src/executor-gate.spec.ts` (17) + extended
  `executor-concurrency.spec.ts` (+10); integration: `test/integration/executor-gate.spec.ts`
  (+1, per-model cap). Gates green (`pnpm typecheck && lint && test`, unit 443; `pnpm
  test:integration executor-gate` 3/3). No schema migration, no callback HTTP-contract change,
  no new external deps; new env vars are all optional (unset = pre-Phase-5 behavior),
  documented in `.env.example`. **The incident is fully resolved (Problems 1–7).**
