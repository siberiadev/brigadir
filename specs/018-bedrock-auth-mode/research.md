# Research — Bedrock authentication mode for Claude CLI executor profiles

**Feature**: 018-bedrock-auth-mode | **Date**: 2026-07-17

No NEEDS CLARIFICATION markers remained in the Technical Context; the decisions below resolve the design unknowns raised by the spec (schema shape, defaulting mechanics, injection point, key-decryption semantics, test topology).

## D1 — Schema shape: flat optional fields + `superRefine`, not a nested discriminated union

**Decision**: Extend `ClaudeCliExecutorApiConfigSchema` with flat optional fields — `auth: z.enum(['host_subscription','api_key','bedrock']).optional()`, `aws_region`, `aws_profile`, `ca_bundle_path` (all optional strings at the object level) — and enforce per-mode rules in a `superRefine` attached to the branch:

- `auth === 'bedrock'` → `aws_region` required (non-empty); `api_key` must not be a **string** (explicit `null` to clear a stored key stays legal in any mode);
- `auth !== 'bedrock'` (including absent) → `aws_region` / `aws_profile` / `ca_bundle_path` forbidden;
- `auth === 'host_subscription'` → `api_key` must not be a string (null-to-clear legal);
- create-request refinement only: `auth === 'api_key'` → `api_key` string required (the update-path variant of this rule needs stored state — see D5).

**Rationale**: A nested `z.discriminatedUnion('auth', ...)` inside the already-discriminated `type` union would (a) change the wire shape non-additively (fields move under a sub-object or force `auth` to be required — breaking every existing client payload and stored row), (b) fight the existing `.strict()` + `.extend({name})` composition used by `ExecutorCreateRequestSchema`, and (c) break the Vue form's flat per-field error mapping (`fieldErrors[path[0]]`). Flat + `superRefine` keeps the wire additive (spec FR-002: "no breaking change to stored jsonb beyond additive fields"), keeps `.strict()` as the foreign-key-rejection mechanism it already is, and yields path-qualified issues (`aws_region`, `api_key`) that the existing form error plumbing displays for free.

**Alternatives considered**: (1) Nested union under an `auth_config` object — cleanest typing, rejected for the wire/back-compat/form-error costs above. (2) Three sibling flat branches discriminated on a required `auth` — rejected: makes `auth` required on the wire, breaking existing payloads and requiring a data/client migration for zero benefit. (3) Validation only in the controller — rejected: violates the single-source-of-truth rule (feature 005 pattern; the form must be drivable from the shared schema).

## D2 — Effective-auth defaulting rule lives in ONE pure function, applied at both read sites

**Decision**: A pure helper in `libs/executors/src/claude-cli/claude-cli.config.ts`:

```
resolveEffectiveAuth(config: {auth?; awsRegion?; awsProfile?; caBundlePath?}, hasStoredKey: boolean)
  → { mode: 'host_subscription' } | { mode: 'api_key' } | { mode: 'bedrock', awsRegion, awsProfile?, caBundlePath? }
```

Rule (spec FR-002): stored `auth` wins when present; absent → `api_key` if `hasStoredKey`, else `host_subscription`. Consumed by (a) `ClaudeCliExecutor.loadRunConfig` (runtime behavior) and (b) `executors.controller.ts` `toExecutorResponse` (the response's `config.auth` always carries the **effective** mode so the form shows the truth for legacy rows — spec US2/AS-3). No data migration; stored rows are never rewritten.

**Rationale**: The rule is stated once in the spec and must produce identical answers in the worker and the dashboard; duplicating the conditional in two files is exactly how the two would drift. The executor lib is imported by both backend and worker already (`sealExecutorSecrets` in the controller today), so there is no new dependency edge.

**Alternatives considered**: Backfill migration writing `auth` into every row — rejected: spec explicitly requires additive-only ("no breaking change to stored jsonb"), and a backfill would have to solve the same conditional anyway to seed values, while adding a migration to review against §3 for zero schema change.

## D3 — Injection point: after `buildChildEnv`, via a pure `applyAuthEnv` helper; allowlist untouched

**Decision**: `env-allowlist.ts` is not modified (its `ALLOWLIST_KEYS` floor is the FR-005 invariant; only a one-line doc-comment addition noting the bedrock injection mirrors the existing api-key note). In `runProcess`, the current inline `if (apiKey) env.ANTHROPIC_API_KEY = apiKey;` is replaced by `applyAuthEnv(env, auth)` — a pure function (unit-testable without a spawn) that mutates the sanitized env per effective mode:

- `host_subscription` → no-op;
- `api_key` → `ANTHROPIC_API_KEY = <decrypted key>`;
- `bedrock` → `CLAUDE_CODE_USE_BEDROCK = '1'`, `AWS_REGION = awsRegion`, plus `AWS_PROFILE = awsProfile` iff set, `NODE_EXTRA_CA_CERTS = caBundlePath` iff set.

Values come exclusively from the profile row (already loaded in `loadRunConfig`); `process.env` is never consulted, so host `AWS_*` / `CLAUDE_CODE_USE_BEDROCK` / `NODE_EXTRA_CA_CERTS` remain stripped by construction.

**Rationale**: `CLAUDE_CODE_USE_BEDROCK=1` + `AWS_REGION` is the documented Claude Code switch for Bedrock; `AWS_PROFILE` selects the named credential profile (absent → SDK default chain); `NODE_EXTRA_CA_CERTS` is the Node-level trust extension the CLI honors for TLS-intercepting proxies. All four are configuration, not credentials — credential material stays in `~/.aws`, reachable via allowlisted `HOME` (same posture as `~/.claude`). The pure-helper split exists so the per-mode env matrix is provable in a millisecond unit test, with the integration dump test proving the same through the real spawn path (T085 lineage).

**Alternatives considered**: (1) Extending `ALLOWLIST_KEYS` with `AWS_*` — explicitly out of scope in the spec (host-shell coupling; it's the design being replaced). (2) Passing `--model`-style CLI flags instead of env — the CLI's Bedrock switch is env-based; no argv equivalent exists, and argv is size/secret-constrained by prior decisions (D7 of feature 003). (3) Injecting inside `buildChildEnv` — rejected: keeps the allowlist function impure/parameterized and blurs the "floor + explicit injections" layering the security tests are built around.

## D4 — Secrets are decrypted ONLY when the effective mode is `api_key`

**Decision**: `loadRunConfig` computes the effective auth first, and calls `openExecutorSecrets` only for `mode === 'api_key'` (keeping the existing hard-error-on-decrypt-failure posture there — a misbill guard). For `bedrock`/`host_subscription`, a stored blob is left sealed and untouched (spec FR-009: retained but inert).

**Rationale**: Byte-identical for every legacy row: a legacy row with secrets defaults to `api_key` (decrypts, injects — exactly today's behavior); a legacy row without secrets defaults to `host_subscription` (no blob to open — exactly today's). The only rows that skip decryption are new explicit-`bedrock`/`host_subscription` rows carrying an inert key — where failing a Bedrock run because an *unused* blob can't decrypt (e.g. after a key rotation) would be a pointless outage. The existing hard error stays where it guards something real.

**Alternatives considered**: Always-decrypt (status quo placement) — rejected for the pointless-outage case above; also makes the FR-009 "inert" claim weaker (an inert value shouldn't even be materialized in worker memory).

## D5 — `api_key`-mode keyless-save guard: schema for create, controller for update

**Decision**: Create: `superRefine` on the create-request schema requires an `api_key` string when `auth === 'api_key'` (no stored state exists yet). Update: the controller checks the tri-state against the loaded row — `auth === 'api_key'` and (`api_key === null`, or `api_key` omitted and row has no `secrets`) → 422 with a path-qualified issue on `api_key` (spec FR-007, edge case 4). Mode switching away from `api_key` leaves `secrets` untouched (no implicit clear; explicit `api_key: null` remains the only clear — spec FR-009).

**Rationale**: The update rule inherently needs DB state (`has_api_key`), which a wire schema cannot see; putting it in the controller next to the existing tri-state `secretsPatch` logic keeps one owner for key lifecycle. The 422 shape reuses `validationError` so the form renders it under the API-key field with zero new plumbing.

**Alternatives considered**: Making update always require re-entering the key for `api_key` mode — rejected: breaks the established write-only round-trip UX ("configured / Replace / Clear") for every existing profile edit.

## D6 — Boot/yaml config branch gets the same optional camelCase fields

**Decision**: `ClaudeCliExecutorConfigSchema` in `agents-config.schema.ts` (the yaml/boot-validated branch that feeds `ClaudeCliExecutorConfigInput` and seeded profiles) gains optional `auth`, `awsRegion`, `awsProfile`, `caBundlePath` with the same bedrock-requires-region refinement.

**Rationale**: `executors.config` jsonb is stored camelCase ("the shape the executor runtime already consumes") and typed via `Extract<ExecutorConfig, {type:'claude_cli'}>`; without this, a bedrock profile row would fail the runtime type even though the API accepted it. Keeping both entrances aligned is the existing convention (every claude_cli field exists in both schemas today).

**Alternatives considered**: Typing the runtime input independently of the yaml schema — rejected: forks the single typed source (`packages/contracts`) the constitution mandates.

## D7 — Model-id guidance is a form hint, not validation

**Decision**: The form shows a static hint under Model when `auth === 'bedrock'`: a full Bedrock model / inference-profile id is required (example: `eu.anthropic.claude-opus-4-8`), because bare aliases (`opus`, `sonnet`) resolve through `ANTHROPIC_DEFAULT_*_MODEL` env vars that are deliberately not passed through. No schema/controller validation of the model format (spec FR-011: formats vary by region/vendor and evolve).

**Rationale**: Hard-blocking on a pattern would inevitably reject valid ids (regional prefixes, ARNs, future vendors). A misconfigured model fails fast at the provider and surfaces through the existing failed-run diagnostics path (FR-012).

## D8 — Test topology (FR-013)

**Decision**: Four layers, all in-iteration:

1. **Contract** (`executor.schema.spec.ts`): per-mode acceptance/rejection matrix — legacy payload (no `auth`) still valid; `bedrock` without `aws_region` → issue at `aws_region`; bedrock fields on non-bedrock modes rejected; `api_key` string on bedrock/host_subscription rejected, `null` accepted; create-time keyless `api_key` mode rejected.
2. **Unit** (`claude-cli.config.spec.ts`): `resolveEffectiveAuth` defaulting matrix (stored auth × hasStoredKey); `applyAuthEnv` exact-env matrix (bedrock with/without optional fields; api_key; host_subscription no-op; input env never loses allowlisted keys).
3. **Integration — spawn path** (new `claude-cli-bedrock.spec.ts`, reusing `claude-cli-harness.ts` + `FAKE_CLAUDE_ENV_DUMP` exactly like `claude-cli-profile.spec.ts`): seed a bedrock profile, pollute `process.env` with canary `AWS_REGION`/`AWS_PROFILE`/`AWS_SECRET_ACCESS_KEY`/`NODE_EXTRA_CA_CERTS`/`CLAUDE_CODE_USE_BEDROCK`, run, assert the dump contains exactly the profile-derived values (not the canaries) and no `ANTHROPIC_API_KEY`; plus the inert-key case in `claude-cli-profile.spec.ts` (bedrock profile WITH sealed key → no key in env). Extend `claude-cli-security.spec.ts` canaries so the T085 floor proof covers the bedrock-adjacent variable names in all modes.
4. **API + form**: `executor-crud.spec.ts` round-trip (fields persist camelCase, respond snake_case, effective auth in responses, 422 matrix); `executor-form.spec.ts` (selector switching, conditional fields, hint, request bodies incl. tri-state key interplay).

**Rationale**: Mirrors the proven layering of feature 003/named-profiles: pure function → real spawn → API → UI, each asserting the same contract from its own side. SC-003 ("exact environment per mode") is carried by layers 2–3 together.
