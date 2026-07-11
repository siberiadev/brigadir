---
description: "Task list for claude_cli Executor — the first real AgentExecutor"
---

# Tasks: claude_cli Executor

**Input**: Design documents from `/specs/003-claude-cli-executor/`
**Prerequisites**: plan.md, spec.md, research.md (D1–D15), data-model.md, contracts/executor-config.md, contracts/cli-io.md, quickstart.md

**Organization**: Phases follow plan.md's **Phase Breakdown** (Phase 2 — Tasks, the six-item expected grouping) almost exactly, with the fake-CLI harness pulled to the very front as its own Setup phase because every integration test in every later phase depends on it. Story labels map to spec.md user stories: **US1** run a real coding agent on a ticket (P1, MVP), **US2** protect the operator's subscription auth (P1), **US3** enforce time/cancellation/budget limits (P2), **US4** live progress and cost visibility (P2), **US5** tolerate rate limits without burning an attempt (P3), **US6** configure `claude_cli` while mock keeps working (P3). Because this feature ships exactly one executor, the shared implementation (config, pure modules, executor composition, processor wiring) is genuinely Foundational — every story's integration test exercises the *same* code through a different fake-CLI fixture, so story phases here are almost entirely their integration-test task, per plan.md's own Phase-2 grouping (item 5).

**Task IDs continue from iteration 2** (which ended at T071) so T-numbers stay unique across the project's progress journal and reviews. This iteration is **T072–T092**.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable — different files, no dependency on an incomplete task in the same/earlier phase
- **[Story]**: US1–US6 where the task serves a specific user story; setup/foundational/DoD tasks carry no story label
- Every task names its **Verify:** step (command or concrete check)

## Path Conventions

Monorepo root = repository root. New code this iteration: `libs/executors/src/claude-cli/`; extended: `libs/executors/src/executors.module.ts`, `packages/contracts/src/agents-config.schema.ts`, `apps/worker/src/`, `apps/smoke/src/`, `test/fixtures/claude-cli/`, `test/integration/` — per plan.md "Source Code" tree. **No DB migration** (data-model.md — every value maps to an existing column).

---

## Phase 1: Setup — Fake CLI Test Harness

**Goal**: a substitutable `claude` binary and its recorded event streams exist and work standalone, so every later integration test (Phases 3–8) has something to point `cliPath` at. **⚠️ Blocks every integration test in this feature (D8).**

- [X] T072 [P] Add the `zod-to-json-schema` runtime dependency to `packages/contracts/package.json` (needed by `args.ts` in T077 to render `ReportSchema` as the `--json-schema` argument). **Verify**: `pnpm install` exits 0; `node -e "require('zod-to-json-schema')"` resolves from `packages/contracts`.
- [X] T073 [P] Build the fake CLI in `test/fixtures/claude-cli/fake-claude.mjs` per research D8 / contracts/cli-io.md: a Node script that (a) selects which `*.ndjson` fixture to replay from an allowlisted env var (e.g. `FAKE_CLAUDE_FIXTURE`), (b) streams that fixture to stdout line-by-line with small delays (proves incremental parsing, FR-010), (c) dumps its own `process.env` to the path in another allowlisted env var (e.g. `FAKE_CLAUDE_ENV_DUMP`) before exiting (proves env sanitization, FR-019), (d) when a third env var requests it, `spawn`s a child that sleeps indefinitely and writes the child's pid to a known file (proves process-group kill, SC-004), (e) honors `SIGTERM` (prints nothing further, exits) and `SIGKILL` (default), (f) logs its received `process.argv` to a file alongside the env dump (proves argv has no secrets, FR-018). No dependency on the real `claude` binary or network access. **Verify**: `node test/fixtures/claude-cli/fake-claude.mjs` with the fixture/env-dump vars set directly (no worker involved) prints the selected fixture's lines to stdout in order and writes the env-dump + argv-dump files; sending it `SIGTERM` mid-stream exits within ~1s.
- [X] T074 [P] Record the five ndjson fixtures in `test/fixtures/claude-cli/`, each ending in a terminal `result` event carrying `total_cost_usd`, `usage`, `session_id`, `num_turns`, `is_error` (per the D1 live-prototype field confirmation) unless noted: `stream-success.ndjson` (`system/init` → assistant `tool_use` → assistant text → `result` with `structured_output` that validates against `ReportSchema`, `outcome:"succeeded"`); `stream-invalid-report.ndjson` (`result` with `structured_output` missing a required `ReportSchema` field, e.g. no `outcome`); `stream-no-report.ndjson` (`result` with no `structured_output` key at all); `stream-rate-limit.ndjson` (`system/init` → `system` `subtype:"api_retry"` `error:"rate_limit"` `retry_delay_ms` `attempt` → process ends, **no terminal `result` event**); `stream-budget-exceeded.ndjson` (realistic assistant/tool events with per-message token `usage` only — **no USD mid-stream, mirroring the real CLI per research D11's empirical probe** — ending in a terminal `result` whose `total_cost_usd` exceeds a small test budget ceiling, e.g. $0.05, modeling the CLI's own `--max-budget-usd` self-stop). **Verify**: each file is valid NDJSON (`node -e "require('fs').readFileSync(f,'utf8').trim().split('\n').forEach(l=>JSON.parse(l))"` for each fixture, exits 0); `stream-success`'s final line's `structured_output` passes `ReportSchema.parse(...)` in a throwaway `node --experimental-strip-types` or ts-node check; `stream-invalid-report`'s final line's `structured_output` fails `ReportSchema.parse(...)`.

**Checkpoint P1**: `node test/fixtures/claude-cli/fake-claude.mjs` runs standalone against each fixture with no worker/DB/Redis involved; env-dump and argv-dump files are written; SIGTERM is honored promptly.

---

## Phase 2: Foundational — Config, Pure Modules, Executor Composition, Processor Wiring

**Goal**: the `claude_cli` executor type exists end-to-end — validated config, every pure module unit-tested, `ClaudeCliExecutor` composed and registered, a worker processor bound to `run.claude_cli` — but not yet proven against the fake CLI through the real queue/DB (that's Phases 3–8). **Proves**: the non-integration halves of FR-001–003, FR-006, FR-010, FR-014, FR-016–018, FR-022/023. **⚠️ Blocks all user-story phases (every story's integration test needs the composed executor).**

- [X] T075 [P] Replace the `.passthrough()` extras on `ExecutorConfigSchema` in `packages/contracts/src/agents-config.schema.ts` with a discriminated typed branch for `type: "claude_cli"` per contracts/executor-config.md: `model` (string, required), `cliPath` (string, default `"claude"`), `repository` (string, required), `allowedTools` (string[], optional), `keepFailedWorktrees` (boolean, default false), `worktreeRoot?`, `repoCacheRoot?`, `maxTurns?` (int ≥ 1), `killGraceMs?` (default 5000), `cancelPollMs?` (default 3000); `mock` and other executor types keep their current shape. Add `superRefine`: `repository` MUST be one of `workspace.repositories[].name` (path-qualified error otherwise); `model` non-empty; if `allowedTools` omitted, the resolved agent's `behavior.allowed_tools` MUST be non-empty (path-qualified error otherwise — no silent "all tools" default, Constitution V posture). **Verify**: unit test in `agents-config.schema.spec.ts` — a valid `claude_cli` executor + a `mock` executor in one config both parse; `repository` not in `workspace.repositories[].name` fails with the qualified path; missing `model` fails with the qualified path; `allowedTools` omitted with an empty `behavior.allowed_tools` fails with the qualified path.
- [X] T076 [US6-config] `libs/executors/src/claude-cli/claude-cli.config.ts`: resolve the raw `ExecutorConfigSchema` claude_cli branch (T075) into the fully-defaulted runtime shape the executor consumes (`worktreeRoot` defaulting to `<os.tmpdir>/brigadir/worktrees`, `repoCacheRoot` to `<os.tmpdir>/brigadir/repos`, `killGraceMs`/`cancelPollMs` defaults applied, `allowedTools` falling back to the agent's `behavior.allowed_tools`). Pure function, no I/O. **Verify**: unit test `claude-cli.config.spec.ts` — omitted optional fields resolve to the documented defaults; an explicit value always wins over the default.
- [X] T077 [P] `libs/executors/src/claude-cli/args.ts`: pure function building the claude argv per research D1/D7 and contracts/cli-io.md's verified flag table — `-p`, `--output-format stream-json --verbose`, `--json-schema <ReportSchema rendered via zod-to-json-schema (T072)>`, `--model <cfg.model>`, `--append-system-prompt-file <worktree>/.brigadir/wrapper.txt`, `--allowed-tools <resolved,comma,list>`, `--strict-mcp-config --settings '<inline hardening JSON>'`, `--permission-mode dontAsk`, optional `--max-turns <n>` / `--max-budget-usd <n>`. The wrapped instruction is **never** included in the returned argv (delivered on stdin instead, D7) — this function does not accept or touch the instruction text at all. **This is the primary and only report-extraction argv shape; do NOT add a `result.result`-text fallback path — research D1's residual uncertainty was RESOLVED by a live prototype (CLI v2.1.207, 2026-07-11): the terminal `result` event confirmed carries `structured_output` directly, so the fail-closed primary mechanism is final, not provisional.** **Verify**: unit test `args.spec.ts` — snapshot of the built argv for a representative config; asserts every element is a string containing no ticket text and no environment/secret value (searches the joined argv for a set of canary secret strings and asserts none match); `--json-schema`'s value `JSON.parse`s to a JSON-Schema object equivalent to `zodToJsonSchema(ReportSchema)`.
- [X] T078 [P] `libs/executors/src/claude-cli/env-allowlist.ts`: pure function building the child env per research D6 — explicit allowlist (`HOME`, `PATH`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `TERM`, `TMPDIR`, configured git identity) plus keys the agent config explicitly declares; **never** spreads `...process.env`; **never** includes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `AWS_*`, `GCP_*`, `OPENAI_*`, Jira tokens, or any `*_TOKEN`/`*_SECRET`/`*_KEY`/DB/Redis URL pattern even if present in the input. **Verify**: unit test `env-allowlist.spec.ts` — given a fake `process.env`-shaped input containing `ANTHROPIC_API_KEY` and other canary secrets plus the allowlisted keys, the returned env object contains 0 of the canaries and all of the allowlisted + config-declared keys.
- [X] T079 [P] `libs/executors/src/claude-cli/stream-parser.ts`: incremental NDJSON parser per research D5/D13 and data-model.md's event-mapping table. Consumes a readable stream line-by-line (`readline`/`createInterface`); `try { JSON.parse } catch { skip line, continue }` — a bad/partial line never aborts the run (FR-014). Maps: `system/init` → `run_events(log)` + captures `externalRef = session_id`; assistant `tool_use` → `run_events(tool_call)` (bounded input snippet); assistant text → `run_events(progress)` (sampled: cap N per run, min interval, truncated snippet — FR-011); `system/api_retry` with `error==="rate_limit"` → `run_events(api_retry)` + captures `retry_delay_ms`/`attempt`, signals rate-limited termination upstream; `system/api_retry` with any other `error` (`overloaded`, `server_error`) → logged only, run continues; terminal `result` → captures `total_cost_usd`, `usage`, `structured_output`, `is_error`, does NOT emit a timeline row. Exposes the terminal event's `total_cost_usd` (and any USD figure that ever appears mid-stream — guarded, per D11 REVISED) so the caller (T082) can compare against the budget ceiling. **No `result.result`-text fallback parsing** (per D1 resolution — same note as T077). **Verify**: unit test `stream-parser.spec.ts` — feeding each recorded fixture (T074) through the parser (as a string stream, not via the real fake CLI process) produces the expected ordered `run_events` mappings; a line with malformed JSON injected mid-stream is skipped without throwing and without breaking the rest of the parse; `stream-rate-limit.ndjson` yields the `api_retry` mapping and the rate-limit signal with no terminal-result capture.
- [X] T080 [P] `libs/executors/src/claude-cli/worktree.ts`: `prepare(repo, ticketKey, branchPrefix, worktreeRoot, repoCacheRoot)` / `cleanup(worktreeDir, { keep })` per research D3. `prepare`: ensure a cached local clone at `repoCacheRoot/<repo.name>` (`git clone` if absent, else `git fetch`); `git worktree prune`; `git -C <cache> worktree add -b <branchPrefix>/<ticketKey> <worktreeRoot>/<runId> <baseRef>`; if `add -b` fails because the branch already exists, throw a clear diagnostic error (no silent reuse/force-reset — FR edge case). `cleanup`: `git -C <cache> worktree remove --force <dir>` unless `keep` is true, in which case skip removal. **Verify**: unit test `worktree.spec.ts` using real temporary git repos (`git init` in a tmp dir as the "remote", no network) — `prepare` creates a worktree on the expected branch name; calling `prepare` again with a branch that already exists throws a diagnostic error rather than silently succeeding; `cleanup` removes the worktree directory and its `git worktree list` entry but leaves the branch itself intact; `cleanup({keep:true})` leaves the directory in place.
- [X] T081 [P] `libs/executors/src/claude-cli/process-group.ts`: `spawnGroup(cliPath, argv, { cwd, env })` wrapping `child_process.spawn(cliPath, argv, { detached: true, stdio: ['pipe','pipe','pipe'] })` (never `shell:true`); returns the child plus a `killGroup(signal)` helper; `terminate(killGraceMs)` sends `process.kill(-child.pid, 'SIGTERM')`, waits up to `killGraceMs`, then `process.kill(-child.pid, 'SIGKILL')` if still alive; every `process.kill(-pid, ...)` call is guarded in try/catch for `ESRCH`. `unref()` is NOT called — callers always await the `exit` event. **Verify**: unit test `process-group.spec.ts` — spying on `process.kill`, `terminate()` issues `SIGTERM` first and, only if the process is still alive after the grace window (use fake timers), issues `SIGKILL`; calling `terminate()` twice, or on an already-exited pid, does not throw (ESRCH swallowed). *(The real cross-process, multi-descendant group-kill guarantee — the actual point of D2 — is proven end-to-end by the SC-004 integration test in T086, which is the load-bearing check; this unit test only proves the signal-sequencing contract.)*
- [X] T082 `libs/executors/src/claude-cli/claude-cli.executor.ts`: `ClaudeCliExecutor implements AgentExecutor` (interface UNCHANGED — FR-001) composing T076–T081: `run(ctx, signal)` calls `worktree.prepare`, writes the wrapper file (arch §7 Phase-0 template — FR-003, no additional wrapper logic), builds argv (T077) and env (T078), `spawnGroup` (T081), writes the wrapped instruction to `child.stdin` then closes it (never argv — FR-018/D7), pipes stdout through `stream-parser` (T079) and stderr into a bounded ~16KB ring buffer (FR-013), passes `--max-budget-usd` as the mid-run enforcement and, on the terminal `result` event, resolves `exitStatus:'crashed'` with a budget-exceeded diagnostic when `total_cost_usd` exceeds `ctx.limits.maxBudgetUsd` or the result signals a budget stop (FR-015 / **D11 as REVISED** — no mid-stream USD exists to watch; no token→USD estimation), registers `signal.onabort` (fed by the processor's timeout/cancel-poll `AbortController`, D4) to group-kill and resolve `'timeout'`/`'cancelled'`, and applies a single `settled` guard so `run()` resolves exactly once even if budget and timeout race (D12). On clean exit: `structured_output` present and zod-valid → `report` + `exitStatus:'completed'`; absent/invalid → `exitStatus:'completed'` with **no** `report` + diagnostics (FR-007/008, no fabrication). `cleanup(worktreeDir, {keep: cfg.keepFailedWorktrees && failed})` always runs before `run()` resolves. Implements a lazy `healthCheck()` that only checks `cliPath` is resolvable, doing no work at module/`@Module()` init time (Constitution lazy-resolution rule). Reuses `mapExitStatusToRunStatus` (arch §4) as-is — no new mapping (D14). **Verify**: `pnpm --filter @brigadir/executors build` (or the monorepo equivalent) exits 0; a focused unit test drives `run()` with an in-process fake stdout/stderr stream (no real spawn) through each exit path (success/invalid/no-report/crashed/timeout/cancelled/rate-limited) and asserts `ExecutorResult.exitStatus` and the single-resolve guarantee.
- [X] T083 Register `ClaudeCliExecutor` in the `AGENT_EXECUTORS` factory in `libs/executors/src/executors.module.ts` (alongside the unchanged `mock.executor.ts`) and add `apps/worker/src/claude-cli-run.processor.ts` — a near-copy of `run.processor.ts` bound to `@Processor(runQueueName('claude_cli'), { maxStalledCount: 0, settings: { backoffStrategy } })` that builds a **real** `RunContext` (worktree dir from T080, sanitized env from T078, `limits` from the agent's `max_budget_usd`/`timeout_minutes`), owns one `AbortController` per run wired to a `setTimeout(limits.timeoutMs)` and a `CANCEL_POLL_MS`-interval poll of `runs.status` (D4), and finalizes through byte-for-byte the same branches as the mock processor (FR-009). Register the new processor in `apps/worker/src/app.module.ts`. No queue-plumbing change needed beyond this — `QueuesModule.register()` already provisions `run.<type>` per configured executor type. **Verify**: `pnpm nest build worker` exits 0; a unit/light-integration test resolves `ExecutorRegistry.get('claude_cli')` and gets a `ClaudeCliExecutor` instance; static check confirms no git/CLI/fs/spawn work happens inside `@Module()` decorator arguments or Nest context init (grep + code review, same discipline as iteration 1's Rule #1).

**Checkpoint P2**: `pnpm typecheck && pnpm lint && pnpm test` green (every pure module + config + executor-composition unit test passes); `claude_cli` is resolvable via `ExecutorRegistry`; mock executor and its existing unit tests are untouched and still green (first half of SC-002).

---

## Phase 3: User Story 1 — Run a real coding agent on a ticket (P1) 🎯 MVP

**Goal**: a full run against the fake CLI produces a finalized outcome exactly the way the mock's finalization path already works — success, invalid-report, and no-report all handled without fabrication, worktree created and removed.

**Independent Test** (spec.md): configure a `claude_cli` agent whose `cliPath` is the fake CLI; trigger a run on a test ticket; confirm it finalizes with the expected outcome, the report is persisted, the worktree existed on the expected branch during the run and no longer exists after.

- [X] T084 [US1] Integration test `test/integration/claude-cli-lifecycle.spec.ts` (real worker/queue/DB via testcontainers, `cliPath` pointed at `fake-claude.mjs`, per quickstart.md's fake-CLI pattern): **success** (`stream-success` fixture) — run finalizes `succeeded`, `report` persisted and matches the fixture's `structured_output`, `worktree_path` was set during the run and the worktree/branch (`<branchPrefix>/<ticketKey>`) no longer exist after; **invalid report** (`stream-invalid-report` fixture) — run finalizes `failed` with a validation diagnostic in `error`, `report` is null, no outcome is guessed; **no report** (`stream-no-report` fixture) — run finalizes `failed` with a diagnostic. **Verify**: `pnpm test:integration test/integration/claude-cli-lifecycle.spec.ts` green (FR-002/003/005/007/008/009; SC-005).

**Checkpoint P3 — MVP**: a real (fake-CLI-driven) run completes the full trigger → worktree → process → finalize → Jira-transition loop with zero fabricated outcomes.

---

## Phase 4: User Story 2 — Protect the operator's subscription auth (P2 → P1 per spec)

**Goal**: prove, automatically, that the child process the executor spawns never sees a host secret and never carries one on its command line — this is the mandatory security guarantee (Constitution V) called out explicitly for this feature (FR-019/SC-003).

**Independent Test** (spec.md): with a canary `ANTHROPIC_API_KEY` and other known secrets present in the worker's own environment, start a run and assert none of them appear in the spawned process's environment or command-line arguments.

- [X] T085 [US2] **[Mandatory security test]** Integration test `test/integration/claude-cli-security.spec.ts`: set a canary `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, an `AWS_SECRET_ACCESS_KEY`-shaped value, a fake `JIRA_API_TOKEN`, and a `DATABASE_URL`-shaped value in the **worker process's own environment** before triggering a run against the fake CLI (`stream-success` fixture, so the run completes normally); the fake CLI dumps its received `process.env` and `process.argv` to files (T073) — assert the env dump contains **0** of the injected canaries and only allowlisted/config-declared keys, and the argv dump contains **0** of the canary values and no ticket body text anywhere. Run it a second time with the canaries present but the agent's own declared env-passthrough list empty, confirming the allowlist floor still holds. **Verify**: `pnpm test:integration test/integration/claude-cli-security.spec.ts` green (FR-016/017/018/019; SC-003 — 0% of canaries present in either channel).

**Checkpoint P4**: SC-003 proven end-to-end through the real worker, not just at the pure-module level (T078/T077 already covered the unit-level guarantee; this closes the loop through the real spawn).

---

## Phase 5: User Story 3 — Enforce time, cancellation, and budget limits (P2)

**Goal**: whatever kills the run — timeout, operator cancellation, or budget ceiling — kills the **entire** process tree, not just the direct child, and the run finalizes exactly once with the correct terminal status.

**Independent Test** (spec.md): using a fake CLI that sleeps and spawns a child, verify timeout and cancellation terminate the whole process group with zero orphans; using a fake CLI reporting escalating cost, verify the run is killed and failed once the ceiling is crossed.

- [X] T086 [US3] **[Mandatory orphan-process test]** Integration test `test/integration/claude-cli-limits.spec.ts`: **timeout** — configure the fake CLI (via its spawn-child mode, T073) to spawn a sleeping grandchild and sleep itself past the agent's `timeout_minutes`; after the run finalizes `timed_out`, assert the fake CLI's pid **and** its recorded grandchild pid are both gone (`process.kill(pid, 0)` throws `ESRCH` for both — **0 survivors**, SC-004); **cancellation** — start a run, flip the `runs.status` row off `running` mid-run (simulating an operator/reconcile action), assert the whole group is killed, the run finalizes `cancelled`, and a `stream-success` fixture arriving on the (already-dead) pipe after cancellation does **not** revive the finalized row; **budget** — drive `stream-budget-exceeded` (terminal `result` with `total_cost_usd` over the agent's `max_budget_usd`, per D11 REVISED), assert the run finalizes `failed` with a budget-exceeded diagnostic and no processes survive finalization; **near-simultaneous budget+timeout** (spec edge case) — assert the run is finalized exactly once (single terminal status, no double-finalize error). **Verify**: `pnpm test:integration test/integration/claude-cli-limits.spec.ts` green (FR-004/005/015; SC-004 — 0 orphaned processes in every termination case).

**Checkpoint P5**: SC-004 proven — no scenario in this feature can leak a live process after finalization.

---

## Phase 6: User Story 4 — Live progress and cost visibility (P2)

**Goal**: while (not only after) the agent runs, meaningful events land on the run's timeline in order, and final usage/cost figures and a bounded stderr tail are captured on the run record.

**Independent Test** (spec.md): feed a recorded event stream through a run and assert the expected timeline events are persisted and final usage/cost values are stored.

- [X] T087 [US4] Integration test (**extends** `test/integration/claude-cli-lifecycle.spec.ts` from T084 — same fixture, same file, per plan.md's project structure): from the `stream-success` run already exercised in T084, additionally assert `run_events` contains, **in order**, a `log` row from `system/init`, at least one `tool_call` row, and at least one `progress` row; assert `cost_usd` and `usage` on the finalized `runs` row match the fixture's terminal `result` event's `total_cost_usd`/`usage`; separately, trigger a run whose fake CLI is told to write to stderr before exiting non-zero (a small stderr-emitting mode added to `fake-claude.mjs` if not already covered by T073), and assert the finalized run's `error` column contains a bounded tail of that stderr output. **Verify**: `pnpm test:integration test/integration/claude-cli-lifecycle.spec.ts` green including the new assertions (FR-010/011/012/013).

**Checkpoint P6**: the run timeline and cost/usage capture are proven live (incremental), not just as a post-hoc read of the terminal event.

---

## Phase 7: User Story 5 — Tolerate subscription rate limits without burning an attempt (P3)

**Goal**: a subscription rate-limit signal from the CLI is treated as "retry later," never as a failed attempt.

**Independent Test** (spec.md): using a fake CLI that emits a rate-limit signal, verify the run surfaces a distinct rate-limited outcome, stays eligible to run again, and its attempt counter is not spent.

- [X] T088 [US5] Integration test `test/integration/claude-cli-rate-limit.spec.ts`: drive `stream-rate-limit` through a run; assert a `run_events(api_retry)` row is recorded with the fixture's `retry_delay_ms`/`attempt`; assert the executor resolves `exitStatus:'rate_limited'`; assert the existing processor path (`mapExitStatusToRunStatus` → `action:'rate_limit'` → `worker.rateLimit(ttl)` + `Worker.RateLimitError`) requeues the job, the run's `attempt` counter is **not** incremented, and the run row stays active (not `failed`). **Verify**: `pnpm test:integration test/integration/claude-cli-rate-limit.spec.ts` green (FR-020/021; SC-006 — retried later, 0 attempts spent).

**Checkpoint P7**: SC-006 proven — hitting a subscription window never permanently fails a run.

---

## Phase 8: User Story 6 — Configure claude_cli while mock keeps working (P3)

**Goal**: the configuration seam works and does not disturb mock — this is the coexistence guarantee protecting the entire existing test suite.

**Independent Test** (spec.md): add a `claude_cli` executor to the configuration alongside the existing mock executor; confirm the configuration validates, the executor is resolvable by type, and the full existing mock-based integration suite still passes unchanged.

- [X] T089 [US6] Integration test `test/integration/claude-cli-config.spec.ts`: boot the worker/backend with an `agents.yaml` declaring **both** a `mock` executor and a `claude_cli` executor (model + behavior-derived `allowedTools` + a `repository` from the workspace's repository list); assert both validate at boot and are resolvable via `ExecutorRegistry.get(type)`; assert a `claude_cli` executor whose `repository` is not in `workspace.repositories[].name` aborts boot with the path-qualified error; assert a `claude_cli` executor missing `model` aborts boot with the path-qualified error. **Verify**: `pnpm test:integration test/integration/claude-cli-config.spec.ts` green (FR-022/023; SC-002 config half). *(SC-002's other half — the full pre-existing mock suite passing unchanged — is reconfirmed for real at the Phase 9 full-suite checkpoint, T090.)*

**Checkpoint P8**: US6 fully proven — config seam validated, both executor types coexist, nothing about mock has regressed.

---

## Phase 9: Checkpoint + Live Smoke (DoD Gate)

**Goal**: the whole automated suite is green and stable, then the manual live smoke proves one real coding run works end-to-end on the operator's own Claude subscription, recorded in the progress journal. **Everything up to and including T090 is verifiable by the automated suite alone (SC-007); only T091 touches the real CLI.**

- [X] T090 **[Full-suite checkpoint]** Run `pnpm typecheck && pnpm lint && pnpm test`; then `pnpm test:integration`; then run `pnpm test:integration` **3 consecutive times** to guard against flake regressions (the iteration-1 shared-container class of bug — see `docs/progress.md`'s post-DoD fix note). **Verify**: static + unit green; four total integration runs (the first plus three more) all green with no stuck-at-queued/running stalls; the pre-existing mock-based suites are among the green runs (closes SC-002 fully); record the run counts.
- [ ] T091 **[Live smoke — manual DoD gate]** Prerequisites: a logged-in Claude Code CLI on the operator's machine (`claude` on PATH, `~/.claude` auth via `claude setup-token` or an interactive login) and a scratch throwaway git repository + a real test ticket. Extend `apps/smoke` with a `pnpm smoke:claude -- --ticket <KEY>` script (analogous to iteration 2's `smoke:run`/live-smoke helper) that configures a `claude_cli` agent in `agents.yaml` pointing at the scratch repo and triggers exactly one real run. **Note**: research D1's residual uncertainty (whether the terminal `result` event carries `structured_output`) was already **RESOLVED** by a live prototype on 2026-07-11 against CLI v2.1.207 — this run reconfirms that behavior on the operator's own installed CLI version as a sanity check, it is **not** pinning an open unknown, and there is no `result.result`-text fallback code path to fall back to if it were somehow absent (fail-closed by design — if `structured_output` is ever absent here, the run correctly fails with a diagnostic rather than silently degrading). **Verify**: within ~15 minutes the run ends with a schema-valid report, the ticket transitions per the agent's `status_success`/`status_failure`, and the worktree is cleaned up (or kept iff the run failed and `keepFailedWorktrees` is set) (SC-001). Capture the ticket key, the run's `cost_usd`, and the terminal `result` event's presence of `structured_output` for the journal.
- [ ] T092 **[DoD record]** Add the iteration-3 entry to `docs/progress.md`: status/date, DoD checklist (unit + integration green, 3 consecutive full integration runs green, security test green — SC-003, orphan-process test green — SC-004, rate-limit test green — SC-006, live smoke executed — SC-001), the live-smoke ticket reference + observed cost, an explicit note that research D1's residual is **CONFIRMED CLOSED** (no fallback path exists or was needed), and any elaborations discovered during implementation (e.g. if `claude-cli.config.ts`'s default-resolution turned out to duplicate logic better placed solely in the contracts schema, or vice versa — record the actual shape, don't silently diverge from data-model.md/contracts/ without a note here). **Verify**: `docs/progress.md` committed with the iteration-3 entry and the D1-closed note.

**Checkpoint P9**: full suite green ×4 total; live smoke passed on the operator's real subscription; progress journal records the DoD and confirms D1 closed.

---

## Dependencies & Execution Order

### Phase order (strict)

- **Phase 1 (Fake CLI harness)** → no dependency on iteration 2 beyond the repo existing. **Blocks every integration test task in Phases 3–8** (D8).
- **Phase 2 (Foundational)** → depends on Phase 1 only for the zod-to-json-schema dep (T072); the pure modules themselves (T077–T081) don't need the fake CLI to be unit-tested. **Blocks all six user-story phases** — none of Phases 3–8 has anything to integration-test against until T082/T083 exist.
- **Phase 3 (US1)** → depends on Phase 1 + Phase 2. First story phase; establishes the MVP.
- **Phase 4 (US2)** → depends on Phase 1 + Phase 2. Independent of Phase 3's spec file; can run in parallel with it.
- **Phase 5 (US3)** → depends on Phase 1 + Phase 2. Independent of Phases 3–4's spec files.
- **Phase 6 (US4)** → depends on Phase 3 (T084) — **extends the same spec file** (`claude-cli-lifecycle.spec.ts`), so it is sequential after T084, not parallel with it.
- **Phase 7 (US5)** → depends on Phase 1 + Phase 2. Independent of the other story spec files.
- **Phase 8 (US6)** → depends on Phase 1 + Phase 2 (and, for the "repository not in workspace list" case, T075's superRefine). Independent of the other story spec files.
- **Phase 9 (Checkpoint + Live smoke)** → depends on Phases 3–8 all green.

### Explicit blocking edges

- **Fake CLI + fixtures (T073/T074)** block T084, T085, T086, T087, T088, T089 (every integration test in this feature).
- **`ExecutorConfigSchema` claude_cli branch (T075)** blocks `claude-cli.config.ts` (T076) and the config-validation assertions in T089.
- **All of T076–T081** block the executor composition (T082), which blocks the processor wiring (T083), which blocks every story-phase integration test (T084–T089).
- **T084 (lifecycle spec file created)** blocks T087 (extends the same file — same-file conflict if run out of order).

### Parallelizable vs sequential

- **Parallel within P1**: T072, T073, T074 (distinct files/concerns).
- **Parallel within P2**: T075, T077, T078, T079, T080, T081 (distinct files, no cross-dependency). Sequential: T075→T076 (config resolution needs the schema); (T076+T077+T078+T079+T080+T081)→T082 (composition needs every pure module); T082→T083 (processor needs the composed executor).
- **Parallel across story phases**: Phase 3 (T084), Phase 4 (T085), Phase 5 (T086), Phase 7 (T088), Phase 8 (T089) touch distinct spec files and are mutually parallel once Phase 2 is done. **Phase 6 (T087) is NOT parallel with Phase 3 (T084)** — same file.
- **Sequential in P9**: T090 → T091 → T092.

---

## Parallel Execution Examples

```bash
# Phase 1 (nothing before it):
Task T072: add zod-to-json-schema dependency
Task T073: build fake-claude.mjs
Task T074: record the five ndjson fixtures

# Phase 2 pure modules (after T072, T075):
Task T077: args.ts (argv builder)
Task T078: env-allowlist.ts
Task T079: stream-parser.ts
Task T080: worktree.ts
Task T081: process-group.ts

# Story-phase integration tests (after T083 + Phase 1):
Task T084: claude-cli-lifecycle.spec.ts (US1)
Task T085: claude-cli-security.spec.ts (US2)
Task T086: claude-cli-limits.spec.ts (US3)
Task T088: claude-cli-rate-limit.spec.ts (US5)
Task T089: claude-cli-config.spec.ts (US6)
# T087 (US4) must wait for T084 to land first — extends the same file.
```

---

## Implementation Strategy

### MVP scope

**US1 (run a real coding agent on a ticket) is the MVP** — reached at the **end of Phase 3**, where a fake-CLI-driven run completes the full trigger → worktree → process → finalize loop with a real report. It requires Phases 1→2→3. US2's security guarantee (Phase 4) is load-bearing enough (Constitution V, cost-safety) that it should land immediately after, even though the spec ranks US1/US2 both P1.

### Incremental delivery

1. Phase 1 → fake CLI + fixtures work standalone (D8 prerequisite satisfied).
2. Phase 2 → `claude_cli` executor exists, composed and registered, fully unit-tested (no integration proof yet).
3. Phase 3 → real (fake-CLI) run completes and finalizes correctly (US1 / MVP).
4. Phase 4 → secret isolation proven end-to-end (US2 — SC-003).
5. Phase 5 → timeout/cancel/budget all group-kill with zero orphans (US3 — SC-004).
6. Phase 6 → timeline + cost/usage + stderr tail proven live (US4).
7. Phase 7 → rate limits retried without spending an attempt (US5 — SC-006).
8. Phase 8 → config coexistence with mock proven (US6 — SC-002 config half).
9. Phase 9 → full-suite checkpoint ×4, live smoke on the real subscription, DoD journal entry.

### Independent test criteria (per story)

- **US1**: fake-CLI success/invalid-report/no-report → correct finalize + worktree lifecycle (T084).
- **US2**: canary secrets in worker env → 0% present in child env/argv (T085).
- **US3**: timeout/cancel/budget → whole process group killed, 0 orphans, exactly-once finalize (T086).
- **US4**: recorded stream → ordered timeline + final cost/usage + stderr tail (T087).
- **US5**: rate-limit fixture → distinct outcome, retried later, 0 attempts spent (T088).
- **US6**: `claude_cli` + `mock` coexist in config; invalid config fails boot with a qualified path (T089).

### Notes

- Tests are **mandatory** for every pipeline-logic task (Constitution VI); each pure module in Phase 2 ships its own unit test in the same task, and each story's integration test ships in that story's own phase — no end-of-project test batch.
- The mandatory security test (FR-019/SC-003) is T085; the mandatory orphan-process test (SC-004) is T086 — both called out explicitly per this iteration's requirements, not folded silently into a general lifecycle test.
- No `result.result`-text fallback parsing exists anywhere in this task list (T077, T079, T091) — research D1's residual was resolved by a live prototype before planning began; implementing a fallback would contradict the fail-closed design research.md settled on.
- Live smoke (T091) is manual and gated on a real Claude subscription; it stays its own task so the automated suite (T090) is the machine-verifiable DoD half, exactly as iteration 2's T069/T070 split.
