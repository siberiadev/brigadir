---

description: "Task list for feature 031: environment variables for agent runs"
---

# Tasks: Environment variables for agent runs

**Input**: Design documents from `/specs/031-agent-env-variables/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/env-config.md](contracts/env-config.md), [quickstart.md](quickstart.md)

**Tests**: Mandatory (constitution Principle VI) for anything on the executor-lifecycle / report-processing path — the merge/injection logic (Foundational, US1) and the secret-scrub/leak-sweep path (US2). Dashboard settings surfaces and pure UI (US3, US4 UI half, US5) are not "pipeline logic" by the constitution's own list, but the reserved-key/validation logic still gets unit/component coverage since it's a correctness-critical guard, not cosmetic.

**Organization**: Tasks are grouped by user story (spec.md priorities P1–P3) so each story ships and demos independently per its own quickstart.md scenario.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: Maps the task to US1–US5 from spec.md
- File paths are exact, from plan.md's Project Structure

## Path Conventions

Existing monorepo layout (no new packages): `packages/contracts/src`, `libs/database/src`, `libs/executors/src`, `libs/scrubber/src`, `apps/backend/src/dashboard`, `apps/web/src`, `packages/admin-mcp/src`, `drizzle/`.

---

## Phase 1: Setup

**Purpose**: Migration + shared contract constants that every later phase imports. No behavior change yet.

- [X] T001 Create migration `drizzle/0010_env_variables.sql`: `ALTER TABLE workspaces ADD COLUMN env_secrets bytea;` (nullable, per data-model.md DDL)
- [X] T002 [P] Add `envSecrets: bytea('env_secrets')` to the workspaces drizzle table in `libs/database/src/schema/workspaces.ts`, mirroring `agentInstructionsToken`
- [X] T003 [P] Create `packages/contracts/src/env.schema.ts`: `ENV_KEY_REGEX`, `RESERVED_ENV_KEYS`, `RESERVED_ENV_PREFIXES`, `ENV_VALUE_MAX_BYTES` (8 KB), `ENV_TOTAL_MAX_BYTES` (64 KB), `isReservedEnvKey()`, `EnvMapSchema`, `EnvWriteRowSchema` — per contracts/env-config.md §1 (reserved set from research.md D5)

**Checkpoint**: schema/constants exist; nothing consumes them yet.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared library code every user story wires into — the merge function, the secret codec, the scrub wrapper, and the contract extensions that carry `env` through existing entities. No user-visible behavior yet (nothing calls these from the executor or an endpoint).

**⚠️ CRITICAL**: No user story implementation may begin until this phase is complete.

- [X] T004 Extend `WorkspaceRepositorySchema` in `packages/contracts/src/jira.types.ts` with `id: z.string().uuid().optional()` and `env: EnvMapSchema.optional()` (schema is `.strict()` — explicit extension per data-model.md)
- [X] T005 [P] Extend `AgentBehaviorSchema` (`packages/contracts/src/agents-config.schema.ts`) and `AgentBehaviorRequestSchema` (`packages/contracts/src/dashboard.schema.ts`) with `env: EnvMapSchema.optional()`
- [X] T006 [P] Extend `WorkspaceSettingsRequestSchema` in `packages/contracts/src/dashboard.schema.ts` with `env: EnvMapSchema.optional()` at workspace level
- [X] T007 Create `libs/executors/src/env-secrets.ts`: `EnvSecretsDocument` type (`{workspace?, repos?: Record<repoId,...>, agents?: Record<agentId,...>}`), `sealEnvSecrets()` / `openEnvSecrets()` using `sealSecret`/`openSecret` from `@brigadir/jira`, mirroring `libs/executors/src/executor-secrets.ts` (throws `SecretBoxError` on tamper — never silent)
- [X] T008 [P] Repo `id` lazy backfill: normalization helper in `libs/database/src/workspace-settings.ts` that assigns a uuid to any `repositories[]` entry missing `id` on write; `getRepositories()` tolerates entries without `id` on read
- [X] T009 Create `libs/executors/src/user-env.ts`: `composeUserEnv({ workspaceEnv, repos, agentEnv, mountedRepoIds })` implementing the precedence formula from data-model.md ("Effective run env" — workspace ⊕ mounted repos in mount order ⊕ agent), and `applyUserEnv(env, userEnv)` that mutates the child-env object, drops any key where `isReservedEnvKey()` is true, and returns the list of dropped keys for diagnostics (contracts/env-config.md §5)
- [X] T010 [P] Add `makeScrub(extraLiterals: string[]): (text: string) => string` to `libs/scrubber/src/scrubber.ts` — redacts exact literal occurrences (length ≥ 4) with `[REDACTED]`, then delegates to the existing global `scrub()`; global `scrub()` signature unchanged
- [X] T011 [P] Unit tests for `composeUserEnv`/`applyUserEnv` in `libs/executors/src/user-env.spec.ts`: precedence order (workspace < repo < agent), multi-repo mount-order tie-break, reserved-key drop + reporting, per-value (8 KB) and merged (64 KB) cap enforcement, empty-value (`KEY=`) pass-through
- [X] T012 [P] Unit tests for `makeScrub` in `libs/scrubber/src/scrubber.spec.ts`: exact-literal redaction of short/low-entropy values the existing entropy heuristic would miss, delegation to global `scrub()` still works, empty `extraLiterals` is a no-op wrapper
- [X] T013 [P] Unit tests for the seal/open codec in `libs/executors/src/env-secrets.spec.ts`: round-trip, tamper → `SecretBoxError`, empty document → `{}` on open

**Checkpoint**: merge/injection/secret/scrub building blocks exist and are unit-tested in isolation. Nothing is wired into the executor or an endpoint yet — user stories start here.

---

## Phase 3: User Story 1 - Repository and workspace env reaches the agent run (Priority: P1) 🎯 MVP

**Goal**: A repo-mounted run starts with workspace-default and repository env merged and injected into the spawned process; edits never affect in-flight runs; no-repo runs and unconfigured workspaces are unaffected.

**Independent Test**: Configure a repo var and a different workspace var, trigger a run mounting that repo, observe both in the spawned process; confirm a run in progress at edit time keeps its original values (quickstart.md Scenario A).

### Tests for User Story 1 (MANDATORY — executor lifecycle is pipeline logic, constitution VI) ⚠️

- [X] T014 [P] [US1] Extend the allowlist-floor security test (pattern of T085) in `libs/executors/src/claude-cli/env-allowlist.spec.ts` or a new `claude-cli.executor.spec.ts` case proving a host-only env var absent from `ALLOWLIST_KEYS` never reaches the spawned child, with user env configured (contracts/env-config.md §7.2)
- [X] T015 [P] [US1] Integration test (`test/integration/`, real Postgres via testcontainers) driving config → run → `FAKE_CLAUDE_ENV_DUMP` harness output: workspace + repo env present, repo overrides workspace, later-mounted repo wins on key collision (quickstart.md Scenario A steps 3–4)
- [X] T016 [P] [US1] Regression test: workspace/repo with zero env configured → spawned child env byte-identical to the pre-feature snapshot (`claude-cli.executor.spec.ts`, SC-005)

### Implementation for User Story 1

- [X] T017 [US1] In `ClaudeCliExecutor.loadRunConfig()` (`libs/executors/src/claude-cli/claude-cli.executor.ts:632-831`), load `workspace.settings.env` and the resolved mounted repositories' `env` (in mount order) and compose the effective user env via `composeUserEnv` (agent layer left empty until US4 wires it in T038) — depends on T009
- [X] T018 [US1] In `ClaudeCliExecutor.runProcess()` (`claude-cli.executor.ts:404-414`), call `applyUserEnv(env, userEnv)` strictly between `buildChildEnv(process.env)` (line 404) and `applyAuthEnv` (line 409) — depends on T009, T017
- [X] T019 [US1] Gate composition to repo-mounted runs only: triage (`workspace_mode: 'none'`) and no-repo-degraded setup runs pass an empty `userEnv` (same gate point as `DEFAULT_REPO_RUN_ALLOWED_TOOLS`, research D4)
- [X] T020 [US1] Log `applyUserEnv`'s dropped-reserved-key list as a run diagnostic (defensive layer — write-surface validation from US3/US5 should already prevent this in normal operation)

**Checkpoint**: US1 fully functional and independently demoable via quickstart.md Scenario A. This is the MVP.

---

## Phase 4: User Story 2 - Secret values are write-only and never resurface (Priority: P2)

**Goal**: Secret env values are sealed at rest, delivered into runs, and never appear in any read surface or persisted run artifact.

**Independent Test**: Save a secret var, confirm every read surface returns only the key name, run an agent using it successfully, sweep run_events/report/Jira for the literal value and find nothing (quickstart.md Scenario B).

### Tests for User Story 2 (MANDATORY — touches executor lifecycle and report processing, constitution VI) ⚠️

- [X] T021 [P] [US2] Contract test for `PUT /api/workspaces/:id/env-secrets` in `apps/backend/src/dashboard/workspaces.controller.spec.ts`: value never echoed in the response, read endpoints return only `env_secret_keys` names, one-home-per-key conflict returns 400
- [X] T022 [P] [US2] Integration test (`test/integration/`) for the full secret lifecycle: configure → run uses it → leak sweep of `run_events.payload`, `runs.report`, `runs.error` for the literal value (quickstart.md Scenario B step 4) — depends on T017/T018 (US1) being in place
- [X] T023 [P] [US2] Extend `libs/executors/src/user-env.spec.ts` (T011): `composeUserEnv` correctly merges decrypted secret values from an `EnvSecretsDocument` alongside plaintext values at the same scope, same precedence rules apply

### Implementation for User Story 2

- [X] T024 [US2] Implement `PUT /api/workspaces/:id/env-secrets` in `apps/backend/src/dashboard/workspaces.controller.ts`: read-modify-write the sealed blob (`sealEnvSecrets`/`openEnvSecrets` from T007), scope routing (`workspace` / `repository_id` / `agent_id`), validate `set` values via `EnvMapSchema`, reject if a key collides with a plaintext key in the same scope (400) — per contracts/env-config.md §3.1
- [X] T025 [US2] Add `env_secret_keys: { workspace, repos, agents }` (names only) to workspace read responses in `apps/backend/src/dashboard/workspaces.controller.ts` + corresponding response shape in `packages/contracts/src/dashboard.schema.ts`
- [X] T026 [US2] Wire `loadRunConfig()`/`composeUserEnv` call site (from T017) to open `env_secrets` via `openEnvSecrets` and merge decrypted secret values into the same precedence chain as plaintext — depends on T007, T017, T023
- [X] T027 [US2] Fail-fast on unopenable secrets: if a run's merge references `env_secrets` and `openEnvSecrets` throws `SecretBoxError`, fail the run before spawn with a diagnostic naming the workspace (never the values) — mirrors the existing api_key-only fail-fast pattern, in `claude-cli.executor.ts`
- [X] T028 [US2] Build `makeScrub` (T010) from the run's decrypted secret values in `ClaudeCliExecutor.runProcess()` and use it everywhere the global `scrub` is used today: `ClaudeStreamParser({ scrub })` (`claude-cli.executor.ts:433`) and the stderr-tail/diagnostics path
- [X] T029 [US2] Prune `env_secrets.repos[repoId]` on repository delete (settings write path, `apps/backend/src/dashboard/workspaces.controller.ts`) and `env_secrets.agents[agentId]` on agent delete (`apps/backend/src/dashboard/agents.controller.ts`) in the same transaction as the entity delete
- [X] T030 [US2] One-home-per-key validation on the plaintext write path too: `PUT /api/workspaces/:id/settings` (workspace/repo `env`) and the agent behavior write path reject a key already present as a secret in the same scope (400, mirrors T024's check)

**Checkpoint**: US2 independently testable via quickstart.md Scenario B, on top of US1.

---

## Phase 5: User Story 3 - Repositories become editable cards in workspace settings (Priority: P2)

**Goal**: Workspace settings gets a Repositories card block (per-card edit dialog = repo fields + env table) and a small workspace-env-defaults block; the workspace edit dialog drops repository rows; creation flow is unchanged.

**Independent Test**: Create a workspace with two repos, open settings, verify cards + env summary, edit a card's env and branch, verify the edit-mode workspace dialog has no repo rows (quickstart.md Scenario C).

### Tests for User Story 3

- [X] T031 [P] [US3] Component test for the shared env table in `apps/web/src/components/EnvVarsTable/EnvVarsTable.spec.ts`: reserved-key inline error (using `env.schema.ts` constants from T003), malformed-key inline error, secret rows render masked with no reveal affordance, add/remove rows
- [X] T032 [P] [US3] Update `apps/web/src/components/WorkspaceForm/WorkspaceForm.spec.ts` to assert repository rows are present in create mode and absent in edit mode

### Implementation for User Story 3

- [X] T033 [P] [US3] Create `apps/web/src/components/EnvVarsTable/EnvVarsTable.vue`: key/value/secret rows, inline validation against `ENV_KEY_REGEX`/`isReservedEnvKey`/size caps from `env.schema.ts`, masked secret rows (replace/delete only, never reveal) — depends on T003
- [X] T034 [US3] Create `apps/web/src/components/RepositoryCard/RepositoryCard.vue` (card: name, git_url, default_branch, Default tag, env summary "N vars, M secret") and its edit `FormDialog` (repo fields + embedded `EnvVarsTable`, add/delete repo, "Make default" action) — depends on T033
- [X] T035 [US3] Add the Repositories card block to `apps/web/src/views/WorkspaceSettings.vue`, wired to `PUT /api/workspaces/:id/settings` (plaintext + repo id/rename handling) and `PUT /api/workspaces/:id/env-secrets` (secret rows) — depends on T034, T024
- [X] T036 [US3] Add the "Environment defaults" block to `apps/web/src/views/WorkspaceSettings.vue` (workspace-scope `EnvVarsTable`, same two endpoints, `scope: 'workspace'`) — depends on T033, T024
- [X] T037 [US3] Remove repository rows from edit-mode `apps/web/src/components/WorkspaceForm/WorkspaceForm.vue` (create mode unchanged)
- [X] T038 [US3] Add an "Applies to new runs" hint near the save action in both new `WorkspaceSettings.vue` blocks (env is fixed at spawn, matching allowed-tools behavior)

**Checkpoint**: US3 independently testable via quickstart.md Scenario C, on top of US1+US2.

---

## Phase 6: User Story 4 - Per-agent env override (Priority: P3)

**Goal**: A collapsed advanced section on the agent form lets an operator set per-agent env overrides, visibly marked when they shadow a lower layer.

**Independent Test**: Set an override on one agent for a key also defined at repository level; run that agent and another; only the overriding agent's run sees the override (quickstart.md Scenario D).

### Tests for User Story 4

- [X] T039 [P] [US4] Extend `libs/executors/src/user-env.spec.ts`: agent-level env wins over workspace and repository for the same key
- [X] T040 [P] [US4] Component test for the agent form's advanced env section in `apps/web/src/components/AgentForm/AgentForm.spec.ts`: collapsed and empty with no overrides configured; override badge appears when a key shadows a resolved lower-layer value

### Implementation for User Story 4

- [X] T041 [US4] Wire `agents.behavior.env` and `env_secrets.agents[agentId]` into the `composeUserEnv` call site (`loadRunConfig`, from T017/T026) as the final, highest-precedence layer — mostly wiring, `composeUserEnv` already supports this layer from T009
- [X] T042 [US4] Add the collapsed "Advanced" env section to `apps/web/src/components/AgentForm/AgentForm.vue` using `EnvVarsTable`, computing override badges by diffing agent keys against the workspace/repo effective values fetched for context — depends on T033

**Checkpoint**: US4 independently testable via quickstart.md Scenario D, on top of US1+US2+US3.

---

## Phase 7: User Story 5 - Admin-MCP parity (Priority: P3)

**Goal**: A team can be assembled with env from outside the UI: `create_workspace` accepts repository env, and a new `set_env` tool manages env at all three scopes on existing entities; secret values never pass through the model.

**Independent Test**: Using admin tooling only, create a workspace with a repo carrying env, add a secret value, verify the masked read surface and a subsequent run (quickstart.md Scenario E).

### Tests for User Story 5

- [X] T043 [P] [US5] Test in `packages/admin-mcp/src/tools.spec.ts`: `create_workspace` maps `repositories[].env` correctly (literal `value` vs `secret_from_env` resolved from the MCP server's own process env); missing `secret_from_env` variable → tool error naming it, nothing partially created
- [X] T044 [P] [US5] Test in `packages/admin-mcp/src/tools.spec.ts`: `set_env` resolves repository name/agent key → id via existing read endpoints, calls the correct write endpoint per scope, and the secret literal never appears in the tool's returned text or logged args

### Implementation for User Story 5

- [X] T045 [US5] Extend `AdminRepositoryInputSchema` in `packages/contracts/src/admin-tools.schema.ts` with `env?: AdminEnvRowSchema[]` (`{ key, value? , secret_from_env? }`, exactly one of `value`/`secret_from_env`)
- [X] T046 [US5] Extend the `create_workspace` handler in `packages/admin-mcp/src/tools.ts`: resolve `secret_from_env` from the server process's own env, map repositories' `env` rows into the create-workspace request (plaintext inline, secrets via a follow-up `env-secrets` write in the same atomic operation) — depends on T045, T024
- [X] T047 [US5] Implement the new `set_env` admin-MCP tool: `SetEnvInputSchema` in `packages/contracts/src/admin-tools.schema.ts`, handler in `packages/admin-mcp/src/tools.ts` resolving scope (`workspace` / `{repository}` / `{agent}`) to ids and calling `PUT .../settings` or `PUT .../env-secrets` — depends on T024, T035
- [X] T048 [US5] Document the `env` repository field and the `set_env` tool in the CLAUDE.md admin-mcp section and any `packages/admin-mcp` README

**Checkpoint**: US5 independently testable via quickstart.md Scenario E, on top of US1+US2+US3.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Documentation obligations and full-suite validation across all stories.

- [X] T049 [P] Update `docs/architecture.md` §3 (`workspaces.settings` comment: + `env`; `agents.behavior` comment: + `env`; repositories entry: + `id`) and §4 (`RunContext.env` clarifying note — composition happens in the executor, not via that field; see research.md D1)
- [X] T050 [P] Record the constitution §V amendment note (Secret Isolation & Output Scrubbing narrowing for operator-supplied service env) in `.specify/memory/constitution.md`, mirroring the feature-015 precedent
- [X] T051 [P] Add a `docs/progress.md` journal entry for feature 031
- [X] T052 Run the full `quickstart.md` validation (Scenarios A–F) end-to-end against the docker-compose stack
- [X] T053 Run `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration` — full gate pass

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — start immediately
- **Foundational (Phase 2)**: depends on Setup (T004–T006 extend schemas from T003; T007/T009/T010 are pure new modules) — BLOCKS all user stories
- **US1 (Phase 3)**: depends on Foundational completion — no dependency on other stories. This is the MVP.
- **US2 (Phase 4)**: depends on Foundational; its executor wiring (T026) depends on US1's T017/T018 being in place, but the write endpoint (T024/T025) and codec use (T007) could start in parallel with late US1 work
- **US3 (Phase 5)**: depends on Foundational (T003, T004) and on US2's `PUT /env-secrets` endpoint (T024) for the card dialog's secret rows — sequence after US2, though the pure-UI `EnvVarsTable` component (T033) and its test (T031) can start as soon as T003 lands
- **US4 (Phase 6)**: depends on US1 (T017) for the compose call site and US3 (T033) for the shared table component
- **US5 (Phase 7)**: depends on US2 (T024) and US3 (T035) for the endpoints it calls
- **Polish (Phase 8)**: depends on all desired user stories being complete

### Within Each User Story

- Tests written first, confirmed to fail, then implementation (per constitution VI for US1/US2)
- Foundational building blocks (Phase 2) before any wiring
- Endpoint/executor plumbing before the UI that calls it

### Parallel Opportunities

- Setup: T002, T003 in parallel (T001 is the migration file itself, independent too)
- Foundational: T004, T005, T006 (different contract files) in parallel; T007, T008, T009, T010 (different lib files) in parallel; T011, T012, T013 (different spec files) in parallel once their subjects exist
- US1 tests T014, T015, T016 in parallel (different files); implementation T017→T018→T019/T020 is a dependency chain (same file, sequential)
- US2 tests T021, T022, T023 in parallel; T024/T025 (same controller file) sequential, T026/T027/T028 (same executor file) sequential, T029/T030 can run alongside once T024 lands
- US3: T031/T032 tests in parallel; T033 alone, then T034 depends on it, T035/T036 depend on T034 but are different concerns in the same view file (sequential within the file), T037/T038 small and parallelizable with T035/T036 review
- US4: T039/T040 in parallel; T041/T042 depend on their respective prerequisites, independent of each other
- US5: T043/T044 in parallel; T045 alone, T046/T047 depend on it and on backend endpoints, T048 anytime after
- Polish: T049, T050, T051 in parallel; T052 after all stories; T053 last

---

## Parallel Example: Foundational Phase

```bash
# After T001–T003 (Setup):
Task: "Extend WorkspaceRepositorySchema with id/env in packages/contracts/src/jira.types.ts"          # T004
Task: "Extend AgentBehaviorSchema/AgentBehaviorRequestSchema with env"                                  # T005
Task: "Extend WorkspaceSettingsRequestSchema with env"                                                  # T006

# Independent new modules, in parallel:
Task: "Create libs/executors/src/env-secrets.ts seal/open codec"                                        # T007
Task: "Repo id lazy backfill in libs/database/src/workspace-settings.ts"                                 # T008
Task: "Add makeScrub() to libs/scrubber/src/scrubber.ts"                                                 # T010
```

## Parallel Example: User Story 1 tests

```bash
Task: "Allowlist-floor security test with user env configured"                                          # T014
Task: "Integration test: config -> run -> FAKE_CLAUDE_ENV_DUMP precedence"                               # T015
Task: "Regression test: zero-config env byte-identical to pre-feature"                                   # T016
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1: Setup
2. Phase 2: Foundational (blocks everything)
3. Phase 3: US1 — repo/workspace env reaches the run
4. **STOP and VALIDATE**: quickstart.md Scenario A end-to-end
5. Demo: an operator sets `PORT`/`NODE_ENV` on a repo and workspace, triggers a run, the agent starts the service on the configured port

### Incremental Delivery

1. Setup + Foundational → shared building blocks, unit-tested, nothing wired
2. US1 → runs see plaintext env (MVP) → demo
3. US2 → secrets join the merge, write-only everywhere, scrubbed → demo
4. US3 → the UI operators actually use day-to-day (cards + dialogs) → demo
5. US4 → rare per-agent override, small increment on US1+US3 → demo
6. US5 → admin-MCP parity, closes the "assemble a team outside the UI" loop → demo
7. Polish → docs, constitution amendment note, full quickstart + gate run

### Notes on sequencing vs. spec priority

Spec priorities are P1(US1) / P2(US2, US3) / P3(US4, US5). Within this plan, US3's UI cannot meaningfully manage secrets until US2's `/env-secrets` endpoint exists, so US2 is sequenced before US3 despite equal spec priority — the two remain independently *testable* (US2 via its own contract/integration tests, US3 via its component tests plus the Scenario C flow) but US3's full demo needs US2 merged first. All other stories match their spec priority order.
