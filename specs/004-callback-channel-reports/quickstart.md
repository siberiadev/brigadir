# Quickstart & Validation: Callback Channel & Reports

How to prove Feature 004 works end-to-end. Everything runs against **real Postgres + Redis
(testcontainers)** and hits the **real callback HTTP API** — no mocked broker, no live agent CLI, no
subscription (Constitution VI; SC-009).

## Prerequisites

- Docker running (testcontainers; see `test/integration/global-setup.ts`).
- `pnpm install && pnpm build` (builds `packages/mcp-server` bin `brigadir-mcp` + `stop-hook`).
- Env for the suite: `BRIGADIR_JWT_SECRET` (test value), `DATABASE_URL`/`REDIS_URL` provided by the
  harness containers.

## Commands

```bash
pnpm typecheck && pnpm lint && pnpm test          # static + unit (schemas, JWT sign/verify, scrubber, wrapper, args)
pnpm test:integration                             # full callback flows (below)
```

---

## The fake-CLI-with-callbacks pattern (the core new test shape)

Iteration 3's fake CLI (`test/fixtures/claude-cli/fake-claude.mjs`) streams a recorded ndjson fixture
to stdout. Feature 004 extends the harness so the fake CLI also acts as the **agent making
callbacks**: it reads the run token + callback URL **from its own (server-side) env** — exactly where
the real MCP config's `env` block would put them (research D1) — and `POST`s to the live callback API,
then exits.

Two equivalent ways to drive callbacks in tests:

1. **Fake CLI calls the HTTP API directly** using `BRIGADIR_RUN_TOKEN` / `BRIGADIR_CALLBACK_URL` from
   its env (simplest; proves the guard + endpoints). This is the primary pattern.
2. **Fake CLI spawns the real `brigadir-mcp`** via the generated mcp-config (proves the stdio binding
   + marker write end-to-end). Used by at least one binding test.

Key harness additions (mirroring iteration 3's env-only control channel):
- The executor, when `useCallbackChannel` is set, mints a real JWT, writes the `0600` mcp-config, and
  registers the Stop hook — so the fake CLI receives the token the same way a real `claude` would.
- New `FAKE_CLAUDE_*` control vars (added to the env allowlist, like the existing ones) tell the fake
  CLI **which callbacks to make** (e.g. a scripted sequence: `progress`, then `complete{success}`).

> Security assertion reused from iteration 3: the fake CLI dumps its argv/env; the test asserts the
> **run token never appears in argv** and (for the mcp-config binding) never in the agent-visible env
> — only in the MCP child's env. This is the automated form of research D1.

---

## Validation scenarios (map to user stories & SCs)

Reference the contracts for exact payloads: [callback-http-api](./contracts/callback-http-api.md),
[run-jwt](./contracts/run-jwt.md), [mcp-config](./contracts/mcp-config.md),
[stop-hook-settings](./contracts/stop-hook-settings.md).

| # | Scenario | Setup → Action → Assert | Covers |
|---|---|---|---|
| 1 | **Completion success** | Fake CLI `POST /complete {outcome:success}` with valid token → run `succeeded`, `run_checks` rows persisted, ticket transitioned, 200. | US1 / FR-007 / SC-001 |
| 2 | **Invalid report** | `POST /complete` with `needs_human` but no `human_task` → 422 + zod `errors[]`, run **not** finalized. | US1 / FR-008 |
| 3 | **Idempotent completion** | Two `POST /complete` for one run → first wins, second **409**. | US1 / FR-009 / SC-007 |
| 4 | **Fail-closed** | Fake CLI exits calling **nothing** → run finalized `failed` with diagnostic; any final stdout text retained as diagnostics only, never rescues. | US1 / FR-010/011 / SC-002 |
| 5 | **Token rejection** | Call with a token for a different run / expired / finalized run → 401/409, nothing persisted. | US1 / FR-003 / SC-004 |
| 6 | **Blocking escalation → resume → completion (E2E, required)** | Attempt#1 `POST /human {blocking:true}` then exits → human_task open, run `awaiting_human`, ticket Blocked. Resolve `action=resume` via API → old run `superseded`, new attempt (attempt+1) is the **only** active run, ticket → running. Attempt#2 reads the answer from context, `POST /complete` → `succeeded`. Assert ≤1 active run per (ticket,agent) throughout. | US2 / FR-012/016/017/018 / SC-003 |
| 7 | **done_manually / dismiss** | Resolve blocking task with `done_manually` or `dismiss` → task closed, run stays closed, **no** new attempt, **no** auto Jira transition. | US2 / FR-019 |
| 8 | **Progress + non-blocking note** | Two `POST /progress` then `complete` → both on timeline, run still finalizes. Separately `POST /human {blocking:false}` then `complete` → task exists, run `succeeded` (not parked). | US3 / FR-021/014 |
| 9 | **PR review task** | PR-delivery agent completes `success` with `artifacts.pr_url` → one **non-blocking** `kind=review` task referencing the PR; **zero** merges/extra transitions. | US4 / FR-025 / SC-008 |
| 10 | **Secret scrubbing** | Report summary/check-reason + human-task details carry planted secret-shaped strings → persisted rows and Jira-bound comment contain redactions; no original secret survives. | US5 / FR-024 / SC-005 |
| 11 | **Feature-context wrapper** | Ticket under an epic with a linked issue whose prior run's report declared branch+PR → compiled wrapper lists epic + linked issue with status + the branch/PR; respects the ~2 KB / 20-issue budget. | US6 / FR-026 |
| 12 | **Stop-hook boundedness** (unit/harness) | `stop-hook.js`: marker absent + `stop_hook_active=false` → block; `stop_hook_active=true` → allow; marker present → allow. | FR-022/023 |
| 13 | **Channel selection explicit** | `useCallbackChannel=false` run → `--json-schema` present, structured_output path unchanged (feature-003 lifecycle tests stay green). `=true` run → no `--json-schema`, mcp-config + Stop hook written. | FR-011 / D6 |

---

## Manual smoke (optional, no UI this iteration)

Answering human tasks is via API/curl this iteration (Tasks UI is iteration 6, out of scope). Resolve
a blocking task:

```bash
curl -X POST http://localhost:3000/api/human-tasks/<taskId>/resolve \
  -H 'content-type: application/json' \
  -d '{ "action": "resume", "answer": "Use API token auth.", "resolved_by": "op@team" }'
```
Expect: old run `superseded`, a new attempt `queued`, ticket in the running status.
