# Quickstart — Validating the claude_cli Executor

Two lanes: **automated** (fake CLI, no subscription — the CI truth) and the
**manual live-smoke DoD gate** (real CLI, operator machine). All automated lanes
follow the existing testcontainers + real-worker pattern
(`test/integration/scenarios.spec.ts`).

## Prerequisites

- Docker running (testcontainers; shared containers per run —
  `test/integration/global-setup.ts`).
- `pnpm install`.
- No real `claude` and no subscription for the automated lanes (SC-007).

## The fake-CLI test pattern (D8)

`test/fixtures/claude-cli/fake-claude.mjs` is a substitutable `claude`. A test
points the executor at it via config `cliPath`, selects a recorded stream via an
allowlisted env var, and drives a real run through the worker:

1. Seed a pipeline (`seedPipeline`) with an agent whose executor is
   `type: claude_cli`, `cliPath: <abs path to fake-claude.mjs>`.
2. `trigger.trigger({ ticketId, agentId, triggerEvent: { source:'manual', … } })`.
3. Poll the `runs` row to a terminal status; assert.

The fake CLI:
- streams the chosen `*.ndjson` line-by-line with small delays (proves
  incremental parsing, FR-010);
- writes its own `process.env` to a temp file (proves env sanitization, FR-019);
- can `spawn` a child and sleep (proves process-group kill, SC-004);
- honors SIGTERM/SIGKILL.

Recorded fixtures: `stream-success` (valid `structured_output`),
`stream-invalid-report`, `stream-no-report`, `stream-rate-limit`
(`system/api_retry error:"rate_limit"`), `stream-budget-exceeded` (D11 REVISED — terminal-event cost only, no mid-stream USD).

## Automated scenarios → spec mapping

| Lane (spec) | Fixture / setup | Assert |
|---|---|---|
| US1 success (SC-005) | `stream-success` | run `succeeded`; `report` persisted; `worktree_path` set then removed; branch `= prefix/ticketKey` gone after run |
| US1 invalid report (SC-005) | `stream-invalid-report` | run `failed`; diagnostic in `error`; `report` null; **no fabricated outcome** |
| US1 no report | `stream-no-report` | run `failed` with diagnostic |
| US2 security (FR-019/SC-003) | canary `ANTHROPIC_API_KEY`+secrets in worker env | env dump file: 0 secrets; argv (from fake CLI) : 0 secrets |
| US3 timeout | fake sleeps past `timeout_minutes` | `timed_out`; child + grandchild gone (0 orphans) |
| US3 cancel | flip `runs.status` off `running` mid-run | `cancelled`; group killed; a late `stream-success` does NOT revive it |
| US3 budget (SC-004) | `stream-budget-exceeded` (terminal `total_cost_usd` over `max_budget_usd`, D11 REVISED) | `failed` budget diagnostic; no surviving processes |
| US4 streaming | `stream-success` | `run_events` timeline in order (log/tool_call/progress); `cost_usd`+`usage` on run; stderr tail retained |
| US5 rate limit (SC-006) | `stream-rate-limit` | distinct `rate_limited`; job requeued; **attempt not incremented**; run stays active |
| US6 coexistence (SC-002) | mock + claude_cli in config | both validate/resolve; full mock suite green |

Orphan check (SC-004): after finalize, assert the recorded child pid(s) are gone
(`process.kill(pid,0)` throws `ESRCH`).

Run automated lanes:
```
pnpm typecheck && pnpm lint && pnpm test          # unit (args/env/parser/worktree/mapping)
pnpm test:integration                              # fake-CLI lanes above
```

## Manual live-smoke DoD gate (SC-001, FR-026) — operator machine only

Analogous to iteration 2's live-smoke helper; extends `apps/smoke`. Requires a
logged-in Claude subscription (`claude` on PATH, `~/.claude` auth) and a real
throwaway ticket + repo. NOT part of `pnpm test` (SC-007).

1. Log in the CLI once: `! claude` (interactive) or `claude setup-token`.
2. Configure a `claude_cli` agent in `agents.yaml` pointing at a scratch repo.
3. `pnpm smoke:claude -- --ticket <KEY>` (new script) → triggers one real run.
4. **Also pin the D1 residual here on first run:** confirm the terminal
   `result` event of `stream-json --json-schema` carries `structured_output`;
   if not, switch to the `result.result`-text fallback (research D1).

**Pass:** within ~15 min the run ends with a schema-valid report, the ticket
transitions per the agent's success/failure status, and the worktree is cleaned
(or kept iff failed + `keepFailedWorktrees`).
