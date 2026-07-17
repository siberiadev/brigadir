# Tasks: Bedrock authentication mode for Claude CLI executor profiles

**Input**: Design documents from `/specs/018-bedrock-auth-mode/`

**Prerequisites**: plan.md, spec.md, research.md (D1–D8), data-model.md, contracts/executor-auth.md, quickstart.md

**Tests**: MANDATORY — executor lifecycle / child-env construction is pipeline logic (constitution VI); the spec itself requires tests in the same iteration (FR-013). Test tasks are included for every story below; the form story (US4) carries its web tests per FR-013's UI clause.

**Organization**: Tasks are grouped by user story. Foundational phase carries the shared contract + pure helpers every story consumes.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US4)
- Include exact file paths in descriptions

## Path Conventions

pnpm monorepo (per plan.md): `packages/contracts/src/`, `libs/executors/src/claude-cli/`, `apps/backend/src/dashboard/`, `apps/web/src/` + `apps/web/test/`, `test/integration/`, `docs/`.

---

## Phase 1: Setup

**Purpose**: Baseline sanity — no project initialization needed (all touched packages exist).

- [X] T001 Verify clean baseline before changes: `pnpm typecheck && pnpm lint && pnpm test` green on branch `claude/bedrock-auth-executor-bnf1n4` (record any pre-existing failures so they are not attributed to this feature)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared typed contract and the two pure helpers (effective-auth defaulting, per-mode env injection) that every user story consumes. Single source of truth first (feature 005 pattern).

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T002 Extend the `claude_cli` branch in `packages/contracts/src/executor.schema.ts`: add flat optional fields `auth` (`z.enum(['host_subscription','api_key','bedrock'])`), `aws_region`, `aws_profile`, `ca_bundle_path` + `superRefine` rules per research D1 (bedrock⇒`aws_region` required; bedrock fields foreign to other modes; `api_key` string foreign to `host_subscription`/`bedrock`, `null` legal everywhere) + create-request-only rule (`auth='api_key'`⇒`api_key` string required, research D5); document the effective-auth defaulting rule in the header comment
- [X] T003 [P] Mirror the additive camelCase fields (`auth`, `awsRegion`, `awsProfile`, `caBundlePath`) with the bedrock-requires-region refinement into `ClaudeCliExecutorConfigSchema` in `packages/contracts/src/agents-config.schema.ts` (research D6 — keeps the stored/runtime `ClaudeCliExecutorConfigInput` type valid for bedrock rows)
- [X] T004 Contract tests in `packages/contracts/src/executor.schema.spec.ts`: acceptance/rejection matrix from contracts/executor-auth.md §Acceptance — legacy payload without `auth` still valid; bedrock without `aws_region` → issue at `aws_region`; `aws_region` on `host_subscription` → issue; `api_key` string on bedrock → issue while `api_key: null` passes; create `auth='api_key'` without key → issue; happy-path bedrock payload (full example from the contract doc) parses
- [X] T005 Implement the pure helpers in `libs/executors/src/claude-cli/claude-cli.config.ts`: `resolveEffectiveAuth(config, hasStoredKey)` (defaulting rule, research D2) and `applyAuthEnv(env, auth)` (per-mode exact injection after the allowlist pass, research D3: bedrock → `CLAUDE_CODE_USE_BEDROCK='1'`, `AWS_REGION`, `AWS_PROFILE` iff set, `NODE_EXTRA_CA_CERTS` iff set; api_key → `ANTHROPIC_API_KEY`; host_subscription → no-op); extend `ClaudeCliExecutorConfigInput`/`ClaudeCliRuntimeConfig`/`resolveClaudeCliConfig` to carry the auth block
- [X] T006 Unit tests in `libs/executors/src/claude-cli/claude-cli.config.spec.ts`: `resolveEffectiveAuth` matrix (stored `auth` × `hasStoredKey` — 8 cases incl. legacy defaulting) and `applyAuthEnv` exact-env matrix (bedrock with/without `awsProfile`/`caBundlePath`; api_key; host_subscription; pre-existing allowlisted keys in the input env are preserved untouched)

**Checkpoint**: Contract + helpers green (`pnpm test --filter contracts --filter executors` level) — user stories can begin.

---

## Phase 3: User Story 1 — Runs succeed on a Bedrock-only machine, configured entirely from the dashboard (Priority: P1) 🎯 MVP

**Goal**: A bedrock-mode profile created/edited via the executors API drives a run whose spawned CLI authenticates through AWS Bedrock — values from the profile row, zero host-shell coupling (spec US1, FR-001/003/004/012; portability requirement).

**Independent Test**: quickstart.md §2 — seed a bedrock profile, run through the fake-claude harness, assert the exact injected env; live smoke per quickstart §4 on a Bedrock-only machine (API-configured; the polished form ships in US4 — spec notes P1 is API-configurable).

### Tests for User Story 1 (constitution VI — pipeline logic) ⚠️

- [X] T007 [P] [US1] NEW integration spec `test/integration/claude-cli-bedrock.spec.ts` (clone the `claude-cli-profile.spec.ts` harness pattern: `setupClaudeCliTestEnv` + `seedPipeline` + `FAKE_CLAUDE_ENV_DUMP`): (a) full bedrock profile (`auth`, `awsRegion`, `awsProfile`, `caBundlePath` in `executorConfig`) → run succeeds and env dump contains exactly `CLAUDE_CODE_USE_BEDROCK='1'`, profile `AWS_REGION`/`AWS_PROFILE`/`NODE_EXTRA_CA_CERTS`, and no `ANTHROPIC_API_KEY`; (b) region-only bedrock profile → `AWS_PROFILE` and `NODE_EXTRA_CA_CERTS` absent from the dump; write first, watch it fail before T009
- [X] T008 [P] [US1] Extend `test/integration/executor-crud.spec.ts`: POST/PUT round-trip of `auth`/`aws_region`/`aws_profile`/`ca_bundle_path` (persist camelCase in `executors.config`, respond snake_case); 422 matrix through the API (bedrock without region; `aws_region` on host_subscription; `api_key` string on bedrock); write first, watch it fail before T010

### Implementation for User Story 1

- [X] T009 [US1] Wire the runtime in `libs/executors/src/claude-cli/claude-cli.executor.ts`: `loadRunConfig` computes `resolveEffectiveAuth(rawConfig, row.executorSecrets != null)`, decrypts `openExecutorSecrets` ONLY when effective mode is `api_key` (research D4 — keep the hard-error-on-decrypt-failure posture there), returns the auth block; `runProcess` replaces the inline `if (apiKey) env.ANTHROPIC_API_KEY = apiKey` with `applyAuthEnv(env, auth)` (injection stays strictly after `buildChildEnv`)
- [X] T010 [US1] Map the wire fields in `apps/backend/src/dashboard/executors.controller.ts`: `toInsertValues` writes `auth`/`awsRegion`/`awsProfile`/`caBundlePath` into config jsonb (only when present); `toExecutorResponse` returns them snake_case AND sets `config.auth` to the EFFECTIVE mode via `resolveEffectiveAuth(stored, row.secrets != null)`; PUT guard: `auth='api_key'` with `api_key: null`, or omitted `api_key` and no stored blob → 422 `validationError` with issue path `api_key` (research D5, spec FR-007)

**Checkpoint**: T007+T008 green — bedrock runs work end-to-end via API-configured profiles (MVP; quickstart §4 live smoke possible).

---

## Phase 4: User Story 2 — Existing profiles keep working exactly as before (Priority: P2)

**Goal**: Every pre-018 row behaves byte-identically without edits: stored-key rows act as `api_key`, keyless rows as `host_subscription`; a stored key is retained inert when the mode moves away from `api_key` (spec US2, FR-002/007/008/009, SC-002).

**Independent Test**: Run the pre-existing `claude-cli-profile.spec.ts` legacy cases unchanged (they must stay green with zero edits to their assertions) plus the new inert-key and effective-auth-response cases.

### Tests for User Story 2 (constitution VI — pipeline logic) ⚠️

- [X] T011 [P] [US2] Extend `test/integration/claude-cli-profile.spec.ts` (existing legacy assertions stay untouched — their staying green IS the SC-002 proof): (a) bedrock profile WITH a sealed api_key blob → run succeeds, env dump has `CLAUDE_CODE_USE_BEDROCK` but NO `ANTHROPIC_API_KEY` (inert key, FR-009); (b) explicit `auth:'host_subscription'` profile WITH a sealed blob → no `ANTHROPIC_API_KEY` injected
- [X] T012 [P] [US2] Extend `test/integration/executor-crud.spec.ts` (or `executor-api-key.spec.ts` where the tri-state cases live): legacy row without `auth` + stored key → response `config.auth === 'api_key'`; legacy row without key → `'host_subscription'`; PUT switching a keyed profile to `auth:'bedrock'` → 200 and `has_api_key` stays `true` (blob retained); PUT `auth:'api_key'` with omitted key on a row WITH a stored blob → 200 (keeps blob); PUT `auth:'api_key'` with omitted key on a row WITHOUT a blob → 422 at `api_key`; `api_key: null` still clears in any mode

### Implementation for User Story 2

- [X] T013 [US2] Verify-and-fix pass over the defaulting seams the tests above exercise: `resolveEffectiveAuth` call sites in `libs/executors/src/claude-cli/claude-cli.executor.ts` and `apps/backend/src/dashboard/executors.controller.ts` (incl. the setup-run profile path `resolveSetupProfile` → same effective-auth handling), no stored-row rewrite anywhere; fix anything T011/T012 flush out — expected to be small deltas on T009/T010, not new files

**Checkpoint**: Legacy behavior proven frozen; mode-switch semantics proven. US1+US2 independently green.

---

## Phase 5: User Story 3 — Security floor holds: host shell variables still cannot leak into runs (Priority: P2)

**Goal**: The allowlist floor is unchanged in every mode; bedrock injection is profile-sourced only; no AWS credential material anywhere (spec US3, FR-005/006, Constitution V, SC-003/004).

**Independent Test**: `pnpm test:integration -- claude-cli-security` — canary-polluted worker env, child env dumps prove absence in all modes.

### Tests for User Story 3 (constitution VI + V — mandatory security proof) ⚠️

- [X] T014 [US3] Extend `test/integration/claude-cli-security.spec.ts` (T085 lineage): add canaries `AWS_REGION`, `AWS_PROFILE`, `AWS_SESSION_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `NODE_EXTRA_CA_CERTS` to the existing canary map and assert (a) default-mode run: NONE of them reach the child; (b) bedrock-mode run: the child sees the PROFILE's region/profile/bundle values — not the canary host values — and still none of the credential canaries (`AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`)

### Implementation for User Story 3

- [X] T015 [P] [US3] Doc-comment touch-up in `libs/executors/src/claude-cli/env-allowlist.ts`: one line in the header noting bedrock-mode injection (like the existing api-key note) happens AFTER this allowlist and host `AWS_*`/`CLAUDE_CODE_USE_BEDROCK`/`NODE_EXTRA_CA_CERTS` still never pass through; `ALLOWLIST_KEYS` itself MUST remain unchanged (FR-005 — if T014 forces an allowlist edit, the design is wrong: stop and re-check research D3)

**Checkpoint**: Constitution V gate proven through the real spawn path for all three modes.

---

## Phase 6: User Story 4 — The dashboard form guides the operator per auth mode (Priority: P3)

**Goal**: Auth-mode selector in `ExecutorForm`; per-mode conditional fields; bedrock model-id hint; contract-driven — no duplicated field rules (spec US4, FR-010/011).

**Independent Test**: `pnpm --filter web test -- executor-form` — mode switching, field visibility, hint, emitted request bodies.

### Tests for User Story 4 (web — FR-013 UI clause)

- [X] T016 [P] [US4] Extend `apps/web/test/executor-form.spec.ts` (+ fixtures in `apps/web/test/handlers.ts` if the executors handler lacks auth fields): selector defaults to the response's effective `config.auth`; bedrock fields (`aws_region` required-marked, `aws_profile`, `ca_bundle_path`) rendered only for `auth='bedrock'`; API-key block only for `auth='api_key'`; bedrock model hint text present (full Bedrock id, example `eu.anthropic.claude-opus-4-8`); submitted bodies match contracts/executor-auth.md (bedrock request carries no `api_key` key unless clearing; switching a keyed profile to bedrock sends no implicit clear); 422 issue at `aws_region` renders under that field

### Implementation for User Story 4

- [X] T017 [US4] Rework `apps/web/src/components/ExecutorForm/ExecutorForm.vue`: add `auth` to the reactive form (initialized from `config.auth` — always the effective mode per T010); `el-select` auth selector (host_subscription / api_key / bedrock); move the existing API-key tri-state block under `v-if="form.auth === 'api_key'"`; add bedrock inputs `aws_region`/`aws_profile`/`ca_bundle_path` under `v-if="form.auth === 'bedrock'"`; bedrock model hint under the Model field (bare aliases like `opus` don't resolve — full Bedrock model/inference-profile id required); `buildRequest` emits `auth` + mode-scoped fields only (tri-state api_key interplay preserved; no bedrock keys outside bedrock mode)

**Checkpoint**: All four stories independently functional.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T018 [P] Add «Bedrock / корпоративный Claude» section to `docs/local-setup.md`: prerequisites (`~/.aws` profile with Bedrock access, CA bundle path for TLS interception, SSO-refresh note — expired host credentials fail the run, refresh is a host concern), model-id guidance (full Bedrock/inference-profile id), and the create-profile walkthrough (dashboard-only, no shell exports for the worker) per spec FR-014/SC-005
- [X] T019 [P] Update `docs/architecture.md` executor commentary (near the `executors` table notes, §3 DDL untouched): one paragraph on the three auth modes, the effective-auth defaulting rule, and the profile-sourced injection-after-allowlist posture
- [X] T020 Run the full quickstart validation (`specs/018-bedrock-auth-mode/quickstart.md` §1–§3 + §5): `pnpm typecheck && pnpm lint && pnpm test`, `pnpm test:integration -- claude-cli-bedrock claude-cli-profile claude-cli-security executor-crud`, `pnpm --filter web test -- executor-form`; then walk the spec checklist (`checklists/requirements.md` stays satisfied) and mark FR-001..FR-014 traceable

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: none.
- **Foundational (Phase 2)**: after Setup. T002 → T004 (tests exercise the schema); T002/T003 → T005 (types) → T006. T003 parallel to T002.
- **US1 (Phase 3)**: after Phase 2. Test-first: T007/T008 written before T009/T010. T009 depends on T005; T010 depends on T002+T005 (uses `resolveEffectiveAuth`).
- **US2 (Phase 4)**: after US1's T009/T010 (the defaulting seams under test live there). T011/T012 parallel; T013 is the fix-forward pass.
- **US3 (Phase 5)**: T014 after T009 (bedrock injection must exist to assert against); T015 parallel to anything.
- **US4 (Phase 6)**: T016/T017 after T010 (form consumes the effective-auth response); independent of US2/US3.
- **Polish (Phase 7)**: T018/T019 anytime after Phase 2 (docs describe the contract); T020 last.

### User Story Dependencies

- **US1 (P1)**: only Foundational — the MVP.
- **US2 (P2)**: depends on US1 implementation tasks (T009/T010) because back-compat is a property of that code; still independently *testable* (its specs run alone).
- **US3 (P2)**: depends on T009; independent of US2/US4.
- **US4 (P3)**: depends on T010; independent of US2/US3.

### Parallel Opportunities

- Phase 2: T002 ∥ T003; then T004 ∥ T005.
- Phase 3: T007 ∥ T008 (different spec files); then T009 ∥ T010 (worker lib vs backend controller).
- After Phase 3: US2 (T011 ∥ T012), US3 (T014, T015), US4 (T016 → T017) can all proceed in parallel with each other.
- Phase 7: T018 ∥ T019.

## Parallel Example: after Phase 2 checkpoint

```bash
# Write both US1 test specs together (different files):
Task: "claude-cli-bedrock.spec.ts env-dump assertions"     # T007
Task: "executor-crud.spec.ts auth round-trip + 422 matrix" # T008

# Then implement runtime and API in parallel (different apps):
Task: "claude-cli.executor.ts effective auth + applyAuthEnv"  # T009
Task: "executors.controller.ts mapping + PUT guard"            # T010
```

## Implementation Strategy

**MVP first (US1)**: Phase 1 → Phase 2 → Phase 3, then STOP and validate: quickstart §2 integration slice green + (if a Bedrock machine is at hand) quickstart §4 live smoke. This alone fixes the observed failure (run 2fd7aefb class) for API-configured profiles.

**Incremental delivery**: +US2 (back-compat proven frozen) → +US3 (security floor proven) → +US4 (form UX) → Polish/docs. Each checkpoint leaves the branch shippable; one PR per the workflow (this feature is a single iteration, spec FR-013/FR-014 keep tests+docs in it).

## Notes

- **Execution record (2026-07-17)**: implemented in a remote session WITHOUT Docker. Everything runnable ran green: typecheck, lint, 274 unit tests (incl. the new contract matrix and helper matrices), 216 web tests. The five Docker-gated integration specs (T007/T008/T011/T012/T014 — `claude-cli-bedrock`, `executor-crud`, `claude-cli-profile`, `claude-cli-security`) are WRITTEN but not yet executed; run `pnpm test:integration` on a Docker machine before merge (quickstart §2). The "watch it fail first" step was likewise not observable here.
- Deviation from T005's letter: the auth block is NOT threaded through `ClaudeCliRuntimeConfig`/`resolveClaudeCliConfig` — `resolveEffectiveAuth` is called directly in `loadRunConfig` (it needs `hasStoredKey`, which the config resolver doesn't see) and travels as its own return value. Same contract, one less pass-through.
- [P] = different files, no dependency on an incomplete task.
- Test-first within each story: T007/T008, T011/T012, T014, T016 land red before their implementation tasks turn them green.
- Commit after each task or logical pair; the branch already carries spec+plan commits on PR #28.
- If any task forces an edit to `ALLOWLIST_KEYS` or a DB migration — stop: that contradicts FR-005 / the additive-jsonb guarantee (re-open plan.md).
