# Quickstart validation: deepseek_api executor type (028)

Runnable scenarios proving the feature end-to-end. Details: [data-model.md](./data-model.md), [contracts/](./contracts/), decisions in [research.md](./research.md).

## Prerequisites

- Node 20+, pnpm, Docker (for integration tests / compose stack).
- No new env vars for the platform itself. A real DeepSeek API key is needed **only** for the mandatory live smoke (V5) — it travels exclusively in the profile-create request body (write-only → sealed `executors.secrets`); never in `.env`, code, tests, or spec files.
- After editing `packages/contracts`: `pnpm --filter @brigadir/contracts build` (web resolves the gitignored dist).

## V1. Static + unit floor

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected:
- New unit coverage green: deepseek contract matrices (`executor.schema.spec.ts`, `agents-config.schema.spec.ts` — incl. "auth/AWS fields are foreign to deepseek_api"), `applyProviderEnv` deepseek-preset test (`claude-cli.config.spec.ts`), keyless-profile loud-error guard (`claude-cli.executor.spec.ts`), registry/module registration of the third instance (`executors.module.spec.ts`), `run.deepseek_api` in the provisioned queue set (`queues.module.spec.ts`), web form/marker tests (`executor-form.spec.ts`, `run-card.spec.ts`, `runs-table.spec.ts`).
- **All pre-existing claude_cli AND kimi unit tests and snapshots pass unchanged** (SC-002). The FR-016 consolidation must not flip any existing accept/reject outcome. Any snapshot diff = regression, not an update candidate.

## V2. Integration — deepseek run end-to-end (fake harness)

```bash
pnpm test:integration
```

Expected (four new suites mirroring the kimi set 1:1):
- `deepseek-run.spec.ts`: profile run travels `run.deepseek_api` → fake-claude spawns; captured child env contains `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` and the profile's key (contract invariant 3); success / rate-limit / crash fixtures yield claude_cli-identical statuses (SC-009).
- `deepseek-security.spec.ts`: polluted worker shell (`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` exported) → none of the host values in any child env; claude_cli child has **no** `ANTHROPIC_BASE_URL`; kimi child still gets exactly Moonshot (invariants 1–2; SC-003); key never in timeline/diagnostics.
- `deepseek-executor-crud.spec.ts`: create-without-key 422; foreign fields (auth/aws/base-url) 422; update keeps key; clear-to-keyless 422; responses show `has_api_key`, never the key (SC-008; error matrix in [contracts/deepseek-executor-api.md](./contracts/deepseek-executor-api.md)).
- `deepseek-gate.spec.ts`: per-profile `max_parallel_runs` gate + live re-apply on `run.deepseek_api`.

## V3. Manual dashboard flow (compose stack)

```bash
docker compose up --build
```

1. Settings → Executors → New: type selector offers **deepseek_api**; form shows model / API key / max_parallel_runs / harness knobs; **no URL field, no auth-mode selector, no AWS fields, no Clear-key button** (Story 6). Model hint names the native ids and both caveats (indicative cost; silent substitution of unknown names).
2. Save without key → validation error. Save with key → profile listed, `has_api_key` reflected, key never echoed.
3. Point an agent at the profile; trigger a run (fake CLI path in dev config): run row shows `executor_type: deepseek_api`; queue `run.deepseek_api` visible in redis (prefix-aware). Verify the run is actually CONSUMED (worker-lock registration — D6).
4. Run detail + runs table: cost value carries the **indicative** marker/tooltip for deepseek runs (FR-014).
5. Edit the profile (rename/model) → historical runs still `executor_type: deepseek_api` (SC-007).

## V4. Regression floor

```bash
pnpm test && pnpm test:integration
```

Full suites — existing claude_cli/kimi/mock behavior unchanged; no test file of features ≤027 modified (SC-002).

## V5. Live smoke — MANDATORY (spec FR-017, definition of done)

Not optional and not CI: one real run against DeepSeek. Stack up in dev mode per `docs/local-setup.md`.

1. `POST /api/executors` (or UI form): `type: "deepseek_api"`, `model: "deepseek-v4-flash"` (cheap), real `api_key` (ONLY here), `use_callback_channel: true`, `max_parallel_runs: 1`.
2. Execute one minimal run in a test workspace.
3. Acceptance evidence (all required):
   - terminal status via the normal path, NOT fail-closed;
   - **callback events on the timeline** (`report_progress → Brigadir`) — the client-side stdio MCP hypothesis; if absent → STOP, write up symptoms, no workaround (Story 3 scenario 4);
   - tool use: files read/written in the worktree;
   - configured model id confirmed served (usage/response logs) — if silently remapped, document the real convention in [contracts/deepseek-provider-env.md](./contracts/deepseek-provider-env.md) and fix the form hint (SC-005);
   - `cost_usd`/usage populated, or absence documented as a known limitation;
   - key absent from timeline/diagnostics (scrubber check, mirroring deepseek-security assertions) (SC-006).

## Done-check against Success Criteria

| SC | Verified by |
|---|---|
| SC-001 | V3 + V5 |
| SC-002 | V1, V4 |
| SC-003 | V2 polluted-shell suite |
| SC-004 | V5 (callback evidence / stop condition) |
| SC-005 | V5 (model pass-through) |
| SC-006 | V2 security suite + V5 live re-check |
| SC-007 | V3 step 5 (+ integration assertion) |
| SC-008 | V2 CRUD matrix |
| SC-009 | V2 fixture matrix |
