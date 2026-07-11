---
description: "Task list for Callback Channel & Reports — the agent's voice becomes MCP tools"
---

# Tasks: Callback Channel & Reports

**Input**: Design documents from `/specs/004-callback-channel-reports/`
**Prerequisites**: plan.md, spec.md, research.md (D1–D9), data-model.md, contracts/ (callback-http-api, mcp-config, stop-hook-settings, run-jwt), quickstart.md

**Organization**: Phases follow plan.md's phase breakdown. The shared spine — run-token signer, `brigadir-mcp` package, fake-CLI callback mode, scrubber, the guarded callback HTTP API, the human-task service, and the `claude_cli` callback-channel wiring — is genuinely **Foundational**: every story's integration test drives the *same* callback API through it. Story phases are then mostly their dedicated integration tests plus that story's own logic. Story labels map to spec.md: **US1** completion + fail-closed (P1, MVP), **US2** blocking question → human answer → resume (P1), **US3** progress + non-blocking notes (P2), **US4** PR-review task (P2), **US5** secret scrubbing (P2), **US6** wrapper feature context (P3).

**Task IDs continue from T092** (iteration 3 ended at T090; T091 live-smoke and T092 journal are still pending and unrelated). This iteration is **T093–T118**.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable — different files, no dependency on an incomplete task in the same/earlier phase
- **[Story]**: US1–US6 where the task serves a specific user story; setup/foundational/DoD tasks carry no story label
- Every task names its **Verify:** step (command or concrete check)

## Path Conventions

Monorepo root = repository root. New code this iteration: `packages/contracts/src/run-token.ts`, `packages/mcp-server/` (new workspace package, bin `brigadir-mcp`), `libs/callback/`, `libs/human-tasks/`, `libs/scrubber/`, `libs/executors/src/claude-cli/` (extended), `apps/backend/src/app.module.ts` (extended), `apps/worker/src/claude-cli-run.processor.ts` (extended), `libs/jira/src/` (bounded feature-context read), `test/fixtures/claude-cli/`, `test/integration/`. **No DB migration** (data-model.md — every value maps to an existing column in architecture §3).

**Pinned by live probes (research D1/D2, CLI v2.1.207, 2026-07-11):** the Bash tool inherits `claude`'s process env, so **no `${VAR}` interpolation path may exist anywhere** — the run token is a literal in the `0600` mcp-config `env` block, reaching only the MCP child (probe B). Stop hooks **fire in `-p` print mode** and the hook **must honor `stop_hook_active` as the FR-023 bound**.

---

## Phase 1: Setup — Contracts, MCP Server Package, Fake-CLI Callback Mode

**Goal**: the token signer, the standalone `brigadir-mcp` binary, and the fake-CLI callback mode exist and work in isolation, so every later callback integration test (Phases 3–8) has a way to authenticate and to drive callbacks. **⚠️ Blocks every callback integration test in this feature.**

- [ ] T093 [P] Add the run-token signer/verifier to `packages/contracts/src/run-token.ts` (D4 — **node built-in `crypto` only, no new dependency**): export `RunTokenClaims` (`{ sub, wsp, tkt, iat, exp }`), `signRunToken(claims: Omit<RunTokenClaims,'iat'>, secret): string` (HS256, standard `base64url(header).base64url(payload).sig`), `verifyRunToken(token, secret): RunTokenClaims` (throws on bad signature or expired `exp`). Export from `packages/contracts/src/index.ts`. **Verify**: unit test `run-token.spec.ts` — round-trip (sign→verify returns the same claims); a token past `exp` throws; a token signed with a different secret throws (wrong signature); tampering with the `sub` payload without re-signing throws; `node -e "require('crypto')"`-only (grep the file for `jsonwebtoken`/`jose` → 0 matches).
- [ ] T094 [P] Scaffold the new workspace package `packages/mcp-server` (bin `brigadir-mcp`): `package.json` (name `@brigadir/mcp-server`, `bin`, depends on `@modelcontextprotocol/sdk` + `@brigadir/contracts`, **no `@brigadir/database` / DI / DB deps — zero DB access**), `tsconfig`, and build wiring so `dist/main.js` + `dist/stop-hook.js` are produced. Add the package to `pnpm-workspace.yaml` coverage (already globs `packages/*`) and to the root build. **Verify**: `pnpm install` exits 0; `pnpm --filter @brigadir/mcp-server build` produces `dist/main.js` and `dist/stop-hook.js`; `node -e "require('@brigadir/database')"` is **not** resolvable from this package (grep `package.json` deps → no `@brigadir/database`).
- [ ] T095 [P] Implement the `brigadir-mcp` stdio server in `packages/mcp-server/src/{main.ts,tools.ts,marker.ts}` + `stop-hook.ts` per contracts/mcp-config.md & contracts/stop-hook-settings.md: a stdio MCP server named `brigadir` exposing `report_progress` / `request_human` / `complete_task` (arg schemas imported from `@brigadir/contracts`), each handler `POST`ing to `$BRIGADIR_CALLBACK_URL/runs/$BRIGADIR_RUN_ID/{progress,human,complete}` with `Authorization: Bearer $BRIGADIR_RUN_TOKEN` from **its own env** (never argv); **bounded retries (D9): retry ≤3 with backoff on 5xx/network only, NEVER retry 4xx**; the API error body (422 zod issues / 409 / 401) is returned to the model as a tool error (FR-006/008 repair loop). On a 2xx of `complete_task` or blocking `request_human`, write `$BRIGADIR_MARKER_PATH` (marker, D8). `stop-hook.ts`: read the hook-event JSON from stdin, `exit 0` if the marker file exists **or** `input.stop_hook_active === true` (the FR-023 bound), else emit `{"decision":"block","reason":"You must call mcp__brigadir__complete_task … or request_human before finishing."}`. **stdout = MCP protocol only; all logs to stderr.** **Verify**: unit tests `tools.spec.ts` with a faked HTTP layer — a 200 returns success to the caller and (for complete/blocking-human) writes the marker file; a 500 then 200 succeeds after one retry; a 422 returns the error body with **zero** retries; a network error retries up to the bound then surfaces; `stop-hook.spec.ts` — marker absent + `stop_hook_active:false` → block JSON; `stop_hook_active:true` → exit 0 no block; marker present → exit 0 no block.
- [ ] T096 [P] Extend the fake CLI (`test/fixtures/claude-cli/fake-claude.mjs`) with a **callback mode** per quickstart.md and add helpers to `test/integration/claude-cli-harness.ts`: when a new allowlisted control var (e.g. `FAKE_CLAUDE_CALLBACKS`) is set, the fake CLI (a) **reads the `--mcp-config` file it was given**, extracts `BRIGADIR_RUN_TOKEN` / `BRIGADIR_CALLBACK_URL` / `BRIGADIR_RUN_ID` from the server `env` block, (b) makes the scripted sequence of real HTTP callbacks (e.g. `progress` then `complete{success}`, or `human{blocking:true}` then exit) against the live callback API with that token, and (c) continues to **dump its own `process.env`** so a test can assert the run token is **NOT** present in the agent-process env (the automatable half of D1 — probe B proved the claude-internal half; live smoke re-confirms it). Register the new `FAKE_CLAUDE_*` var(s) in `libs/executors/src/claude-cli/env-allowlist.ts` and clear them in `resetFakeClaudeEnv()`. **Verify**: running `fake-claude.mjs` standalone with a hand-written mcp-config + a stub HTTP endpoint performs the scripted callbacks with the token from the file's env block and writes an env-dump whose keys do **not** include `BRIGADIR_RUN_TOKEN`.

**Checkpoint P1**: `pnpm --filter @brigadir/contracts test` (run-token) and `pnpm --filter @brigadir/mcp-server test` (tools + stop-hook) green standalone; the fake CLI performs callbacks from an mcp-config file with no worker/DB involved. **STOP** — do not start Phase 2 until these pass.

---

## Phase 2: Foundational — Scrubber, Guard, Callback API, Human-Task Service, Executor Callback Wiring

**Goal**: the callback HTTP API is live and guarded, free-text is scrubbed, human tasks can be created, and the `claude_cli` executor can wire a real run onto the callback channel behind `useCallbackChannel` — the shared spine every story exercises. **⚠️ Blocks all user-story phases.**

- [ ] T097 [P] Add `useCallbackChannel` (boolean, default false) to the `claude_cli` branch of `ExecutorConfigSchema` in `packages/contracts/src/agents-config.schema.ts` and resolve it in `libs/executors/src/claude-cli/claude-cli.config.ts` (D6 — **explicit config, not implicit magic**). Also add the backend/worker env contract for `BRIGADIR_JWT_SECRET` (no silent default — absent secret is a boot error; resolved in a DI factory, never at `@Module()` composition — Constitution lazy-resolution). **Verify**: unit test — config with `useCallbackChannel:true` parses and resolves true; omitted → false; feature-003 config fixtures still parse unchanged.
- [ ] T098 [P] Implement the secret scrubber in `libs/scrubber/src/scrubber.ts` (FR-024, reuses/extends the iteration-3 known-secret pattern posture): `scrub(text: string): string` redacting known token/key patterns (e.g. `sk-…`, `ghp_…`, `AKIA…`, bearer/JWT-shaped, `*_TOKEN`/`*_SECRET` assignments) plus a **Shannon-entropy** heuristic for long high-entropy substrings, replacing each hit with a redaction marker. Pure, no I/O. **Verify** *(mandatory dedicated — task (g))*: unit test `scrubber.spec.ts` — a corpus with planted `ANTHROPIC_API_KEY`-shaped, `ghp_`-shaped, AWS-key-shaped, and a random 40-char high-entropy string are all redacted; ordinary prose (including code identifiers and URLs without secrets) is left intact (no false-positive redaction of `https://example.com/BRIG-123`); the original secret substring never appears in the output.
- [ ] T099 Implement the callback auth guard in `libs/callback/src/run-token.guard.ts` (FR-003, contracts/run-jwt.md): `verifyRunToken` (signature + `exp`) → `claims.sub === :runId` path param → DB re-read requiring run `status ∈ {running, awaiting_human}`; map failures to 401 (bad/expired/mismatched) and 409 (run not in acceptable state). Secret from `BRIGADIR_JWT_SECRET` via DI factory (T097). **Verify**: covered end-to-end by the US1 auth-matrix (T105); add a focused unit/spec here asserting each rejection maps to the right status and that a valid token for a `running` run passes.
- [ ] T100 Implement `libs/callback/` (`CallbackModule`) and mount it in `apps/backend/src/app.module.ts`: controller with `POST /api/callbacks/runs/:runId/{progress,human,complete}` (guarded by T099); service wiring per contracts/callback-http-api.md — `progress` → **scrub message** → `run_events(type='progress')` + `job.updateProgress()` + SSE; `human` → **scrub title/details** → delegate to `HumanTaskService` (T101); `complete` → validate `ReportSchema` (422 + zod `issues` on failure, run **not** finalized) → **scrub report free-text** → `RunsService.finalizeWithReport` → `PipelineService.onRunFinished` (idempotent 409 on already-finalized). Scrubbing at this boundary (before persist) covers downstream Jira writes too, since the ADF comment is built from the stored, already-scrubbed report. **Verify**: `pnpm nest build backend` exits 0; a light integration test drives one valid `complete{success}` (→ `succeeded`, checks persisted, 200) and one invalid `complete` (needs_human without human_task → 422, run untouched). Static check: no callback path reads the DB except through `RunsService`/`PipelineService`/guard; agents never touch Jira directly (Principle III).
- [ ] T101 Implement `libs/human-tasks/` (`HumanTaskModule`) `HumanTaskService.createFromRequest(runId, input)` (FR-012/014/015/020): create a `human_tasks` row (kind/title/details/blocking, run/ticket/workspace assoc), **deduped to one open task per run** (reuse the existing `WHERE run_id AND status='open'` guard); **blocking=true** → park run `awaiting_human` (guarded UPDATE) + transition ticket to the agent's failure/blocked status + post the (scrubbed) question as an ADF comment via `PipelineService`/`JiraClient`; **blocking=false** → create task only, run stays `running`. Return the "you may finish without complete_task" signal for blocking. **Verify**: integration coverage lands in US2/US3; add a focused test here — blocking create parks the run + one open task + a Jira transition/comment happened; a second blocking create for the same run does not add a second open task (FR-020 guard).
- [ ] T102 Add `RunsService.failIfStillRunning(runId, diagnostic)` in `libs/runs/src/runs.service.ts` (D7 — guard **`WHERE status = 'running'` only**, NOT the full active set) and wire the `claude_cli` processor (`apps/worker/src/claude-cli-run.processor.ts`) so that for a **callback-wired** run (`useCallbackChannel`) a process exit with no completion callback calls it (fail-closed, FR-010/011) — an `awaiting_human` (blocking escalation) or already-finalized run is a **0-row no-op**, never clobbered. Any final stdout text is retained as `error`/diagnostics only, never a finalize source (FR-011). **Verify**: unit test — `failIfStillRunning` flips a `running` run to `failed`; is a no-op on `awaiting_human`, `succeeded`, `superseded`. (End-to-end no-clobber is the mandatory T109.)
- [ ] T103 Wire the `claude_cli` executor for the callback channel behind `useCallbackChannel` (D1/D6/D8), additive — feature-003 behavior unchanged when the flag is off. New `libs/executors/src/claude-cli/mcp-config.ts`: write a `0600` mcp-config file **outside the worktree** with the server `env` block carrying the **literal** run token (**never `${VAR}`** — D1), `BRIGADIR_CALLBACK_URL`, `BRIGADIR_RUN_ID`, `BRIGADIR_MARKER_PATH`; build the Stop-hook `--settings` JSON (marker path baked into the hook command); delete both (and the marker) at cleanup. New/extended `libs/executors/src/claude-cli/wrapper.ts`: replace the Phase-0 "return JSON" section with the MCP-tools section (the three `mcp__brigadir__*` tools as the ONLY voice). Change `args.ts`: when `useCallbackChannel`, **drop `--json-schema`**, append the three `mcp__brigadir__*` names to `--allowed-tools`, and pass the Stop-hook `--settings` instead of `{}`. Executor mints the JWT (T093, secret from env) into `RunContext.callback.runToken` and passes the callback base URL; the worker processor builds the real `RunContext.callback` (replacing the `'claude-cli-run-token'` placeholder). **Verify**: `pnpm --filter @brigadir/executors build` exits 0; unit tests — with `useCallbackChannel:true` the argv contains **no** `--json-schema`, contains the three `mcp__brigadir__*` allowed-tools and `--strict-mcp-config`, and the built argv contains **no** token value (grep canary); the written mcp-config is mode `0600`, sits outside the worktree, and its `env.BRIGADIR_RUN_TOKEN` is a literal (no `${` anywhere); with the flag **off**, argv is byte-for-byte the iteration-3 shape (`--json-schema` present).

**Checkpoint P2**: `pnpm typecheck && pnpm lint && pnpm test` green; `CallbackModule` + `HumanTaskModule` mounted; the callback API answers a guarded `complete`; feature-003 executor/lifecycle unit tests untouched and green (channel selection is explicit config). **STOP** — do not start story phases until green.

---

## Phase 3: User Story 1 — Completion & fail-closed (P1) 🎯 MVP

**Goal**: `complete_task` is the single normal exit — schema-valid report finalizes the run and drives Jira; invalid reports are rejected for repair; a silent exit fails closed; duplicate/mismatched credentials are rejected.

**Independent Test** (spec.md): fake CLI (callback mode, T096) submits a schema-valid report with its run token → run `succeeded`, checks persisted, ticket transitioned; a run that calls nothing → `failed` with a diagnostic.

- [ ] T104 [US1] Integration test `test/integration/callback-completion.spec.ts` (real backend+worker+DB/Redis via testcontainers, fake CLI in callback mode hitting the **real** callback API): **success** — `complete{outcome:success}` → run `succeeded`, `run_checks` rows persisted, ticket transitioned, tool ACK 200; **invalid** — `complete{needs_human}` with no `human_task` → 422 with zod `errors[]`, run **not** finalized (agent can repair); **fail-closed** — fake CLI exits calling **nothing** → run finalized `failed` with a diagnostic, and any final stdout text is retained as diagnostics only and never rescues the run (FR-010/011). **Verify**: `pnpm test:integration test/integration/callback-completion.spec.ts` green (FR-007/008/010/011; SC-001/002).
- [ ] T105 [US1] **[Mandatory — auth matrix, task (a)]** Integration test `test/integration/callback-auth.spec.ts` (FR-003, SC-004): a token minted for **another run** → rejected, nothing persisted; an **expired** token → rejected; a token for a run **already finalized** (`succeeded`/`failed`/`cancelled`/`superseded`) → rejected; a well-formed token whose run is legitimately `awaiting_human` → **accepted** (the acceptable-state case). Assert each rejection persists **zero** state changes. **Verify**: `pnpm test:integration test/integration/callback-auth.spec.ts` green.
- [ ] T106 [US1] **[Mandatory — completion idempotency, task (b)]** Integration test `test/integration/callback-idempotency.spec.ts` (FR-009, SC-007): two `complete` calls for one run → the first wins (run finalized once, checks written once), the second returns **409** and does not mutate the finalized row or double-write checks; a late `complete` arriving after cancel/timeout/supersede → 409. **Verify**: `pnpm test:integration test/integration/callback-idempotency.spec.ts` green.

**Checkpoint P3 — MVP**: the completion contract is closed — exactly one live channel, fail-closed on silence, idempotent, credential-guarded. **STOP** and validate US1 independently.

---

## Phase 4: User Story 2 — Blocking question → human answer → resume (P1)

**Goal**: a blocking `request_human` parks the run and queues a person; answering with `resume` supersedes the parked run and creates a new attempt (single transaction, single active run) that reads the answer and completes; `done_manually`/`dismiss` close without a new attempt.

**Independent Test** (spec.md, the required E2E): attempt#1 `request_human{blocking:true}` then exits → human task open, run `awaiting_human`, ticket blocked; resolve `resume` → old run `superseded`, new attempt is the only active run, ticket running; attempt#2 reads the answer, `complete` → `succeeded`.

- [ ] T107 [US2] Implement resolve/resume in `libs/human-tasks/src/resume.service.ts` + a resolve endpoint (`POST /api/human-tasks/:id/resolve`, action `resume|done_manually|dismiss`): **resume** — in **one DB transaction** close the parked run as `superseded` and insert a new run `attempt+1` (honoring the `runs_one_active` partial unique index — supersede must land before/within the insert), then enqueue after commit and transition the ticket to the **running** status (never back through the trigger status); write the human's answer into the new run's `trigger_event` (`source:'human-resume'`, `resolution`) so the new attempt's wrapper injects it (FR-016/017/018). **done_manually / dismiss** — close the task + parked run, **no** new attempt, **no** automated ticket transition (FR-019). All three set `resolved_at`/`resolved_by`. **Verify**: unit/light-integration — resume produces exactly one active run (old `superseded`, new `queued`); attempting the resume when a conflicting active run exists surfaces the `runs_one_active` guard rather than creating a second active run; `done_manually`/`dismiss` create no run and no transition.
- [ ] T108 [US2] **[Mandatory — required E2E, task (c)]** Integration test `test/integration/callback-resume-e2e.spec.ts`: full loop with the fake CLI in callback mode — attempt#1 `human{blocking:true}` → exits; assert one open blocking human task, run `awaiting_human`, ticket in the blocked status with a comment carrying the question. Resolve via the API with `action=resume` + an answer; assert old run `superseded`, new attempt (`attempt=2`) is the **only** active run for `(ticket, agent)` (assert `runs_one_active` holds at every step), ticket in the running status. Attempt#2 reads the answer from its context and `complete{success}` → `succeeded`. **Verify**: `pnpm test:integration test/integration/callback-resume-e2e.spec.ts` green (FR-012/013/016/017/018; SC-003).
- [ ] T109 [US2] **[Mandatory — D7 no-clobber, task (d)]** Integration test `test/integration/callback-awaiting-human-noclobber.spec.ts`: fake CLI calls blocking `request_human` then the **process exits** (legitimate exit, FR-013); assert the processor's fail-closed path (T102) is a **no-op** — the run stays `awaiting_human` and is **not** flipped to `failed`. Contrast with a run that exits calling nothing (stays `running` → `failed`). **Verify**: `pnpm test:integration test/integration/callback-awaiting-human-noclobber.spec.ts` green (FR-010 vs FR-012 seam, D7).
- [ ] T110 [US2] **[Mandatory — needs_human dedup, task (e)]** Integration test `test/integration/callback-human-dedup.spec.ts` (FR-020): a run that already has an open human task (from a blocking `request_human`) then somehow reaches a `needs_human` completion path, and a run receiving two `request_human` calls, each end with **at most one** open human task per run. **Verify**: `pnpm test:integration test/integration/callback-human-dedup.spec.ts` green.

**Checkpoint P4**: the escalation → resume lifecycle is proven end-to-end with the single-active-run guarantee intact throughout. **STOP** and validate US2 independently.

---

## Phase 5: User Story 3 — Progress & non-blocking notes (P2)

**Goal**: `report_progress` lands ordered timeline events and updates progress without changing status; non-blocking `request_human` queues a note without parking the run.

**Independent Test** (spec.md): two `report_progress` then `complete` → both events on the timeline, run still finalizes; `request_human{blocking:false}` then `complete` → task exists, run `succeeded` (not parked).

- [ ] T111 [US3] Integration test `test/integration/callback-progress.spec.ts`: fake CLI emits two `report_progress` (distinct stages) then `complete{success}` → both land as ordered `run_events(type='progress')`, `job.updateProgress` reflects the latest, run finalizes `succeeded` (FR-021, SC-006 ordered timeline); separately, `request_human{blocking:false}` then `complete{success}` → one open non-blocking human task exists **and** the run reached `succeeded` (the note did not park it, FR-014). **Verify**: `pnpm test:integration test/integration/callback-progress.spec.ts` green.

**Checkpoint P5**: progress visibility and non-blocking escalation proven without derailing completion.

---

## Phase 6: User Story 4 — PR-review task on successful PR delivery (P2)

**Goal**: a successful run under a `code_delivery=pull_request` agent whose report declares a PR queues exactly one non-blocking `kind=review` task; the orchestrator never merges.

**Independent Test** (spec.md): PR-delivery agent completes `success` with `artifacts.pr_url` → one non-blocking review task referencing the PR, zero merges/extra transitions.

- [ ] T112 [US4] **[Mandatory — PR review, task (f)]** Implement the review-task branch in the `complete` service (T100): when the agent's delivery mode is `pull_request` and `outcome=success` with `artifacts.pr_url`, create a **non-blocking** `kind=review` human task carrying the PR reference; **never** merge or transition beyond the success transition. Integration test `test/integration/callback-pr-review.spec.ts`: assert exactly **one** non-blocking review task referencing the PR is created, the run stays `succeeded`, and no merge/extra transition occurred; a success with no `pr_url`, or a non-PR-delivery agent, creates **no** review task. **Verify**: `pnpm test:integration test/integration/callback-pr-review.spec.ts` green (FR-025, SC-008).

**Checkpoint P6**: the "feature finishes = queue a merge review" gap is closed with humans still owning the merge.

---

## Phase 7: User Story 5 — Secret scrubbing at the run boundary (P2)

**Goal**: every free-text field the agent sends is scrubbed before it is persisted and before any Jira write.

**Independent Test** (spec.md): report + human-task detail carrying planted secrets → persisted rows and the Jira-bound comment contain redactions; no original secret survives.

- [ ] T113 [US5] Integration test `test/integration/callback-scrubbing.spec.ts` (FR-024, SC-005): submit a `complete` report whose `summary` and a check `reason` carry planted secret-shaped strings, and a `request_human{blocking:true}` whose `details` carries one; assert the persisted `runs.report`, `run_checks.reason`, and `human_tasks.details` rows contain redactions, and the Jira-bound ADF comment text (captured via the integration mock-jira) is the **scrubbed** copy — no original secret survives anywhere. **Verify**: `pnpm test:integration test/integration/callback-scrubbing.spec.ts` green (0 leaks across the corpus).

**Checkpoint P7**: the scrubber holds at every point the agent's words leave the run boundary.

---

## Phase 8: User Story 6 — Wrapper feature context (P3)

**Goal**: the instruction wrapper includes the ticket's epic and linked issues with statuses, plus branches/PR URLs extracted from previous runs' reports on those linked issues — within a hard size budget.

**Independent Test** (spec.md): ticket under an epic with a linked issue that has a prior run declaring branch+PR → compiled wrapper lists the epic, the linked issue + status, and the branch/PR.

- [ ] T114 [US6] Add a **bounded** feature-context read to the Jira surface: extend `libs/jira/src/jira-client.interface.ts` + `basic-auth-jira.client.ts` (and `test/integration/mock-jira.ts`) with `getFeatureContext(issueKey): Promise<{ epic?: {key,status}; linked: {key,status,summary}[] }>` — statuses only, no bodies/comments. **Verify**: unit/integration against mock-jira — returns the epic + linked issues with statuses; is read-only (no writes) and rate-limited like other reads.
- [ ] T115 [US6] **[Mandatory — feature-context builder, task (h)]** Implement the feature-context section of the wrapper in `libs/executors/src/claude-cli/wrapper.ts` (D5): compile the epic + linked-issue statuses (T114) plus branch/PR URLs extracted from previous runs' `runs.report.artifacts` on those linked issues (DB read joining `runs`↔`tickets` by `jira_key`), applying the **hard size budget & truncation**: ≤ 20 linked issues (`…and N more`), one line per issue `KEY [status] summary(≤80 chars)`, branch/PR lines ≤ 200 chars, total section ≤ ~2 KB (drop prior-run artifacts first, then truncate the issue list). Wire it into the wrapper only for callback-wired runs. Integration test `test/integration/wrapper-feature-context.spec.ts`: seed an epic + a linked issue with a prior run whose report declared branch+PR → compiled wrapper contains the epic, the linked issue + status, and the branch/PR; a 30-linked-issue epic is truncated to 20 + `…and 10 more` and the section stays ≤ ~2 KB. **Verify**: `pnpm test:integration test/integration/wrapper-feature-context.spec.ts` green (FR-026).

**Checkpoint P8**: downstream agents receive bounded cross-agent continuity; a big epic cannot blow the context.

---

## Phase 9: Checkpoint + Live Smoke (DoD Gate)

**Goal**: the whole automated suite is green and stable, then a real Claude run proves `complete_task` end-to-end and re-confirms the D1/D2 probes on the operator's installed CLI, recorded in the journal. **Everything up to and including T116 is machine-verifiable; only T117 touches the real CLI.**

- [ ] T116 **[Full-suite checkpoint]** Run `pnpm typecheck && pnpm lint && pnpm test`; then `pnpm test:integration`; then run `pnpm test:integration` **3 more consecutive times** (4 total) to guard against flake (the iteration-1 shared-container class of bug). **Verify**: static + unit green; four integration runs all green with no stuck-at-queued/running stalls; feature-003 mock + claude_cli suites are among the green runs (channel selection stayed explicit — no regression); record the run counts.
- [ ] T117 **[Live smoke — manual DoD gate]** Prerequisites: a logged-in `claude` CLI (v2.1.207+) on the operator's machine, a scratch throwaway repo, and a real test ticket. Extend `apps/smoke` with a `pnpm smoke:callback -- --ticket <KEY>` script that configures a `claude_cli` agent with `useCallbackChannel:true` and triggers exactly one real run against the live backend callback API. **Verify** (SC-001/002/009): within ~15 min the run ends via a real `mcp__brigadir__complete_task` with a schema-valid report, the ticket transitions per `status_success`/`status_failure`, and the worktree is cleaned up. **One-time re-confirmation of the live probes**: during the run, `printenv` inside the agent session (or an equivalent Bash-tool check) does **NOT** show `BRIGADIR_RUN_TOKEN` (D1 — literal-in-mcp-config isolation holds on the operator's CLI), and the Stop hook fires and honors `stop_hook_active` (D2). Capture the ticket key, `cost_usd`, and the two probe re-confirmations for the journal.
- [ ] T118 **[DoD record]** Add the iteration-4 entry to `docs/progress.md`: status/date, DoD checklist (unit + integration green, 4 consecutive full integration runs green, auth matrix — SC-004, idempotency 409 — SC-007, resume E2E — SC-003, D7 no-clobber, needs_human dedup, PR-review — SC-008, scrubbing — SC-005, feature-context, live smoke — SC-001/009), the live-smoke ticket reference + observed cost, an explicit note that **D1/D2 are CONFIRMED on the operator's installed CLI** (no `${VAR}` path exists; Stop hook fires and is bounded by `stop_hook_active`), and any elaborations discovered during implementation (record the actual shape; do not silently diverge from data-model.md/contracts/ without a note). Note the Constitution V deviation (literal token vs `${VAR}`) and whether the recommended constitution PATCH was filed. **Verify**: `docs/progress.md` committed with the iteration-4 entry.

**Checkpoint P9**: full suite green ×4 total; live smoke passed on the operator's real subscription; D1/D2 re-confirmed; progress journal records the DoD.

---

## Dependencies & Execution Order

### Phase order (strict)

- **Phase 1 (Setup)** → run-token (T093), `brigadir-mcp` (T094→T095), fake-CLI callback mode (T096). **Blocks every callback integration test in Phases 3–8.**
- **Phase 2 (Foundational)** → depends on Phase 1. The scrubber (T098), guard (T099), CallbackModule (T100), HumanTaskService (T101), fail-closed (T102), and executor wiring (T103) are the shared spine. **Blocks all six story phases.**
- **Phase 3 (US1)** → depends on Phases 1–2. MVP.
- **Phase 4 (US2)** → depends on Phases 1–2; T107 (resume service) before T108–T110.
- **Phase 5 (US3)** → depends on Phases 1–2. Independent spec file.
- **Phase 6 (US4)** → T112 implements the review branch in the T100 service, then its own test. Depends on Phases 1–2.
- **Phase 7 (US5)** → depends on Phases 1–2 (scrubber T098 wired at T100/T101). Independent spec file.
- **Phase 8 (US6)** → T114 (Jira read) before T115 (builder). Depends on Phases 1–2.
- **Phase 9** → depends on Phases 3–8 all green.

### Explicit blocking edges

- **T093 (run-token)** blocks T099 (guard), T103 (JWT mint), and every guarded callback test.
- **T094→T095 (`brigadir-mcp`)** and **T096 (fake-CLI callback mode)** block every callback integration test (T104–T115).
- **T097 (useCallbackChannel + JWT secret)** blocks T103 (executor wiring) and T102 (processor callback-run fail-closed).
- **T098 (scrubber)** blocks T100/T101 (applied at the boundary) and T113 (scrubbing E2E).
- **T099 + T100 + T101 (guard + API + human-task service)** block all story integration tests.
- **T102 (failIfStillRunning + processor)** blocks T104 (fail-closed) and T109 (no-clobber).
- **T107 (resume service)** blocks T108 (resume E2E).
- **T114 (Jira feature-context read)** blocks T115 (builder).

### Parallelizable vs sequential

- **Parallel within P1**: T093, T094, T096 (distinct packages/files); T095 after T094.
- **Parallel within P2**: T097, T098 are independent; T099/T100/T101 share `libs/callback`+`libs/human-tasks` and are largely sequential (guard → API → human-task service); T102, T103 touch executor/worker files and can proceed alongside the callback lib once T097/T093 land.
- **Parallel across story phases**: Phases 3, 5, 6, 7, 8 touch distinct spec files and are mutually parallel once Phase 2 is done. Phase 4's T108–T110 depend on T107.
- **Sequential in P9**: T116 → T117 → T118.

---

## Parallel Execution Examples

```bash
# Phase 1:
Task T093: run-token signer/verifier (packages/contracts)
Task T094: scaffold packages/mcp-server  →  Task T095: brigadir-mcp tools + stop-hook
Task T096: fake-CLI callback mode

# Phase 2 (after Phase 1):
Task T097: useCallbackChannel config + JWT secret contract
Task T098: secret scrubber + tests
# then, sequentially within the callback libs:
Task T099 → T100 → T101 ; alongside Task T102, T103 (executor/worker)

# Story-phase integration tests (after Phase 2):
Task T104/T105/T106 (US1)   Task T111 (US3)   Task T112 (US4)   Task T113 (US5)   Task T115 (US6)
# US2 (T108–T110) waits for T107; US6 test (T115) waits for T114.
```

---

## Implementation Strategy

### MVP scope

**US1 (completion & fail-closed) is the MVP** — reached at the end of Phase 3, where a callback-wired run finalizes via `complete_task`, silence fails closed, and credentials are guarded. Requires Phases 1→2→3. US2 (resume) is the required end-to-end scenario and should land immediately after, even though spec ranks US1/US2 both P1.

### Incremental delivery

1. Phase 1 → run-token + `brigadir-mcp` + fake-CLI callback mode work standalone.
2. Phase 2 → guarded callback API + scrubber + human-task service + executor callback wiring exist and unit-pass.
3. Phase 3 → completion contract closed (US1 / MVP).
4. Phase 4 → blocking → resume E2E with single-active-run intact (US2 — SC-003).
5. Phase 5 → progress + non-blocking notes (US3).
6. Phase 6 → PR-review task (US4 — SC-008).
7. Phase 7 → scrubbing proven end-to-end (US5 — SC-005).
8. Phase 8 → bounded feature context (US6).
9. Phase 9 → full-suite ×4, live smoke + D1/D2 re-confirmation, DoD journal.

### Independent test criteria (per story)

- **US1**: valid report → `succeeded`+checks; invalid → 422 no-finalize; silence → fail-closed; auth matrix + 409 (T104–T106).
- **US2**: blocking → park + queue; resume → supersede + one new active attempt → complete; done/dismiss → no attempt; no-clobber; dedup (T107–T110).
- **US3**: ordered progress events; non-blocking note doesn't park (T111).
- **US4**: one non-blocking review task, zero merges (T112).
- **US5**: planted secrets redacted in every stored + Jira-bound copy (T113).
- **US6**: epic + linked statuses + prior branches/PRs within the ≤20-issue/~2 KB budget (T114–T115).

### Notes

- Tests are **mandatory** for every pipeline-logic task (Constitution VI); each story's integration test ships in its own phase — no end-of-project test batch.
- **No `${VAR}` interpolation path may exist** — the run token is a literal in a `0600` mcp-config `env` block (D1, probe B). The Stop hook honors `stop_hook_active` as the FR-023 bound (D2). Both were pinned by live probes on CLI v2.1.207 and are re-confirmed at T117.
- The channel selection is **explicit config** (`useCallbackChannel`): callback-wired runs drop `--json-schema`; the mock executor and feature-003 `structured_output` runs are untouched (FR-011, D6).
- The mandatory dedicated tasks are: auth matrix T105 (a), idempotency T106 (b), resume E2E T108 (c), D7 no-clobber T109 (d), needs_human dedup T110 (e), PR-review T112 (f), scrubber units T098 (g), feature-context builder T115 (h) — each its own task, not folded into a general suite.
- `packages/mcp-server` has **zero DB access** — a thin stdio client of the HTTP API only (T094/T095).
