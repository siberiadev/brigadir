# Quickstart validation: kimi executor type (025)

Runnable scenarios proving the feature end-to-end. Details: [data-model.md](./data-model.md), [contracts/](./contracts/), decisions in [research.md](./research.md).

## Prerequisites

- Node 20+, pnpm, Docker (for integration tests / compose stack).
- No new env vars for the platform itself. A real Moonshot API key is needed **only** for the optional live smoke (V5); all automated validation uses the fake-claude harness.

## V1. Static + unit floor

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected:
- New unit suites green: kimi contract matrices (`executor.schema.spec.ts`, `agents-config.schema.spec.ts`), `applyProviderEnv` per-preset tests (`claude-cli.config.spec.ts`), registry/module registration of both instances.
- **All pre-existing claude_cli unit tests and `__snapshots__` pass unchanged** (SC-002). Any snapshot diff = regression, not an update candidate.

## V2. Integration — kimi run end-to-end (fake harness)

```bash
pnpm test:integration
```

Expected (new suites mirroring `claude-cli-bedrock.spec.ts` / `claude-cli-security.spec.ts` / `executor-crud.spec.ts`):
- kimi profile run travels `run.kimi` → fake-claude spawns; captured child env contains `ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic` and the profile's key (contract invariant 3).
- Polluted worker shell (`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` exported) → none of the host values in any child env; claude_cli child has **no** `ANTHROPIC_BASE_URL` key (invariants 1–2; SC-003).
- Success / rate-limit / crash fixtures (`stream-success.ndjson`, `stream-rate-limit.ndjson`, `stream-no-report.ndjson`) yield the same run statuses as claude_cli equivalents (SC-005).
- Executor CRUD: create-without-key 422; foreign fields (auth/aws/base-url) 422; update keeps key; clear-to-keyless 422; responses show `has_api_key`, never the key (SC-006, error matrix in [contracts/kimi-executor-api.md](./contracts/kimi-executor-api.md)).
- Gate/concurrency respected on `run.kimi` (per-profile `max_parallel_runs`, live re-apply).

## V3. Manual dashboard flow (compose stack)

```bash
docker compose up --build
```

1. Settings → Executors → New: type selector offers **kimi**; form shows model / API key / max_parallel_runs / harness knobs; **no URL field, no auth-mode selector, no AWS fields** (Story 5).
2. Save without key → validation error. Save with key → profile listed, `has_api_key` reflected, key never echoed.
3. Point an agent at the kimi profile; trigger a run (fake CLI path in dev config): run row shows `executor_type: kimi`; queue `run.kimi` in Bull board/redis (prefix-aware).
4. Run detail + runs table: cost value carries the **indicative** marker/tooltip for kimi runs (FR-014).
5. Edit the profile (rename/model) → historical runs still `executor_type: kimi` (SC-004).

## V4. Regression floor

```bash
pnpm test && pnpm test:integration
```

Full suites — existing claude_cli/mock behavior unchanged; no test file of feature ≤024 modified (SC-002).

## V5. Optional live smoke (requires real Moonshot key; not CI)

Create a kimi profile with a real key, `cli_path` = real claude binary, model `kimi-k3`; trigger a trivial ticket run. Expected: agent loop reaches Moonshot (CLI reports the base URL in its startup diagnostics), run completes with schema-valid report (SC-001). Note: `cost_usd` will show Anthropic-priced numbers — expected, marked indicative.

## Done-check against Success Criteria

| SC | Verified by |
|---|---|
| SC-001 | V3 + V5 |
| SC-002 | V1, V4 |
| SC-003 | V2 polluted-shell suite |
| SC-004 | V3 step 5 (+ integration assertion) |
| SC-005 | V2 fixture matrix |
| SC-006 | V2 CRUD matrix |
