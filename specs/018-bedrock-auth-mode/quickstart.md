# Quickstart — validating Bedrock auth mode (feature 018)

Runnable checks proving the feature end-to-end. Shapes/rules referenced from
[contracts/executor-auth.md](contracts/executor-auth.md) and
[data-model.md](data-model.md).

## Prerequisites

- Repo deps installed (`pnpm install`), Docker running (testcontainers).
- For the live check (§4 only): a machine with `claude` CLI, a working
  `~/.aws` profile with Bedrock access, and (if TLS-intercepted) a CA bundle
  file; backend+worker running per `docs/local-setup.md`.

## 1. Static + unit + contract (fast, no Docker)

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: green, including
- `packages/contracts/src/executor.schema.spec.ts` — per-mode acceptance/422 matrix (legacy no-`auth` payload still valid; bedrock requires `aws_region`; foreign-field rejections; `api_key`×mode rules);
- `libs/executors/src/claude-cli/claude-cli.config.spec.ts` — `resolveEffectiveAuth` defaulting matrix and `applyAuthEnv` exact per-mode env.

## 2. Integration — real spawn path (Docker)

```bash
pnpm test:integration -- claude-cli-bedrock claude-cli-profile claude-cli-security executor-crud
```

Expected: green, proving through the fake `claude` binary's env dump
(`FAKE_CLAUDE_ENV_DUMP`):

- **bedrock run** receives exactly `CLAUDE_CODE_USE_BEDROCK=1` + profile `AWS_REGION` (+ `AWS_PROFILE`/`NODE_EXTRA_CA_CERTS` when configured), no `ANTHROPIC_API_KEY`, and NONE of the canary host values planted in the worker's own env (`AWS_REGION`/`AWS_PROFILE`/`AWS_SECRET_ACCESS_KEY`/`NODE_EXTRA_CA_CERTS`/`CLAUDE_CODE_USE_BEDROCK`);
- **inert key**: bedrock profile WITH a sealed api_key → no `ANTHROPIC_API_KEY` in child env;
- **legacy floor** (T085 lineage): all modes still strip every canary secret;
- **API round-trip**: fields persist camelCase / respond snake_case, responses carry the *effective* `auth`, 422 matrix (missing region, keyless `api_key` mode, foreign fields).

## 3. Form behavior (jsdom)

```bash
pnpm --filter web test -- executor-form
```

Expected: auth selector defaults to the response's effective mode; bedrock
fields visible only for `auth=bedrock`, API-key block only for
`auth=api_key`; bedrock model hint rendered; emitted request bodies match the
contract (incl. tri-state key interplay when switching modes).

## 4. Live smoke on a Bedrock-only machine (SC-001/SC-005, manual)

1. Start backend + worker per `docs/local-setup.md` (no `AWS_*`/`CLAUDE_CODE_USE_BEDROCK` exports needed — that's the point).
2. Dashboard → Settings → Executors → create profile: type `claude_cli`, auth **bedrock**, your region, your `~/.aws` profile name, CA bundle path if applicable; model = full Bedrock id (e.g. `eu.anthropic.claude-opus-4-8`).
3. Assign the profile to an agent, trigger a run (manual trigger or ticket status).
4. Expected: run reaches `running` and completes with a schema-valid report — no "Not logged in · Please run /login", no "no schema-valid structured_output" (the failure mode of run 2fd7aefb).
5. Negative probe: set a bogus `aws_profile` → run fails with diagnostics (never hangs, never falls back to another auth mode).

## 5. Docs presence check

- `docs/local-setup.md` contains the «Bedrock / корпоративный Claude» section (prereqs: `~/.aws` profile, CA bundle, model-id guidance, SSO-refresh note).
- `docs/architecture.md` executor commentary mentions the auth modes + effective-auth defaulting rule.
