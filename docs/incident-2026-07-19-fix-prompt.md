# Technical Prompt: Fix Mass timed_out Runs in BRIGADIR

## Incident Context

On 2026-07-19 between 16:35 and 18:40, eight runs were launched in workspace `7456a02b-080e-4da7-98ca-bbac50c44f20` (ST3 project). All eight finished with status `timed_out`.

Run IDs:
- `db8eb160-bdaa-4b99-b14c-f31229d00cba` (ST3-872, Brigadir / Teamlead)
- `9e13419a-7de1-4c12-8b3f-6a1b33800135` (ST3-872, Cyrus Smith / QA)
- `706b69e0-c1b9-4290-aae0-7c9592174172` (ST3-874, Brigadir / Teamlead)
- `52505174-5f3e-4281-b546-0eeeb3f66809` (ST3-873, Brigadir / Teamlead)
- `c36d06b0-ba16-4b8b-8d57-7b94bb4e5243` (ST3-885, Brigadir / Teamlead)
- `30ededc2-677e-4a3b-9244-17b51195b218` (ST3-783, Brigadir / Teamlead)
- `db9e9e99-22f4-4542-9eb0-b53996e78d3a` (ST3-879, Brigadir / Teamlead)
- `644440da-e1c2-4dc5-9456-ee0303e1248c` (ST3-879, Captain Nemo / Developer)

At peak, ten runs were executing concurrently. All eight have `outcome = NULL` in the database — no `complete_task` callback ever finalized the run.

## Diagnostics (already completed)

### Problem 1. MCP callback channel unreachable (7 runs)

In all runs except Captain Nemo, every call to `mcp__brigadir__*` (`complete_task`, `report_progress`, `get_ticket`, `request_human`, `get_project_overview`) returned:

```
network error: TypeError: fetch failed
```

Agents entered a retry loop using `Bash sleep` and `ScheduleWakeup` and exhausted the 45-minute run timeout.

Technical path:
- `packages/mcp-server/src/tools.ts` — `postWithRetry`/`getWithRetry`, `maxRetries = 3`, backoff `100→200→400` ms. This is insufficient for multi-minute backend outages.
- `packages/mcp-server/src/main.ts` — stdio MCP server reads callback URL from `BRIGADIR_CALLBACK_URL`.
- `libs/executors/src/claude-cli/claude-cli-run.processor.ts` — `DEFAULT_CALLBACK_BASE_URL = 'http://localhost:3000/api/callbacks'`.
- `libs/callback/src/callback.controller.ts` + `libs/callback/src/callback.service.ts` — `POST /api/callbacks/runs/:runId/complete` synchronously calls `PipelineService.onRunFinished`, which performs Jira API calls (`transitionTo`, `addComment`). This can block the response.
- Backend listens on `localhost:3000` (dual-stack), creating IPv4/IPv6 mismatch risk.

### Problem 2. Agent does not give up on persistent MCP failure

`libs/executors/src/claude-cli/wrapper.ts` contains no instruction such as: "if any `mcp__brigadir__*` tool fails with network error more than N times — call `request_human(blocking=true)` and exit". Agents retry `complete_task` indefinitely.

### Problem 3. Rate-limit + watchdog (1 run, Captain Nemo)

`claude-opus-4-8` hit `api_retry: rate_limit` immediately (`retry_delay_ms ~500–600`). The executor called `terminate()`, but the run lived for another ~50 minutes until the watchdog timeout.

Technical path:
- `libs/executors/src/claude-cli/claude-cli.executor.ts` — `case 'rate_limit'` calls `group.terminate(runtimeConfig.killGraceMs)`.
- `libs/executors/src/claude-cli/process-group.ts` — `terminate()` sends SIGTERM, waits `killGraceMs`, then sends SIGKILL to the process group.
- `libs/executors/src/claude-cli/claude-cli.config.ts` — `killGraceMs` is read from executor config; it may be unset or too large.
- `apps/worker/src/claude-cli-run.processor.ts` — `sanitizeRateLimitTtl` already clamps retry TTL to 60 seconds, but terminate inside the run does not work.

### Problem 4. QA agent boots a full dev stack inside the run

`Cyrus Smith` (ST3-872) ran `docker compose`, `npm ci`, `npm run mru`, `nohup npm run start:dev`, and live JSON-RPC calls. This consumed a large portion of the 45-minute budget. The wrapper/agent instruction does not restrict this behavior.

### Problem 5. Stderr is lost on timed_out

`libs/executors/src/claude-cli/claude-cli.executor.ts` in `handleClose` when `abortReason === 'timeout'` does not persist `stderrTail.text`. We cannot see what the MCP server and claude-code wrote.

### Problem 6. No durable finalize / outbox

If the callback did not arrive but the agent already formed a `complete_task` with `outcome`/`report`, the system does not rescue that data. The run finalizes as `timed_out` with `outcome = NULL`.

### Problem 7. High concurrency overloads the host

`max_parallel_runs` for the `claude_cli` profile sums to capacity 22, but ten concurrent runs on a single machine already caused problems.

## Fix Requirements (by priority)

### P0. Stabilize the MCP callback channel

1. In `packages/mcp-server/src/tools.ts`:
   - Increase `maxRetries` for `network error` and implement exponential backoff with a sensible ceiling (e.g., up to 30 seconds) to survive multi-minute backend outages.
   - Add explicit `fetch` timeout and HTTP keep-alive.
   - Write diagnostics to stderr: URL, status, error, attempt.
2. In `libs/callback/src/callback.service.ts`:
   - Move `PipelineService.onRunFinished` (Jira writes) out of the synchronous `complete_task` response. Return `200` immediately after `finalizeWithReport`, and perform Jira operations asynchronously (fire-and-forget or background job).
3. In `libs/executors/src/claude-cli/claude-cli-run.processor.ts`:
   - Add an option/env `BRIGADIR_CALLBACK_BASE_URL` and default the backend to explicit `127.0.0.1:3000` / `[::1]:3000` instead of `localhost` to avoid dual-stack ambiguity.

### P0. Fail-fast agent behavior on persistent MCP failure

1. In `libs/executors/src/claude-cli/wrapper.ts`, in `callbackToolsSection()`, add a rule:
   - If any `mcp__brigadir__*` tool fails three times in a row with network error — immediately call `mcp__brigadir__request_human(blocking=true)` with title "MCP callback channel unreachable" and end the session.
   - Forbid using `ScheduleWakeup`, `Bash sleep` loops, or `until false` as a "wait for infrastructure recovery" tactic inside a run.

### P1. Fix terminate on rate_limit

1. In `libs/executors/src/claude-cli/claude-cli.config.ts` / `resolveClaudeCliConfig`:
   - Set a reasonable default `killGraceMs` (e.g., 10–15 seconds) and validate that it is configured.
2. In `libs/executors/src/claude-cli/process-group.ts`:
   - Ensure `terminate()` actually kills all descendants, including spawned processes (docker, npm, git). If necessary, use `pkill` by process name / tree.
3. In `apps/worker/src/claude-cli-run.processor.ts`:
   - When `exitStatus === 'rate_limited'`, do not wait for graceful terminate longer than `killGraceMs`.

### P1. Restrict live-stack booting for QA agents

1. In `libs/executors/src/claude-cli/wrapper.ts`, add an instruction for QA/verification runs:
   - Do not boot a full dev stack (`docker compose`, `npm ci`, long-running API) if it takes more than 5 minutes.
   - Use unit/integration tests and static analysis.
   - If live testing is critical — first check that services are already running; otherwise fail the run with `needs_human`.

### P1. Persist stderr on timed_out

1. In `libs/executors/src/claude-cli/claude-cli.executor.ts` in `handleClose` when `abortReason === 'timeout'`:
   - Write `stderrTail.text` to `run_events(type='error')` or `runs.error`.

### P2. Durable finalize / outbox

1. In `packages/mcp-server/src/tools.ts`:
   - On `complete_task`, write the result to disk next to `BRIGADIR_MARKER_PATH` as a local outbox.
2. In `apps/worker/src/claude-cli-run.processor.ts` or the reconcile processor:
   - When a run is found in `timed_out`, check the outbox marker and, if a valid report exists, finalize the run from it instead of `timed_out`.

### P2. Reduce concurrency / add monitoring

1. In `apps/worker/src/executor-concurrency.ts` / `apps/worker/src/executor-gate.ts`:
   - Lower the default `max_parallel_runs` to a safe value for local execution (e.g., 4–6).
   - Add a per-model concurrency limit for expensive/rare models such as `claude-opus-4-8`.

## Constraints

- Do not change the callback API contracts (`contracts/callback-http-api.md`) without updating `packages/mcp-server`.
- Do not break Phase-0 runs (`useCallbackChannel = false`) — they must continue to work as before.
- Do not add new external dependencies without approval.
- All changes must be covered by existing or new unit tests (`*.spec.ts`).

## Success Criteria

1. When `localhost:3000/api/callbacks` is simulated to be unavailable for 5 minutes, the agent does not enter an infinite sleep loop; after 3 failures it calls `request_human(blocking=true)` and exits.
2. `complete_task` returns `200` in under 1 second even when the Jira API is slow.
3. On `rate_limit`, the run ends in status `rate_limited` (parked), not `timed_out`.
4. A `timed_out` run persists the last 16 KB of stderr.
5. The QA agent does not run `docker compose up` inside a run unless the stack is already up.
6. Unit tests for `libs/executors` and `packages/mcp-server` pass.

## Task

Develop a detailed implementation plan: which files to change, in what order, which tests to write, and how to validate. Propose 2–3 implementation options for the P0 fixes with trade-offs. Use plan mode if architectural alignment is required.
