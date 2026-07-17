# Tasks: Configurable Default Brigadir Agent + Repo-Mounted Setup Runs

**Input**: Design documents from `specs/015-brigadir-agent-repo-setup/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md) (D1–D14), [data-model.md](data-model.md), [contracts/brigadir-agent-settings.md](contracts/brigadir-agent-settings.md), [quickstart.md](quickstart.md)

**Tests**: MANDATORY here — template-based seeding, the settings endpoint, and setup-run environment resolution are pipeline logic (Constitution VI; spec FR-021). Web tests required by spec FR-021 as well.

**Organization**: Grouped by user story. US1 (template + seeding) is the MVP; US2 (fat setup runs) and US3 (instruction relocation + resets) are independent increments on the shared foundation.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on an incomplete task)
- **[Story]**: US1 / US2 / US3 per spec.md

## Phase 1: Setup

No setup tasks — existing pnpm monorepo, no new dependencies, no DB migrations (research D1). Proceed to Foundational.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: contracts + database-lib primitives every story consumes.

**⚠️ CRITICAL**: all three user stories read these modules.

- [x] T001 [P] Create `BrigadirAgentTemplateSchema` (zod, `.strict()` at every level, `schema_version` literal 1, bounds per data-model §1), `BrigadirAgentSettingsSchema` (template + `routing_instruction` + `workspace_setup_instruction`, strings 1..20000), and `BRIGADIR_AGENT_TEMPLATE_KEY = 'brigadir_agent_template'` in packages/contracts/src/orchestrator-template.schema.ts; export via packages/contracts/src/index.ts
- [x] T002 [P] Add `DEFAULT_BRIGADIR_AGENT_TEMPLATE` (name `brigadir`, role `teamlead`, limits 45/null/2, enabled, triage=`brigadir-orchestrator`+`{workspace_mode:'none'}`, setup=`brigadir-setup`+`{}`+timeout 60) to packages/contracts/src/orchestrator-defaults.ts — keep the module dep-free (no zod/node imports; web imports it via the existing `@brigadir/contracts/orchestrator-defaults` alias, research D5)
- [x] T003 Contract unit tests in packages/contracts/src/orchestrator-template.schema.spec.ts: bounds rejection (`timeout_minutes: 0`, `max_attempts: 0`, negative budget), strictness (unknown key → fail), version literal, defaults object parses, instruction length caps (depends on T001, T002)
- [x] T004 Add `getBrigadirAgentTemplate(db)` to libs/database/src/orchestrator-seed.ts: read `global_settings[BRIGADIR_AGENT_TEMPLATE_KEY]`, safe-parse with `BrigadirAgentTemplateSchema`, fall back to `DEFAULT_BRIGADIR_AGENT_TEMPLATE` on missing/corrupt value with a warn log (spec FR-011; do NOT reuse the string-coercing `getInstructionSetting` — research D7) (depends on T001, T002)
- [x] T005 Add `ensureSetupExecutor(db)` to libs/database/src/orchestrator-seed.ts: insert-if-absent `brigadir-setup` profile per data-model §4 (`claude_cli`, model `claude-sonnet-5`, `maxTurns: 60`, `useCallbackChannel: true`, no `workspaceMode`, `maxParallelRuns: 1`), same `onConflictDoNothing` + re-read race handling as `ensureOrchestratorExecutor` (same file as T004 — sequential)

**Checkpoint**: contracts typecheck; `pnpm --filter @brigadir/contracts test` green.

---

## Phase 3: User Story 1 — Edit the template once, correctly seeded orchestrators everywhere (Priority: P1) 🎯 MVP

**Goal**: Settings → Brigadir agent section edits a global template; every NEW workspace's orchestrator is seeded from it; existing workspaces untouched; dangling executor reference falls back with a visible warning.

**Independent Test**: quickstart Scenarios 1–2 — edit template → create workspace → seeded agent matches; pre-existing workspace unchanged; deleted executor → creation succeeds on fallback + warning toast.

### Implementation for User Story 1

- [x] T006 [US1] Make `seedOrchestratorAgent` template-driven in libs/database/src/orchestrator-seed.ts: read `getBrigadirAgentTemplate`, resolve `triage.executor` by name (must exist AND be enabled; else `ensureOrchestratorExecutor()` fallback), seed name/role/behavior/limits/enabled from template (instruction stays on `getDefaultOrchestratorInstruction` — research D2; `key`/`is_orchestrator`/trigger/status fields unchanged per data-model §5); extend `SeedOrchestratorResult` with an optional warning describing the fallback (depends on T004, T005)
- [x] T007 [US1] Surface the seed warning at all three call sites: `POST /api/workspaces` response gains `warnings[]` (contracts/brigadir-agent-settings.md shape) in apps/backend/src/dashboard/workspaces.controller.ts; structured warn logs in libs/app-config/src/config-seeder.ts and apps/backend/src/dashboard/orchestrator-backfill.service.ts (depends on T006)
- [x] T008 [US1] New controller apps/backend/src/dashboard/brigadir-agent-settings.controller.ts (`GET/PUT /api/brigadir-agent-settings`, `DashboardTokenGuard`): GET composes template + two legacy instruction keys with built-in defaults per-key; PUT validates `BrigadirAgentSettingsSchema` + executor existence/enabled (422 field-level issues via `validationError`), upserts three `global_settings` keys; register in the dashboard module (depends on T001; endpoint contract in contracts/brigadir-agent-settings.md)
- [x] T009 [P] [US1] Integration suite test/integration/brigadir-agent-settings.integration.spec.ts: GET-before-PUT returns built-in defaults; PUT→GET round-trip; 422 on bounds violation, unknown key (strict), and missing/disabled executor name; legacy-key continuity (pre-seed old instruction keys → visible in GET); two sequential PUTs → last write wins (spec edge case) (depends on T008)
- [x] T010 [P] [US1] Extend test/integration/orchestrator-lifecycle.integration.spec.ts: workspace created AFTER a template PUT is seeded with the edited values; workspace created BEFORE keeps old values (SC-002); missing/disabled triage executor → creation succeeds on `brigadir-orchestrator` + `warnings[]` in response; corrupt template value in KV → defaults + seed still works (FR-011); template `enabled=false` → seeded orchestrator is disabled (spec edge case); existing insert-if-absent/race cases stay green (depends on T006, T007)
- [x] T011 [P] [US1] Web API client apps/web/src/api/brigadirAgentSettings.ts (factory `brigadirAgentSettingsApi` with `get`/`update`, types from `@brigadir/contracts`) + composable apps/web/src/composables/useBrigadirAgentSettings.ts (TanStack query key `['brigadir-agent-settings']`, mutation with `setQueryData` on success — mirror useGeneralSettings.ts pattern) (depends on T001)
- [x] T012 [US1] New view apps/web/src/views/settings/SettingsBrigadirAgent.vue: template form — name, role (el-input), triage executor + setup executor (el-select from `useExecutors({page:1,page_size:MAX_PAGE_SIZE})`, disabled profiles non-selectable, `executorLabel` convention), `timeout_minutes`/`max_attempts` (el-input-number `:min="1"`), `max_budget_usd` (`:min="0"`, `:step="0.5"`, nullable), setup `timeout_minutes`, enabled switch, routing-instruction textarea (rows 12, `data-test` hooks). Behavior editing surface (decided): expose ONLY triage `workspace_mode` as a none/default-repo select; all other `triage.behavior`/`setup.behavior` keys are not editable in the form and MUST round-trip unchanged through load→save (keep the loaded objects, patch only exposed keys). Save via T011 mutation with `ApiError.issues` pinning; SettingsGeneral layout conventions (no el-form; `.field-label`/`.hint`) (depends on T011)
- [x] T013 [US1] Register the section: third `navItems` entry `{ key: 'brigadir-agent', label: 'Brigadir agent', to: '/settings/brigadir-agent' }` in apps/web/src/views/settings/PlatformSettings.vue + lazy child route `platform-settings-brigadir-agent` in apps/web/src/router/index.ts (also fix the stale "Bare /settings lands on Executors" comment) (depends on T012)
- [x] T014 [US1] Toast seeding warnings in the create flow: extend the workspaces API client/response type with `warnings[]` and surface via `ElMessage.warning` in apps/web/src/views/WorkspaceList.vue `onCreated` (existing warnings-toast convention) (depends on T007)
- [x] T015 [P] [US1] Web tests apps/web/test/settings-brigadir-agent.spec.ts (MSW): sub-nav shows the third item and routes; form loads GET values; Save PUTs the edited payload; 422 issues pin to fields; workspace-create warning toast (depends on T012, T013, T014 — write after the views exist)

**Checkpoint**: US1 fully functional — quickstart Scenarios 1–2 pass; `pnpm typecheck && pnpm lint && pnpm test` + new/extended integration suites green.

---

## Phase 4: User Story 2 — Repo-mounted setup runs, thin triage (Priority: P2)

**Goal**: `workspace-setup` runs resolve a fat environment from the live template setup profile (repo mounted, Sonnet-tier model, 60 turns, 60-minute timeout); triage runs byte-identical to today; read-only in effect; degraded modes never fail the run.

**Independent Test**: quickstart Scenarios 3–4 — Generate agents in a repo-connected workspace → mounted worktree on `brigadir-setup` profile, repo-grounded team, cleanup, no remote push; no-repo workspace and disabled setup executor degrade gracefully; triage run unchanged.

### Implementation for User Story 2

- [x] T016 [P] [US2] Ticketless worktree identity in libs/executors/src/claude-cli/worktree.ts: `prepare()` accepts a ticketless identity and names the branch `setup/<first 8 chars of runId>` (worktree dir stays `join(worktreeRoot, runId)`); leftover-branch policy and `cleanup()` unchanged; unit tests for the naming + reuse path in the adjacent worktree spec (spec FR-020, research D10)
- [x] T017 [US2] Setup-environment resolution in libs/executors/src/claude-cli/claude-cli.executor.ts `loadRunConfig`: select `runs.trigger_event` in the existing joined query; when `source === 'workspace-setup'` → live-read `getBrigadirAgentTemplate`, look up `template.setup.executor` by name (must exist + enabled, else `ensureSetupExecutor()` fallback + insert a `run_events` warning row naming the missing profile), swap in that profile's config (model/maxTurns/cli settings) and `template.setup.behavior`; repo = workspace default (none configured → existing scratch no-repo path, spec FR-017); narrow the "ticketless run requires a no-repository agent" guard to non-setup sources and route setup runs through T016's ticketless `prepare()`; all other sources byte-identical (research D8) (depends on T004, T005, T016)
- [x] T018 [US2] Setup-run timeout in apps/worker/src/claude-cli-run.processor.ts: for `trigger_event.source === 'workspace-setup'` apply `template.setup.timeout_minutes` (live-read) instead of the agent's `timeout_minutes`, using the existing timeout-override seam (research D9) (depends on T004)
- [x] T019 [P] [US2] Executor unit tests in libs/executors/src/claude-cli/ (existing spec files for executor/args/worktree): workspace-setup run resolves setup profile config (model `claude-sonnet-5`, `--max-turns 60` in built args) and repo-mounted path; triage run (`workspace_mode:'none'`) unchanged; fallback on disabled setup executor emits the warning event; ticketless guard still rejects non-setup ticketless repo runs; worktree cleanup removes the setup worktree (with its `.repos/` clones) same as regular runs (depends on T016, T017)
- [x] T020 [US2] Extend test/integration/workspace-setup.integration.spec.ts with the assertions OBSERVABLE at integration level (model/maxTurns/worktree resolution is owned by T019 unit tests — `runs` stores only `executor_type`, and the suite is mock-executor-driven): disabled setup executor → fallback + `run_events` warning visible via the runs API; no-default-repo workspace completes repo-less; setup run stays ticketless with source `workspace-setup` end-to-end; a triage-loop case still asserting the cheap no-repo environment (SC-004). SC-003 (repo-grounded team quality) remains a quickstart manual check by design (depends on T017, T018)

**Checkpoint**: US2 independently verifiable via quickstart Scenarios 3–4 on top of Foundational alone (built-in defaults; no US1 UI needed).

---

## Phase 5: User Story 3 — Instructions live in the new section, with resets; General keeps only Theme (Priority: P3)

**Goal**: both instruction texts (with stored values intact) edited in Settings → Brigadir agent with per-field Reset + whole-template Reset-all; Settings → General is theme-only; old endpoint and its consumers removed.

**Independent Test**: quickstart Scenario 5 — stored edited texts appear in the new section; per-field and reset-all restore built-ins (unsaved until Save); General shows only Theme; `GET /api/general-settings` → 404; setup-instruction edit affects the very next generate-agents run.

### Implementation for User Story 3

- [x] T021 [US3] Complete the instruction surface in apps/web/src/views/settings/SettingsBrigadirAgent.vue: add the workspace-setup instruction textarea (the routing textarea exists since T012 — do not duplicate it); add per-field Reset to BOTH instruction blocks (port the `routingIsDefault`/`resetRouting` pattern and `data-test` hooks from SettingsGeneral.vue; defaults from `@brigadir/contracts/orchestrator-defaults`); add a "Reset all to defaults" button (`ElMessageBox.confirm`, resets every template field + both texts locally; persists on Save) (depends on T012)
- [x] T022 [US3] Reduce apps/web/src/views/settings/SettingsGeneral.vue to the Theme radio group only; delete apps/web/src/api/generalSettings.ts and apps/web/src/composables/useGeneralSettings.ts (depends on T021)
- [x] T023 [US3] Remove the old server surface: delete apps/backend/src/dashboard/general-settings.controller.ts and its module registration; delete `GeneralSettingsSchema` from packages/contracts/src/global-settings.schema.ts KEEPING `DEFAULT_ORCHESTRATOR_INSTRUCTION_KEY`/`WORKSPACE_SETUP_INSTRUCTION_KEY` (storage keys survive — research D2/D3); update the contracts barrel (depends on T008, T021)
- [x] T024 [P] [US3] Migrate tests: delete test/integration/global-settings.integration.spec.ts (cases live on in the T009 suite — verify coverage before deleting); update apps/web/test/settings-page.spec.ts to theme-only General + redirect assertions; add reset-per-field, reset-all-confirm, and stored-value-continuity cases to apps/web/test/settings-brigadir-agent.spec.ts (depends on T022, T023)
- [x] T025 [US3] Live-read continuity assertion: integration case (in the T009 or workspace-setup suite) — PUT a new `workspace_setup_instruction` via the NEW endpoint, then a generate-agents run's handoff carries the new text (unchanged `getWorkspaceSetupInstruction` path proves key continuity) (depends on T008)

**Checkpoint**: all three stories independently functional; no `general-settings` references remain (`grep -r "general-settings" apps libs packages test` clean except git history).

---

## Phase 6: Polish & Cross-Cutting Concerns

- [x] T026 [P] Docs: append the iteration entry to docs/progress.md; note the narrowed "orchestrator has no repository" principle (triage-only, setup runs repo-mounted read-only — plan.md Constitution Check wording) in docs/architecture.md §4/§8 comments where the orchestrator's no-repo profile is described; mention the new Settings section in docs/spec.md if it lists settings surfaces
- [x] T027 Run quickstart.md scenarios end-to-end and the full gates: `pnpm typecheck && pnpm lint && pnpm test` + `pnpm test:integration` (or the affected suites: brigadir-agent-settings, orchestrator-lifecycle, workspace-setup, executor-seeding) — fix anything red before finishing (CLAUDE.md gates; depends on all previous phases)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Foundational (Phase 2)**: T001/T002 → T003/T004 → T005. BLOCKS all stories.
- **US1 (Phase 3)**: needs T004+T005. Internal chain: T006 → T007 → T014; T008 → T009; T011 → T012 → T013 → T015; T010 after T006/T007.
- **US2 (Phase 4)**: needs T004+T005 only — independent of US1. Chain: T016 → T017 → T019/T020; T018 parallel to T016/T017 after T004.
- **US3 (Phase 5)**: needs T008 (endpoint) and T012 (view) from US1. Chain: T021 → T022/T023 → T024; T025 after T008.
- **Polish (Phase 6)**: after all desired stories.

### Story Dependency Notes

- US2 is deliberately independent of US1's UI: it reads built-in defaults through `getBrigadirAgentTemplate` when no template was ever saved.
- US3 is the only story with a cross-story dependency (extends US1's view and endpoint) — acceptable per spec (P3 is a relocation of shipped behavior into the new section).

### Parallel Opportunities

```text
Phase 2:  T001 ∥ T002
Phase 3:  after T006–T008 land: T009 ∥ T010 ∥ T011; T014 ∥ T012; T015 last
Phase 4:  T016 ∥ T018 (different files); T019 ∥ T020 after T017
US1 ∥ US2: entire phases can proceed in parallel once Phase 2 is done
```

---

## Implementation Strategy

**MVP first**: Phase 2 + Phase 3 (US1) = deployable increment — template editing + template-driven seeding with fallback warnings. Validate via quickstart Scenarios 1–2, then ship.

**Incremental delivery**: add US2 (fat setup runs — the quality payoff), validate Scenarios 3–4; add US3 (relocation + resets + old-endpoint removal), validate Scenario 5; finish with Polish and full gates.

**Single-developer order**: T001→T027 in ID order is a valid topological sort.

## Notes

- Constitution rule 1 (lazy resolution): every template/executor read added here happens inside services or `loadRunConfig` at request/run time — nothing in `@Module()` decorator args.
- CLAUDE.md rule 7 applies to T017/T020: setup runs are callback-wired — any process-outcome status writes stay guarded by `WHERE status='running'`; the environment swap must not touch finalization logic.
- Integration suites share containers per run (test/integration/global-setup.ts) and must use the namespaced `BULLMQ_PREFIX` pattern (rule 6).
