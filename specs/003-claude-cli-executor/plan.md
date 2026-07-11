# Implementation Plan: claude_cli Executor

**Branch**: `003-claude-cli-executor` | **Date**: 2026-07-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/003-claude-cli-executor/spec.md`

## Summary

Add the first real `AgentExecutor` — `claude_cli` — that spawns one headless
`claude -p` process per run inside a dedicated git worktree, drives it on the
operator's Claude subscription, parses its `--output-format stream-json` event
stream incrementally, and extracts a `ReportSchema`-valid final report via the
`--json-schema` structured-output channel. Finalization reuses the mock's exact
path (`ExecutorResult.report` → `RunsService.finalizeWithReport` →
`PipelineService.onRunFinished`), so no pipeline, schema, or contract change is
required (FR-009, FR-024). The executor enforces timeout, cancellation, and
budget by terminating the whole process group; sanitizes the child environment
to an explicit allowlist with no `ANTHROPIC_API_KEY`; passes the instruction via
stdin (never argv); surfaces subscription rate limits as a distinct
`rate_limited` exit that the existing processor requeues without burning an
attempt. The binary is substitutable (`cliPath` config) so integration tests run
a fake CLI emitting recorded stream-json — the real CLI is exercised only by a
manual live-smoke gate.

## Technical Context

**Language/Version**: TypeScript strict (Node 22, `.nvmrc`), NestJS 11, BullMQ 5

**Primary Dependencies**: `node:child_process` (spawn, detached), `node:fs/promises`,
`node:readline` (NDJSON framing), git CLI (worktree), Claude Code CLI
(`claude`, v2.1.205+ for `--json-schema` structured output), zod (`@brigadir/contracts`),
drizzle (`@brigadir/database`)

**Storage**: Postgres 16 — existing `runs` + `run_events` columns cover every
value this feature writes (external_ref, worktree_path, exit_code, cost_usd,
usage, error, report, outcome). **No migration.** (data-model.md)

**Testing**: vitest unit (pure mappers, arg builder, env sanitizer, stream
parser); vitest integration with testcontainers (Postgres/Redis) driving a fake
CLI fixture through the real worker; manual live-smoke via `apps/smoke`.

**Target Platform**: worker on darwin (dev) and linux (docker). Process-group
termination and worktree code MUST work on both.

**Project Type**: NestJS monorepo — libs (`libs/executors`, `libs/runs`, …) +
apps (`apps/worker`, `apps/backend`, `apps/smoke`).

**Performance Goals**: not throughput-bound. One long-lived child per run;
global concurrency from `executor.concurrency`. Stream parsing must stay bounded
(sample/cap `run_events` and the stderr tail).

**Constraints**: subscription auth only (no API key in child env); secrets never
in argv; lazy resource resolution (no git/CLI/fs probing at module import or Nest
context init); live-smoke ≤ ~15 min (SC-001); 0 test dependency on the real CLI
(SC-007).

**Scale/Scope**: single real executor (`claude_cli`); single repository from the
workspace list; `anthropic_api`/`deepseek_api`/`claude_routines` remain
unimplemented behind the interface.

## Constitution Check

*GATE: re-checked after Phase 1 design — still PASS.*

| Principle | Status | How this plan satisfies it |
|---|---|---|
| I. Dual Source of Truth | ✅ | Run state stays in Postgres via `RunsService`; no third source. Cancellation is observed from the `runs` row (DB), not an ad-hoc channel. Redis holds only the BullMQ job. |
| II. Idempotency at 3 levels | ✅ | Unchanged. Enqueue still flows through `RunTriggerService` (webhook dedup → BullMQ dedup → `runs_one_active`). Worktree branch collision from a crashed prior run is handled at worktree-prep (D3), not by weakening any dedup layer. `maxStalledCount: 0` kept on the new processor. |
| III. System-Only Jira Writes | ✅ | Executor never touches Jira; the wrapper (arch §7) instructs the agent not to. Finalization → `PipelineService.onRunFinished` is the only Jira write path (unchanged). |
| IV. Run Completion Contract | ✅ | Report MUST validate against `ReportSchema`; invalid/absent → `failed` with diagnostics, no fabrication (FR-007/008). Uses the SAME `finalizeWithReport` gate as mock. Phase-0 report channel = `--json-schema` structured output (arch §4 "…--json-schema as fallback"; MCP `complete_task` arrives iteration 5). |
| V. Secret Isolation & Output Scrubbing | ✅ | Child env = explicit allowlist, no `ANTHROPIC_API_KEY` (FR-016/017, tested FR-019). Instruction via stdin, not argv (FR-018). `--strict-mcp-config` + explicit `--settings` so host config can't leak. Scrubber runs in the existing report/persistence path. |
| VI. Test-Mandatory Pipeline Logic | ✅ | Executor lifecycle, status mapping, env sanitization, stream parsing, rate-limit requeue, budget/timeout/cancel termination all ship with tests THIS iteration (FR-025), via the fake-CLI fixture. Mock suite stays green (FR-024/SC-002). |
| TC: Lazy resource resolution | ✅ | New `run.claude_cli` queue name is composition-time (static, documented — same rule as `run.mock`). All git/fs/spawn work happens inside `run()` at first execution, never in `@Module()` args or context init. `cliPath`/config resolved at run time. |

No violations → Complexity Tracking table omitted.

## Project Structure

### Documentation (this feature)

```text
specs/003-claude-cli-executor/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions D1–D15
├── data-model.md        # Phase 1 — "no schema change" note + field usage map
├── quickstart.md        # Phase 1 — fake-CLI test pattern + live-smoke gate
├── contracts/
│   ├── executor-config.md    # claude_cli config extension (agents.yaml)
│   └── cli-io.md             # CLI arg/env/stdin contract + stream-json events consumed
└── tasks.md             # Phase 2 (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
libs/executors/src/
├── agent-executor.interface.ts     # UNCHANGED (contract frozen — FR-001)
├── executor.registry.ts            # UNCHANGED (resolves by type)
├── executors.module.ts             # +ClaudeCliExecutor in AGENT_EXECUTORS factory
├── mock.executor.ts                # UNCHANGED
├── claude-cli/
│   ├── claude-cli.executor.ts      # AgentExecutor impl: orchestrates the 5 concerns
│   ├── claude-cli.config.ts        # zod for the claude_cli executor extras (cliPath, model, allowedTools, repository, keepFailedWorktrees)
│   ├── worktree.ts                 # prepare/cleanup git worktree (D3) — pure-ish, injectable
│   ├── process-group.ts            # detached spawn + group kill SIGTERM→SIGKILL (D2)
│   ├── env-allowlist.ts            # build sanitized child env (D6) — pure
│   ├── args.ts                     # build claude argv (D1/D7) — pure, no secrets
│   ├── stream-parser.ts            # incremental NDJSON → events/cost/report/rate-limit (D5/D13) — pure
│   └── *.spec.ts                   # unit tests for each pure module
packages/contracts/src/
└── agents-config.schema.ts         # ExecutorConfigSchema: typed claude_cli branch (D9)

apps/worker/src/
├── claude-cli-run.processor.ts     # @Processor('run.claude_cli') — mirrors run.processor.ts, real ctx
└── app.module.ts                   # register the new processor

libs/queues/src/queue.constants.ts  # error-classification backoff (already stubbed) — optional refine

test/
├── fixtures/claude-cli/            # recorded stream-json streams + fake `claude` script(s)
│   ├── fake-claude.mjs             # substitutable binary: replays a fixture to stdout, honors signals
│   ├── stream-success.ndjson       # result event w/ valid structured_output
│   ├── stream-invalid-report.ndjson
│   ├── stream-no-report.ndjson
│   ├── stream-rate-limit.ndjson    # system/api_retry error:"rate_limit"
│   └── stream-budget-exceeded.ndjson
└── integration/
    ├── claude-cli-lifecycle.spec.ts   # US1/US4: success/invalid/no-report + timeline + cost
    ├── claude-cli-security.spec.ts    # US2 (FR-019/SC-003): canary env + argv absence
    ├── claude-cli-limits.spec.ts      # US3 (SC-004): timeout/cancel/budget → group killed, 0 orphans
    └── claude-cli-rate-limit.spec.ts  # US5 (SC-006): rate_limited requeues, attempt not spent
```

**Structure Decision**: Extend the existing NestJS monorepo. The executor lives
in `libs/executors/src/claude-cli/` decomposed into small pure modules (args,
env, stream-parser, worktree, process-group) so each is unit-testable without a
process, and the thin `ClaudeCliExecutor` wires them inside `run()`. The worker
gets a second processor bound to the `run.claude_cli` queue (one queue per
executor type — existing pattern); the config-driven `QueuesModule.register()`
already creates `run.<type>` for every declared executor, so declaring a
`claude_cli` executor in `agents.yaml` auto-provisions its queue.

## Phase Breakdown

- **Phase 0 — Research** (`research.md`): resolve the 5 priorities into decisions
  D1–D15 with verified flag names. **DONE** (see research.md).
- **Phase 1 — Design & Contracts** (`data-model.md`, `contracts/`, `quickstart.md`):
  confirm no schema change; freeze the config extension and the CLI I/O contract;
  document the fake-CLI test pattern and the live-smoke DoD gate. **DONE.**
- **Phase 2 — Tasks** (`/speckit-tasks`, not this command): derive dependency-ordered
  tasks. Expected grouping:
  1. Config: typed `claude_cli` branch in `ExecutorConfigSchema` + fixtures + validation tests (US6, FR-022/023).
  2. Pure modules + unit tests: `args`, `env-allowlist`, `stream-parser`, `worktree`, `process-group` (FR-002/003/010/014/016–018).
  3. `ClaudeCliExecutor.run()` composition + `healthCheck()` (lazy) (FR-001/006).
  4. Worker `claude-cli-run.processor.ts` building the real `RunContext` + module wiring (FR-009).
  5. Integration: lifecycle/report (US1), security (US2), limits+group-kill (US3), streaming/cost (US4), rate-limit (US5) — all via fake CLI (FR-025, SC-002/003/004/005/006/007).
  6. Live-smoke extension of `apps/smoke` for the manual DoD gate (FR-026, SC-001).
```
