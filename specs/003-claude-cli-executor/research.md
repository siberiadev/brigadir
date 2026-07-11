# Phase 0 Research — claude_cli Executor

All CLI flag names below were verified against the **current** official docs on
2026-07-11:
- CLI reference: https://code.claude.com/docs/en/cli-reference
- Headless / `claude -p`: https://code.claude.com/docs/en/headless

Version note: `--json-schema` structured output requires **Claude Code
v2.1.205+** (before that an invalid schema was silently ignored and text
returned). `--max-budget-usd` and `--max-turns` are documented print-mode flags.

---

## D1 — Report extraction (THE key unknown, spec Assumptions #2)

**Decision.** Spawn:

```
claude -p \
  --output-format stream-json --verbose \
  --json-schema '<ReportSchema-as-JSON-Schema>' \
  --model <cfg.model> \
  --append-system-prompt-file <worktree>/.brigadir/wrapper.txt \
  --allowed-tools <derived…> \
  --strict-mcp-config --settings '<inline hardening JSON>' \
  --permission-mode dontAsk \
  --max-turns <cfg.maxTurns?> --max-budget-usd <cfg.maxBudgetUsd?>
# instruction/task text delivered on STDIN (D7), not as the prompt arg
```

Consume the NDJSON stream incrementally (D13). The **final `result` event** is
the same object `--output-format json` emits as its whole payload; with
`--json-schema` present that payload carries the schema-validated object in a
`structured_output` field (headless docs: "The response includes metadata …
with the structured output in the `structured_output` field"). The executor:

1. reads `result.structured_output` from the terminal `result` event;
2. re-validates it with our own `ReportSchema` (zod) — the CLI validates against
   the JSON-Schema *shape*, but our zod adds the conditional rule
   (`outcome=needs_human ⇒ human_task`) and `.strict()`, so we never trust the
   CLI's validation alone;
3. returns it as `ExecutorResult.report`. The existing processor +
   `RunsService.finalizeWithReport` apply the SAME gate the mock uses (FR-009).

**Explicit failure behavior (FR-008).** If the process exits with no `result`
event, or `structured_output` is absent, or our zod parse fails → the executor
returns `exitStatus:'completed'` **without** `report` (plus `diagnostics`). The
processor's existing `catch` around `finalizeWithReport` then finalizes `failed`
with the validation diagnostic. Nothing is guessed, synthesized, or partially
accepted.

**Residual uncertainty — RESOLVED by prototype (2026-07-11, CLI v2.1.207).**
A live one-turn run of `claude -p --output-format stream-json --verbose
--json-schema '<schema>'` confirmed the terminal event is
`{"type":"result", ...}` and **carries `structured_output`** with the
schema-valid object. The same event also carries `total_cost_usd`, `usage`,
`session_id`, `num_turns`, `is_error` — confirming the D11/D13 field
assumptions. Primary mechanism stands as designed; the `result.result`-text
fallback is NOT needed and MUST NOT be implemented (fail-closed only).
Also verified against the installed binary: `--append-system-prompt-file` and
`--max-turns` exist but are hidden from `--help` (arg parser accepts both);
`--permission-mode` choices include `dontAsk`.

**Rationale.** stream-json is required for incremental events/cost/rate-limit
(FR-010/011/012/020). `--json-schema` is the documented, fail-closed way to get
a schema-shaped final object without an MCP callback (deferred to iteration 5 per
Assumptions #1). Re-validating with zod keeps the Constitution-IV gate identical
to mock.

**Alternatives rejected.** (a) `--output-format json` only → loses incremental
streaming (violates FR-010). (b) Regex/scrape the assistant text for a JSON blob
→ fragile, invites fabrication. (c) Stand up the MCP `complete_task` server now →
explicitly out of scope this iteration (Assumptions #1, arch §5 iteration 5).

---

## D2 — Process-group termination (macOS + Linux)

**Decision.** `child_process.spawn(cliPath, args, { detached: true, stdio:
['pipe','pipe','pipe'] })`. `detached:true` makes the child a **process-group
leader** (its own group id == its pid) on both darwin and linux. To stop the
whole tree, signal the **negative pid**: `process.kill(-child.pid, 'SIGTERM')`,
then after a grace period `process.kill(-child.pid, 'SIGKILL')`. Grace window:
`CLAUDE_CLI_KILL_GRACE_MS` (default 5000 ms). Reap by awaiting the `exit`/`close`
event; never leave the promise pending after a kill. Guard every
`process.kill(-pid)` in try/catch for `ESRCH` (already gone).

**Notes.** Do NOT use `shell:true` (breaks group semantics and reintroduces the
injection surface D7 avoids). `child.kill()` alone signals only the direct child,
leaving `claude`'s Bash-tool grandchildren orphaned — that is exactly the
SC-004/FR-004 failure we must prevent. `unref()` is NOT used: the worker must
observe exit to finalize.

**Rationale.** Negative-pid group signalling is the portable POSIX mechanism that
reaches the agent's own spawned children (git, pnpm, test runners). Verified in
the SC-004 integration test with a fake CLI that itself spawns a sleeping child.

**Alternatives rejected.** `tree-kill` dep (unnecessary — native negative-pid is
enough and dep-free); Windows `taskkill` (worker only runs darwin/linux).

---

## D3 — git worktree lifecycle

**Decision.**
- **Layout.** Per-run worktree at `WORKTREE_ROOT/<runId>` (config
  `worktreeRoot`, default `<os.tmpdir>/brigadir/worktrees` in dev, a bind-mounted
  volume path in docker). Branch `= <branchPrefix>/<ticketKey>` (arch §7
  behavior), e.g. `feat/BRIG-123`.
- **Source clone (large-repo aware).** Keep one **cached local clone per
  repository** at `REPO_CACHE_ROOT/<repo.name>` (bare-equivalent working clone).
  First run for a repo `git clone <repo.url>` (or `git fetch` if present); each
  run then `git -C <cache> worktree add -b <branch> <worktreeRoot/runId>
  <baseRef>`. This avoids a full network clone per run.
- **Branch collision from a prior crashed run (edge case FR/spec §Edge).** If
  `worktree add -b` fails because the branch exists, prepare fails **fast and
  loud** with a diagnostic → run `failed` (spec: "fails with a clear diagnostic
  rather than running against a wrong tree"). We do NOT silently reuse or
  force-reset a leftover branch (could contain half-finished work). Stale
  worktree dirs are pruned with `git worktree prune` before add.
- **Cleanup.** After the run: `git -C <cache> worktree remove --force
  <worktreeRoot/runId>` (`--force` needed because the tree has uncommitted/dirty
  files). `--force` removes the working tree and its administrative entry but
  does NOT delete the branch — pushed work is preserved. If
  `keepFailedWorktrees` is set and the run failed, skip removal and record
  `worktree_path` for debugging.

**Rationale.** Cached clone + worktree keeps per-run prep cheap for large repos;
fail-fast on collision honors the spec edge case and avoids corrupt runs;
`--force` is the documented way to remove a dirty worktree.

**Alternatives rejected.** Fresh `git clone` per run (too slow for large repos);
auto-force-resetting a colliding branch (data-loss risk, violates the spec edge
case intent).

---

## D4 — Cancellation signal path (no cancel API yet)

**Decision.** Reuse the interface's `AbortSignal` — do NOT invent a new channel.
Minimal path consistent with existing infra:
1. The `claude-cli-run.processor` creates one `AbortController` per run and links
   two sources to it: (a) a **timeout** `setTimeout(limits.timeoutMs)`; (b) a
   lightweight **cancellation poll** — every `CANCEL_POLL_MS` (default 3000 ms)
   read `runs.status`; if it is no longer `running` (an operator/reconcile flipped
   it toward `cancelled`) → `abort()`. State stays in Postgres (Constitution I).
2. `ClaudeCliExecutor.run(ctx, signal)` registers `signal.onabort` → run the D2
   group-kill and resolve with `exitStatus:'timeout'` or `'cancelled'` (the
   processor tells them apart by which source fired).
3. **Late report after abort is ignored** (spec edge case): once aborted the
   executor never returns a `report`; and `RunsService.guardedFinalize` is
   `WHERE status IN (active)`, so a finalize on an already-cancelled row affects
   0 rows. Finalized status stands.

No UI, no HTTP endpoint, no new table — cancellation is "the run row left
`running`", observed by the existing DB the reconcile sweeper already owns.

**Rationale.** Smallest change that satisfies FR-004/US3 within the frozen
interface; the DB flag is the source of truth (Principle I) and the reconcile
watchdog already inspects run liveness.

**Alternatives rejected.** New cancel REST endpoint / BullMQ control queue
(out of scope, more surface); Redis pub/sub flag (durable state must be Postgres,
Principle I).

---

## D5 — Rate-limit signal detection

**Decision.** Detect the stream-json **`system` / `subtype:"api_retry"`** event
(verified field table in headless docs) with `error === "rate_limit"`. On seeing
it the executor:
1. records a `run_events` row of type `api_retry` (matches the mock's marker and
   the existing timeline vocabulary);
2. captures `retry_delay_ms` for the requeue TTL;
3. terminates the process group (we don't wait out a subscription window inside a
   worker slot) and resolves `exitStatus:'rate_limited'` with
   `diagnostics` + the ttl surfaced on the result.

The existing processor path handles the rest: `mapExitStatusToRunStatus` →
`action:'rate_limit'` → `worker.rateLimit(ttl)` + `throw Worker.RateLimitError()`
→ **attempt not consumed**, run stays active (FR-020/021, SC-006). TTL: prefer
the event's `retry_delay_ms`; for 5-hour subscription windows (reset time not
programmatically available) fall back to the arch §4 heuristic (15 min, 60 min on
repeat).

**Nuance.** `api_retry` also fires for transient `overloaded`/`server_error`
(same event, different `error` category) — those are the CLI's *own* retries; we
only escalate to `rate_limited` on `error === "rate_limit"` (and
`authentication_failed`/`oauth_org_not_allowed`/`billing_error` map to an
unrecoverable failure, not a requeue). Other categories are logged and the run
continues.

**Rationale.** Uses the documented, structured signal (no stderr scraping) and
plugs straight into the iteration-1 rate-limit machinery the mock already
exercises.

**Alternatives rejected.** Parsing exit code / stderr text for "rate limit"
(unstructured, version-fragile); treating every `api_retry` as rate-limited
(would requeue on ordinary transient blips).

---

## D6 — Env allowlist & subscription-auth isolation

**Decision.** Child env is built in code as an **explicit allowlist**, never
`...process.env`:
- Pass-through keys needed for a subscription run on the operator machine:
  `HOME` (to read `~/.claude` credentials/keychain helper), `PATH`, `USER`,
  `LOGNAME`, `SHELL`, `LANG`, `TERM`, `TMPDIR`, and git-identity if configured.
- Plus keys the agent config explicitly declares (arch §4 "плюс переменные,
  которые объявляет конфиг агента").
- **Never** `ANTHROPIC_API_KEY` (would silently switch to API billing — US2),
  `ANTHROPIC_AUTH_TOKEN`, `AWS_*`, `GCP_*`, `OPENAI_*`, Jira tokens, `*_TOKEN`,
  `*_SECRET`, `*_KEY`, DB/Redis URLs, or the worker's own secrets.
- `--strict-mcp-config` (ignore any host MCP servers) + explicit `--settings`
  inline JSON to neutralize host settings, per Constitution V. Consider
  `--setting-sources` (empty / `project` only) to avoid loading `~/.claude`
  settings while still allowing the keychain OAuth read.
- **`--bare` is NOT used**: it skips OAuth/keychain reads and *requires*
  `ANTHROPIC_API_KEY` or an `apiKeyHelper` — the opposite of subscription auth.
  We get bare-like determinism instead via `--strict-mcp-config` + `--settings` +
  scoped `--setting-sources`.

Test (FR-019/SC-003): with canary `ANTHROPIC_API_KEY` + other secrets in the
worker env, assert 0 appear in the child env (fake CLI dumps `process.env` to a
file) and 0 appear in argv.

**Rationale.** Structural secret isolation (Principle V) that still lets the real
CLI find the subscription token on the operator box; the live-smoke gate is
where the real keychain path is proven (tests never need it).

**Alternatives rejected.** `--bare` (breaks subscription auth); denylist instead
of allowlist (fails open when a new secret var appears).

---

## D7 — Instruction delivery (shell-injection surface)

**Decision.** The wrapped instruction (ticket text — arbitrary, untrusted) is
delivered to `claude -p` via **stdin** (`--input-format` default text; write the
prompt to `child.stdin` then `end()`), NOT as a positional arg. The compiled
system wrapper (arch §7 Phase-0 static template) goes via
`--append-system-prompt-file` pointing at `<worktree>/.brigadir/wrapper.txt`
(file, not arg). No secret and no ticket body ever appears in argv → invisible in
`ps` and immune to shell metacharacter injection. `shell:false` (default) so
args are passed as an execve vector, not parsed by a shell.

Piped stdin cap is 10 MB (v2.1.128+); our wrapped instruction is far under it.

**Rationale.** Satisfies FR-018 and Constitution V, and removes the injection
vector the plan flagged.

**Alternatives rejected.** Instruction as the `-p "<text>"` positional (visible
in `ps`, injection risk); env var (still process-visible, and huge tickets hit
env limits).

---

## D8 — Binary substitutability & the fake CLI

**Decision.** Executor config carries `cliPath` (default `"claude"`, resolved
from PATH at run time — lazy). Integration tests set `cliPath` to
`test/fixtures/claude-cli/fake-claude.mjs`, a Node script that: reads which
fixture to replay (from an env var the test sets through the allowlist, or from
argv it inspects), streams the chosen `*.ndjson` to stdout line by line with
small delays (to prove incremental parsing), optionally spawns a child + sleeps
(to prove group-kill), dumps its own `process.env` to a temp file (to prove env
sanitization), and honors SIGTERM/SIGKILL. No real `claude`, no subscription in
CI (SC-007, FR-025).

**Rationale.** One substitution point (`cliPath`) turns the whole executor
testable end-to-end through the real worker/queue/DB with deterministic streams.

**Alternatives rejected.** Mocking `child_process.spawn` (wouldn't exercise real
process-group/stdin/stream framing — the risky parts).

---

## D9 — Config extension (`claude_cli` executor type)

**Decision.** Replace the loose `.passthrough()` on `ExecutorConfigSchema` extras
with a discriminated typed branch for `claude_cli` (mock/others keep their
current shape). New fields (all validated at boot, FR-022/023):
`model` (string), `cliPath` (string, default `"claude"`), `repository` (string —
must match a `workspace.repositories[].name`; superRefine cross-check),
`allowedTools` (string[] — else derived from `behavior.allowed_tools`),
`keepFailedWorktrees` (boolean default false), `worktreeRoot?`, `repoCacheRoot?`,
`killGraceMs?`, `cancelPollMs?`. Invalid config → path-qualified fatal error via
the existing loader (`libs/app-config`). See `contracts/executor-config.md`.

**Rationale.** Boot-time validation prevents a broken run later (FR-023); the
repository cross-check ties the executor to the workspace repo list (FR-022).

**Alternatives rejected.** Leaving `.passthrough()` (defers errors to run time).

---

## D10 — Queue & processor wiring

**Decision.** No queue-plumbing change needed: `QueuesModule.register()` already
creates a `run.<type>` queue for every distinct executor type in the config, so
declaring a `claude_cli` executor auto-provisions `run.claude_cli`.
`RunTriggerService` already routes by `executor.type`. Add
`apps/worker/src/claude-cli-run.processor.ts` — a near-copy of
`run.processor.ts` bound to `@Processor(runQueueName('claude_cli'), {
maxStalledCount: 0, settings:{ backoffStrategy } })` — that builds a **real**
`RunContext` (worktree dir, sanitized env, per-run limits) and owns the
timeout/cancel `AbortController` (D4). Finalization branches are byte-for-byte
the mock processor's (FR-009).

**Rationale.** One queue per executor type is the established pattern; reusing
the processor shape keeps the D4 status mapping and dedup guarantees identical.

**Alternatives rejected.** A single shared processor switching on type (couples
concurrency limits across executors — arch §4 wants per-type concurrency).

---

## D11 — Budget enforcement (belt + suspenders)

**Decision.** (a) Pass native `--max-budget-usd <cfg.maxBudgetUsd>` so the CLI
self-limits. (b) Independently, the stream parser tracks cumulative
`total_cost_usd` from result/usage events; when it crosses `limits.maxBudgetUsd`
the executor group-kills (D2) and resolves `exitStatus:'crashed'` (maps to
`failed`) with a **budget-exceeded** diagnostic (FR-015). Our own check
guarantees the process-group kill and a deterministic single finalize even if the
native flag's accounting lags.

**Rationale.** FR-015 requires *we* terminate and fail on the ceiling; the native
flag is a helpful first line but we don't depend on it alone.

---

## D12 — Timeout & deterministic single finalize

**Decision.** Timeout is the D4 `setTimeout` → abort → group-kill →
`exitStatus:'timeout'`. Near-simultaneous budget+timeout (spec edge case) is made
deterministic by a single `settled` guard in the executor: the first terminal
cause wins, subsequent causes are no-ops; `run()` resolves exactly once, and
`guardedFinalize` (0-row on non-active) guarantees one DB finalize.

---

## D13 — Stream parsing: resilience, event mapping, bounding

**Decision.** Frame stdout with `readline`/`createInterface` (one JSON per line).
Per line: `try { JSON.parse } catch { record nothing, continue }` — a bad/partial
line never aborts the run (FR-014). Map events to `run_events`:
- `system`/`init` → `log` (session metadata, model, tools);
- assistant `tool_use` → `tool_call`;
- assistant text → `progress` (sampled: cap N per run / min interval, snippet
  truncated) — keeps the timeline bounded (FR-011);
- `system`/`api_retry` → `api_retry` (D5);
- `result` (terminal) → capture cost/usage/structured_output, do not spam
  timeline.
stderr is captured into a **bounded ring buffer** (last ~16 KB) → persisted to
`runs.error` on failure (FR-013). `externalRef` = `session_id` from `init`.

**Rationale.** Directly satisfies FR-010/011/012/013/014 with bounded storage.

---

## D14 — Outcome→status mapping (reused as-is)

**Decision.** No new mapping. `ExecutorResult.exitStatus` values used:
`completed` (report present → succeeded/failed/awaiting_human; absent/invalid →
failed), `crashed` (nonzero exit / budget → retry-or-failed), `timeout`
(→ timed_out), `rate_limited` (→ requeue, no attempt), `cancelled`
(→ cancelled). Exactly `mapExitStatusToRunStatus` (arch §4), already unit-tested.

---

## D15 — Data model

**Decision.** **No migration.** Every value this feature writes has an existing
`runs`/`run_events` column (D-note in data-model.md). Confirms spec expectation
"no schema change expected."

---

### Verified flag summary (copy-source for `args.ts`)

| Need | Flag (verified 2026-07-11) |
|---|---|
| headless | `-p` / `--print` |
| streaming events | `--output-format stream-json --verbose` |
| schema-shaped final report | `--json-schema '<json-schema>'` (v2.1.205+; output in `structured_output`) |
| system wrapper (arch §7) | `--append-system-prompt-file <path>` |
| model | `--model <alias|id>` |
| allowed tools | `--allowed-tools "Read,Edit,Bash(git *)"` |
| lock down MCP/host config | `--strict-mcp-config` + `--settings '<json>'` (+ `--setting-sources`) |
| non-interactive perms | `--permission-mode dontAsk` |
| native limits | `--max-turns <n>` `--max-budget-usd <n>` |
| instruction | **STDIN** (not a flag) |

Rate-limit event: `{"type":"system","subtype":"api_retry","error":"rate_limit","retry_delay_ms":…,"attempt":…}`.
Do NOT use `--bare` (breaks subscription auth — D6).
