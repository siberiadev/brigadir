# Tasks: Agent Identity — persona name, role, and routing key

**Input**: Design documents from `specs/014-agent-identity/` ([plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/contracts-delta.md](contracts/contracts-delta.md), [quickstart.md](quickstart.md))

**Tests**: MANDATORY — routing resolution, team apply, seeding, and the backfill are pipeline logic (Constitution VI, spec FR-021). Test tasks are included per story and written FIRST within each story.

**Organization**: Phases by user story. US1 (routing/identity, P1) and US4 (migration, P1) ship together as the MVP core; US2 (themed generation, P2) and US3 (presentation, P3) layer on top. Everything lands in one PR per repo workflow, but each phase is an independently testable checkpoint.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on an incomplete task)
- **[Story]**: US1–US4 from spec.md; Setup/Foundational/Polish tasks carry no story label

## Phase 1: Setup (canonical slug module)

**Purpose**: The one shared building block every subsequent task imports.

- [X] T001 [P] Add failing unit tests for the slug module in `packages/contracts/src/agent-key.spec.ts`: slug rule incl. role concat ("Hera"+"Reviewer" → `hera-reviewer`), lowercase/collapse/trim, empty-slug fallback chain (non-Latin name → role slug → `agent`), `ensureUniqueAgentKey` smallest-free suffix (`-2`, `-3`), reserved keys always taken (`brigadir` → `brigadir-2`) (contracts-delta §1, research D1/D2/D6)
- [X] T002 Create dep-free `packages/contracts/src/agent-key.ts` exporting `slugifyAgentKey(name, role?)`, `ensureUniqueAgentKey(base, taken)`, `ORCHESTRATOR_AGENT_KEY = 'brigadir'`, `RESERVED_AGENT_KEYS`; export via `packages/contracts/src/index.ts`; T001 goes green

**Checkpoint**: `pnpm --filter @brigadir/contracts test` green.

---

## Phase 2: Foundational (schema, migration, every insert path)

**Purpose**: `key` is NOT NULL — no agent row can be inserted anywhere until every creation path derives it. BLOCKS all user stories.

**⚠️ CRITICAL**: complete before any story phase.

- [X] T003 Update Drizzle schema `libs/database/src/schema/agents.ts`: add `role: text('role')` and `key: text('key').notNull()`; add unique `agents_workspace_key` on `(workspaceId, key)`; drop `agents_workspace_name` (data-model.md table delta)
- [X] T004 Write migration `drizzle/0007_agent_identity.sql`: add columns → backfill orchestrators (`role='teamlead'`, `key='brigadir'`) → backfill workers (SQL slug of `name`, empty → `'agent'`, `role` NULL) → deterministic collision suffixes per `(workspace_id, key)` incl. vs reserved key (`ORDER BY id`) → `SET NOT NULL` → add `UNIQUE (workspace_id, key)` → drop `agents_workspace_name` (data-model.md backfill algorithm, research D3)
- [X] T005 [P] Write SQL review doc `drizzle/REVIEW-0007_agent_identity.md` checking 0007 against `docs/architecture.md` §3 (repo rule 5; walk the collision-suffix SQL)
- [X] T006 [P] Update `docs/architecture.md` §3 `agents` table: `name` comment (persona, non-unique), new `role`/`key` columns with semantics, `UNIQUE (workspace_id, key)` replacing `UNIQUE (workspace_id, name)`, orchestrator seed note (key `brigadir`, role `teamlead`)
- [X] T007 Update `libs/database/src/orchestrator-seed.ts`: seed `role='teamlead'`, `key=ORCHESTRATOR_AGENT_KEY`; singleton lookup by `(workspace_id, is_orchestrator=true)` instead of name; `onConflictDoNothing` target `(workspaceId, key)`; keep persona name "brigadir" as default display; update its existing spec assertions (data-model.md orchestrator row, research D1)
- [X] T008 Update `apps/backend/src/dashboard/agents.controller.ts` write paths: create derives `key` via `slugifyAgentKey` + `ensureUniqueAgentKey` (existing workspace keys ∪ `RESERVED_AGENT_KEYS`) with bounded retry on unique-violation race, persists `role`; update statement never selects or sets `key` (research D4/D5)
- [X] T009 Update `libs/pipeline/src/setup-apply.service.ts` `insertTeamAgents`: derive `key` (same helper composition) and persist `role` for every inserted team agent — minimal insert support only; validation semantics move in T023 (research D4)
- [X] T010 Update `libs/app-config/src/config-seeder.ts`: idempotent agent lookup switches from `(workspace_id, name)` to `(workspace_id, key)` with `key = slugifyAgentKey(name, role)`; inserts persist `role` + `key` (plan: 4th creation path)
- [X] T011 [P] Update `packages/contracts/src/agents-config.schema.ts`: add optional `role` per agent entry; duplicate detection by derived key (`slugifyAgentKey(name, role)`) instead of name — hard validation error (contracts-delta §5)
- [X] T012 Sweep existing tests/fixtures that insert `agents` rows directly (unit specs, `test/integration/` helpers/factories) to satisfy NOT NULL `key` — go through the helpers or supply keys explicitly; `pnpm typecheck && pnpm lint && pnpm test` green

**Checkpoint**: full stack boots (seeds write keys), all pre-existing suites green — story phases may start.

---

## Phase 3: User Story 1 — Stable identity: routing by key, references by id (Priority: P1) 🎯 MVP

**Goal**: Roster shows key+name+role+description and instructs routing by key; `routing.target_agent` (= key) resolves to `id` at the boundary; invalid targets escalate; renames never break anything.

**Independent Test**: Fail a worker run → triage → mock orchestrator routes by key → rework run created for the right agent id; rename persona mid-flight → still resolves; unknown/disabled/`brigadir` key → human task.

### Tests for User Story 1 (write first, red) ⚠️

- [X] T013 [P] [US1] Extend `libs/pipeline/src/pipeline.service.spec.ts`: `resolveRoutingTarget` matches by exact `key` (hit → continue by id), misses on unknown key / disabled agent / orchestrator key → human-task escalation; rename-between-handoff-and-resolution safety (key immutable)
- [X] T014 [P] [US1] Add/extend integration coverage in `test/integration/` (new `agent-identity.integration.spec.ts` or the existing routing suite): failed run → triage handoff roster contains `- <key> — <name> (<role>): <description>` and route-by-key prose → mock orchestrator returns `target_agent=<key>` → rework run `agent_id` equals target uuid; negative case creates a human task

### Implementation for User Story 1

- [X] T015 [US1] Update `packages/contracts/src/report.schema.ts`: re-document `ReportRoutingSchema.target_agent` as the target worker's KEY exactly as listed in the roster (field name unchanged; resolved to id by the system) (contracts-delta §2)
- [X] T016 [US1] Update `libs/pipeline/src/pipeline.service.ts` `resolveRoutingTarget`: match `eq(schema.agents.key, target)` (still enabled ∧ non-orchestrator ∧ same workspace), callers unchanged (continue by returned `id`)
- [X] T017 [US1] Update `libs/pipeline/src/handoff.ts` `rosterAndBudgetLines`: select `key`, `name`, `role`, `description`; render `- <key> — <name> (<role>): <description>`; header + `DECISION_PROTOCOL_LINES` prose instructs `target_agent` = key exactly as listed (contracts-delta §6); T013/T014 go green

**Checkpoint**: routing works end-to-end by key; renames are safe. MVP core done (together with Phase 4).

---

## Phase 4: User Story 4 — Existing data migrates safely (Priority: P1, ships with US1)

**Goal**: Deterministic backfill proven against real pre-feature-shaped data; id-based references untouched.

**Independent Test**: Integration test seeds pre-feature rows, applies migrations, asserts keys/roles/constraints; resume-path suites stay green.

- [X] T018 [P] [US4] Add migration-backfill integration test in `test/integration/agent-identity.integration.spec.ts`: seed pre-feature-shaped rows (orchestrator; workers whose names collide after slugging, e.g. "QA Agent" / "qa agent"; a non-Latin name) → run migrations → assert every `key` non-empty, unique per workspace, byte-identical to `ensureUniqueAgentKey(slugifyAgentKey(...))` for the same inputs (SQL↔TS parity, research D3); orchestrator has `role='teamlead'`, `key='brigadir'`; `agents_workspace_name` constraint gone
- [X] T019 [US4] Audit + verify the resume path is untouched: `libs/human-tasks/src/resume.service.ts` and `resolve.controller.ts` reference agents by uuid only (no name/key lookups); confirm their existing suites pass unmodified — record the audit result in the PR notes

**Checkpoint**: migration proven; US1+US4 = deployable MVP.

---

## Phase 5: User Story 2 — Themed team generation (Priority: P2)

**Goal**: One model-invented theme per workspace (no theme list in code); proposals carry persona name + role, never keys; system derives keys with suffixing; degenerate duplicate personas bounce 422.

**Independent Test**: Setup run (mock or live) proposes a team → applied agents have derived keys + roles; intra-proposal duplicate persona → 422 `duplicate_name`; existing-workspace persona reuse → silent `-2` suffix; admin-MCP create path returns keys.

### Tests for User Story 2 (write first, red) ⚠️

- [X] T020 [P] [US2] Extend `libs/pipeline/src/setup-apply.service.spec.ts` (or equivalent existing spec): `validateTeam` — intra-proposal duplicate persona name (case-insensitive) → 422 `duplicate_name`; NO error for persona matching an existing workspace agent name; `insertTeamAgents` — keys derived, collision vs existing workspace key → `-2` suffix; `role` persisted (research D4)
- [X] T021 [P] [US2] Extend integration coverage: in-run team apply via `complete_task` outcome "team" creates agents with system-derived keys/roles; second path — backend create API (`POST /api/workspaces/:id/agents`, the admin-MCP passthrough) derives key `hera-reviewer` and suffixes duplicates (spec FR-021 "both creation paths")

### Implementation for User Story 2

- [X] T022 [P] [US2] Update `packages/contracts/src/report.schema.ts` `TeamAgentSchema`: add required `role` (min 1, max 100, description "Developer/QA/Reviewer/…"); `name` description → themed persona display name (Latin script, distinct within the team), drop "unique agent name" wording; no `key` field (contracts-delta §2); update report contract tests
- [X] T023 [US2] Update `libs/pipeline/src/setup-apply.service.ts` `validateTeam` semantics per research D4: keep intra-proposal `duplicate_name` (case-insensitive persona), DROP the duplicate-vs-existing-workspace-name check; keep all lint/status/executor checks intact; T020 goes green
- [X] T024 [US2] Update `libs/pipeline/src/handoff.ts` `buildSetupSection` prose: invent ONE coherent random theme for this workspace (prose examples only, explicitly non-exhaustive — no list the system selects from), each agent gets themed persona `name` (Latin script, distinct) + functional `role`; do NOT emit keys — the system derives them (contracts-delta §6, research D8)
- [X] T025 [P] [US2] Update `packages/contracts/src/admin-tools.schema.ts`: agent write input + optional `role` (persona wording on `name`); list/read items + `key` + `role`; create_agent/create_team responses + `key`; schemas stay `.strict()` (contracts-delta §3)
- [X] T026 [US2] Update `packages/admin-mcp/src/tools.ts`: pass `role` through create_agent/create_team, surface `key` (+`role`) in responses and `list_agents`; update `packages/admin-mcp/src/tools.spec.ts`

**Checkpoint**: both generation paths produce themed, uniquely-keyed teams.

---

## Phase 6: User Story 3 — Persona shown to humans everywhere (Priority: P3)

**Goal**: Dashboard + Jira text show "name (role)"; key visible read-only; deterministic list ordering by key.

**Independent Test**: Agents page shows editable name/role + read-only key; rename keeps key; update payload with `key` → 422; runs/queue/Jira text show persona (role).

### Tests for User Story 3 (write first, red) ⚠️

- [X] T027 [P] [US3] Add/extend dashboard agents API tests (existing controller/integration spec home, e.g. `test/integration/` dashboard suite): create response includes generated `key` + `role`; update with `key` in payload → Zod 422 (strict schema); rename via update leaves `key` unchanged; two same-name agents both saved with distinct keys; list ordered by `key` (spec FR-007/FR-015, research D5/D7)

### Implementation for User Story 3

- [X] T028 [P] [US3] Update `packages/contracts/src/dashboard.schema.ts`: `AgentResponseSchema` + `key` + nullable `role`; `AgentWriteRequestSchema` + optional `role` (still `.strict()`, no `key`); embedded run/human-task `agent` DTOs → `{ id, key, name, role }` (contracts-delta §4)
- [X] T029 [US3] Update `apps/backend/src/dashboard/agents.controller.ts` read side: map `key`/`role` into responses; list `ORDER BY key` (deterministic pagination, research D7)
- [X] T030 [P] [US3] Update `apps/backend/src/dashboard/runs.controller.ts` and `apps/backend/src/dashboard/human-tasks.controller.ts`: include `key`/`role` in embedded agent DTOs
- [X] T031 [US3] Update human-facing text: `libs/pipeline/src/pipeline.service.ts` orchestrator/human-task strings → `name (role)` (role omitted when null); `libs/ingest/src/reconcile.service.ts` log lines → key; verify `libs/jira/src/adf-composer.ts` routed line prints `target_agent` (= key) verbatim — no change expected (spec FR-017)
- [X] T032 [P] [US3] Update `apps/web/src/components/AgentForm/`: editable `role` input alongside persona `name`; `key` rendered as a read-only technical identifier on edit (absent on create — server generates it); form never submits `key`
- [X] T033 [US3] Update `apps/web/src/views/AgentsList.vue`: show persona name + role (e.g. "Hera (Reviewer)" or a role column) and `key` as the technical id; orchestrator row shows role "teamlead"; optionally surface persona in `apps/web/src/views/Runs.vue` / `RunCard.vue` agent tags if trivially available from the updated DTO

**Checkpoint**: all user stories independently functional.

---

## Phase 7: Polish & Cross-Cutting

- [X] T034 [P] Run the name-as-identity audit (spec SC-006): `grep -rn "agents.name" libs apps packages --include='*.ts'` — every remaining hit is display/log-only (no lookup/join/onConflict/dedup); fix stragglers; record the audit in the PR description
- [X] T035 [P] Append the iteration entry to `docs/progress.md` (feature 014: what shipped, decisions D1–D8 pointers, migration 0007)
- [X] T036 Full validation per [quickstart.md](quickstart.md): `pnpm typecheck && pnpm lint && pnpm test` and `pnpm test:integration` (Docker required) — all green; spot-check quickstart §3 curl flows against a compose stack if available

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: none — start immediately. T001 (tests) before T002 (impl).
- **Phase 2 (Foundational)**: needs T002 (slug module). T003 → T004 → (T005, T006 in parallel); T007–T011 after T003+T004 (T007, T008, T010, T011 mutually parallel; T009 same file as T023 but different phase — do T009 here); T012 last in phase.
- **Phase 3 (US1)**: after Phase 2. T013/T014 (tests, parallel) → T015 → T016, T017.
- **Phase 4 (US4)**: after Phase 2 (independent of Phase 3; T018 parallel with US1 work — different files). T019 anytime after Phase 2.
- **Phase 5 (US2)**: after Phase 2; T024 touches `handoff.ts` after T017 (same file — sequence US1 first). T020/T021 (tests) → T022 → T023 → T024; T025 → T026.
- **Phase 6 (US3)**: after Phase 2; T031 touches `pipeline.service.ts` after T016 (same file). T027 (tests) → T028 → T029/T030 → T032/T033.
- **Phase 7 (Polish)**: after all story phases.

### Story Dependency Notes

- US1 and US4 are both P1 and jointly form the MVP; they share the foundational migration but their tasks touch disjoint files.
- US2 depends functionally on nothing from US1 (independently testable via the create-API path) but shares `handoff.ts`/`report.schema.ts` files — execute after US1 to avoid same-file churn.
- US3 is pure presentation over foundational data; shares `pipeline.service.ts` with US1 — execute after.

### Parallel Opportunities

```text
Phase 2: T005 ∥ T006 (docs) while T007/T008/T010/T011 proceed (distinct files)
Phase 3+4: T013 ∥ T014 ∥ T018 (three different test files) — then US1 impl ∥ T019 audit
Phase 5: T020 ∥ T021 ∥ T022 ∥ T025 (four different files)
Phase 6: T028 ∥ T030 ∥ T032 (contracts / backend controllers / web) after T027
Phase 7: T034 ∥ T035
```

---

## Implementation Strategy

**MVP first (US1 + US4)**: Phases 1–4 deliver the identity split, key-based routing, and a proven migration — deployable and demoable on their own (existing UI keeps working: name still displayed, key invisible until US3).

**Incremental delivery**: add US2 (themed generation) → validate with a setup run; add US3 (presentation) → validate in the dashboard; polish/audit last. Single PR per repo workflow with checkpoints at each phase boundary: `pnpm typecheck && pnpm lint && pnpm test` must be green at every checkpoint, `pnpm test:integration` at Phases 2, 4, 5, and 7.

**Handoff bar** (CLAUDE.md): `pnpm typecheck && pnpm lint && pnpm test` + `pnpm test:integration` all green before review; migration SQL reviewed against §3 (T005).
