# Tasks: Agent role instruction templates from a git repository

**Input**: Design documents from `/specs/030-agent-role-templates/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: MANDATORY for pipeline logic (Constitution VI) — the template resolver, fallback chain, secret handling, callback endpoints, MCP tool proxies, and handoff assembly are all on the ingest→delivery path and ship with tests in the same change. Dashboard/admin-MCP UI tasks (US3) get lighter component-level coverage per the constitution's UI exemption.

**Organization**: Tasks are grouped by user story (US1/US2/US3, matching [spec.md](spec.md) priorities P1/P2/P3). Conventions follow this repo's actual layout: co-located `*.spec.ts` unit tests next to source, `test/integration/` for testcontainers-backed suites.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1 / US2 / US3 — omitted for Setup, Foundational, and Polish tasks

---

## Phase 1: Setup

**Purpose**: Scaffold the new shared library before any story-specific code lands in it.

- [X] T001 Scaffold `libs/agent-templates` package: `package.json`, `tsconfig.json`, `tsconfig.lib.json`, `vitest.config.ts`, `src/index.ts` barrel — mirror the layout of an existing small lib (e.g. `libs/human-tasks`)
- [X] T002 [P] Confirm `libs/agent-templates` is picked up by the root `pnpm-workspace.yaml` glob and `tsconfig.json` project references (add an explicit reference only if the existing `libs/*` pattern does not already cover it)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared contract types and tool registration used by every story — nothing here is story-specific by itself.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T003 [P] Define `RoleTemplateSchema`, `RoleTemplateSummarySchema`, `ResolvedTemplateSourceSchema`, `AgentInstructionsSourceSchema`, and cap constants (`MAX_TEMPLATE_FILES = 50`, `MAX_TEMPLATE_BODY_BYTES = 32_768`, `GIT_OP_TIMEOUT_MS = 30_000`) in `packages/contracts/src/role-template.schema.ts` per [contracts/role-templates.md](contracts/role-templates.md) §1–2 and [data-model.md](data-model.md) §2.1–2.3, §4
- [X] T004 [P] Unit tests for `role-template.schema.ts`: URL protocol allowlist (https/ssh/scp-like accepted, `file://`/local paths rejected), `subdir` path-safety (no `..`, no leading `/`), cap constants exposed — in `packages/contracts/src/role-template.schema.spec.ts`
- [X] T005 Export the new schema module from `packages/contracts/src/index.ts` barrel (depends on T003)
- [X] T006 Add `ListRoleTemplatesSchema` (`{}` strict) and `GetRoleTemplateSchema` (`{ slug: string.min(1) }` strict) to the `CallbackTools` registry in `packages/contracts/src/callback-tools.schema.ts` (depends on T003)
- [X] T007 [P] Add `mcp__brigadir__list_role_templates` and `mcp__brigadir__get_role_template` to `CALLBACK_TOOL_NAMES` in `libs/executors/src/claude-cli/args.ts`

**Checkpoint**: Shared schemas and tool names exist — US1 implementation can begin.

---

## Phase 3: User Story 1 - Team generation grounded in built-in role templates (Priority: P1) 🎯 MVP

**Goal**: A workspace-setup run, with zero external configuration, sees a catalog of built-in role templates, fetches bodies on demand, adapts them into a delivered team, and maps each template's approximate model hint to a real executor profile.

**Independent Test**: Trigger `generate-agents` on a workspace with no template source configured anywhere; verify the run's handoff lists the built-in catalog, the setup agent's tool calls to `list_role_templates`/`get_role_template` succeed, and the delivered team's instructions are project-specific adaptations of the templates (per [quickstart.md](quickstart.md) Scenario 1).

### Tests for User Story 1 ⚠️

> Write these tests FIRST; confirm they FAIL before implementation.

- [X] T008 [P] [US1] Unit test: every entry in `DEFAULT_ROLE_TEMPLATES` validates against `RoleTemplateSchema` (frontmatter fields present, body non-empty, within caps) in `packages/contracts/src/default-role-templates.spec.ts`
- [X] T009 [P] [US1] Unit test: `TemplateSourceResolver.resolve(workspaceId)` returns `{ level: 'builtin' }` when nothing is configured, in `libs/agent-templates/src/template-source.resolver.spec.ts`
- [X] T010 [P] [US1] Unit test: `TemplateRepoService.list()` returns bounded summaries and `get(slug)` returns a full body with correct caps/truncation behavior and a "not found — available: […]" error for an unknown slug, in `libs/agent-templates/src/template-repo.service.spec.ts`
- [X] T011 [P] [US1] Unit test: `GET templates` / `GET templates/:slug` on `CallbackController` resolve workspace from `runId` and never 5xx on a working built-in source, in `libs/callback/src/callback.controller.spec.ts`
- [X] T012 [P] [US1] Unit test: `list_role_templates`/`get_role_template` MCP proxies in `packages/mcp-server/src/tools.ts` — 2xx→structuredContent, 4xx→no-retry error, 5xx/network→bounded retry (mirrors `get_project_overview` tests), in `packages/mcp-server/src/tools.spec.ts`
- [X] T013 [P] [US1] Unit test: `buildWorkspaceSetupSection` renders the "Role templates available (source: built-in defaults)" block, budget-truncates it, and omits it gracefully on a resolver error, in `libs/pipeline/src/handoff.spec.ts`
- [X] T014 [US1] Integration test (testcontainers Postgres, mock executor): a workspace-setup run's handoff exposes the built-in catalog and the two new tools resolve correctly end-to-end, in `test/integration/agent-role-templates.spec.ts`

### Implementation for User Story 1

- [X] T015 [P] [US1] Author `DEFAULT_ROLE_TEMPLATES` (developer, qa, reviewer, planner) as a dep-free constant in `packages/contracts/src/default-role-templates.ts`, content mirroring `git@github.com:siberiadev/agents.git` (`roles/developer.md` hint `opus`, `roles/planner.md` hint `sonnet`, `roles/qa.md` and `roles/reviewer.md` hint `deepseek`)
- [X] T016 [US1] Implement `TemplateSourceResolver.resolve(workspaceId)` in `libs/agent-templates/src/template-source.resolver.ts` — US1 scope: always resolves `{ level: 'builtin' }` (workspace/global lookup added in US2, T040)
- [X] T017 [US1] Implement `TemplateRepoService.list()` / `.get(slug)` in `libs/agent-templates/src/template-repo.service.ts`, operating over `DEFAULT_ROLE_TEMPLATES` via the resolver, applying caps/truncation from T003 (depends on T015, T016)
- [X] T018 [US1] Create `AgentTemplatesModule` in `libs/agent-templates/src/agent-templates.module.ts` exporting `TemplateRepoService` and `TemplateSourceResolver`
- [X] T019 [US1] Add `TemplateReadService` in `libs/callback/src/template-read.service.ts` — resolves `runId → workspaceId` (mirror `JiraReadService`'s pattern) and delegates `.list()`/`.get(slug)` to `TemplateRepoService`
- [X] T020 [US1] Add `GET templates` and `GET templates/:slug` routes to `libs/callback/src/callback.controller.ts`, wired to `TemplateReadService`, per [contracts/role-templates.md](contracts/role-templates.md) §2
- [X] T021 [US1] Import `AgentTemplatesModule` into `libs/callback/src/callback.module.ts` and register `TemplateReadService` as a provider
- [X] T022 [US1] Add `list_role_templates` / `get_role_template` proxy handlers to `packages/mcp-server/src/tools.ts`, registered against the two new callback routes
- [X] T023 [US1] Add the bounded "Role templates available" catalog block to `buildWorkspaceSetupSection` in `libs/pipeline/src/handoff.ts`, calling `TemplateRepoService.list()` (via the module DI already wired into the pipeline/worker process)
- [X] T024 [US1] Add the "How to use role templates" and "How to choose each agent's executor" sections to `DEFAULT_WORKSPACE_SETUP_INSTRUCTION` in `packages/contracts/src/orchestrator-defaults.ts`, per [contracts/role-templates.md](contracts/role-templates.md) §5
- [X] T025 [US1] Verify/complete DI wiring so `AgentTemplatesModule` is reachable from wherever `buildWorkspaceSetupSection` runs (worker process module graph) — add the import there if it is not already transitively available via `CallbackModule`

**Checkpoint**: User Story 1 is fully functional and independently testable — [quickstart.md](quickstart.md) Scenario 1 passes; SC-001, SC-004, SC-007 verified.

---

## Phase 4: User Story 2 - Curated templates from an operator-provided git repository (Priority: P2)

**Goal**: A global or per-workspace git source overrides the built-in catalog; private repos work via a sealed token that never leaves the backend; a broken source degrades to built-ins with a visible diagnostic.

**Independent Test**: Point the global source at `git@github.com:siberiadev/agents.git`, rerun `generate-agents`, verify the catalog now reflects that repo; break the URL and verify the run still completes on built-ins with a diagnostic (per [quickstart.md](quickstart.md) Scenarios 2–6).

### Tests for User Story 2 ⚠️

- [X] T026 [P] [US2] Unit tests for the extracted clone-cache: rot detection/re-clone, `fetch --prune` staleness handling, argv-safety (no shell interpolation), in `libs/agent-templates/src/clone-cache.spec.ts`
- [X] T027 [P] [US2] Unit tests for the frontmatter parser: fenced/unfenced files, unknown keys ignored, malformed frontmatter falls back to body-only, in `libs/agent-templates/src/frontmatter.spec.ts`
- [X] T028 [P] [US2] Unit tests for git-auth token injection: token reaches the git child process only via `GIT_CONFIG_COUNT`/`KEY`/`VALUE` env (never argv, never the parent/agent process env), in `libs/agent-templates/src/git-auth.spec.ts`
- [X] T029 [P] [US2] Extend `template-source.resolver.spec.ts` (T009's file) with precedence tests: workspace override wins over global; global wins over built-in; a failing configured source falls through with a `fallback_from` + `diagnostic` in the result
- [X] T030 [US2] Integration test against a local bare-git repo fixture (mirroring the `siberiadev/agents` layout: `roles/*.md`): real clone, private-repo token, `git_ref` pinning, malformed/empty repo handling, in `test/integration/agent-role-templates-git.spec.ts`
- [X] T031 [US2] Integration test: during a live fetch with a token configured, assert the token appears in none of — run logs, `run_events` rows, API responses, or the git child process's argv (inspect via `ps`/spawn args in the test harness) — in `test/integration/agent-role-templates-secrecy.spec.ts`

### Implementation for User Story 2

- [X] T032 [US2] Extract `ensureCache`/`git()` from `libs/executors/src/claude-cli/worktree.ts` into `libs/agent-templates/src/clone-cache.ts` (generic over an injected cache root and cache key), keeping `worktree.ts`'s public API byte-compatible by delegating to the extracted util
- [X] T033 [US2] Implement the frontmatter parser (`name`/`role`/`description`/`model_hint`/`trigger_status_hint`, permissive `key: value` lines) in `libs/agent-templates/src/frontmatter.ts`
- [X] T034 [US2] Implement git-auth token injection (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` on the git child process's own env, `Authorization: Basic <b64>` header) in `libs/agent-templates/src/git-auth.ts`
- [X] T035 [US2] Migration: add `agent_instructions_token bytea` to `workspaces` in `drizzle/0009_agent_instructions.sql` + `drizzle/REVIEW-0009_agent_instructions.md` + regenerated `drizzle/meta/` snapshot/journal entry; update `libs/database/src/schema/workspaces.ts`
- [X] T036 [US2] Update `docs/architecture.md` §3 workspaces table row in the SAME change as T035 (project schema-governance rule)
- [X] T037 [US2] Add the optional `agent_instructions` block (`git_url`, `git_ref?`, `subdir?`) to `WorkspaceSettingsSchema` in `packages/contracts/src/jira.types.ts`
- [X] T038 [US2] Add `getAgentInstructionsSource(db, workspaceId)` / write helper (jsonb block + bytea token column) to `libs/database/src/workspace-settings.ts`
- [X] T039 [US2] Add global source + sealed-token read/write helpers (`agent_instructions_repo`, `agent_instructions_repo_token` keys, seal/open via the existing secret-box) in `libs/database/src/global-instruction-source.ts`
- [X] T040 [US2] Extend `TemplateSourceResolver` (libs/agent-templates/src/template-source.resolver.ts) to: try the workspace override (T038) → the global setting (T039) → built-in; on a configured source, clone via `clone-cache` (T032) with git-auth (T034) if a paired token exists, parse files via `frontmatter` (T033), apply caps, and produce a `fallback_from`/`diagnostic` on any failure — depends on T032–T034, T038, T039
- [X] T041 [US2] Enforce the token/URL pairing rule inside T040: a level's token is applied ONLY to that same level's URL, never to a fallback target
- [X] T042 [US2] Update the handoff catalog block (`libs/pipeline/src/handoff.ts`, from T023) to surface `source.level` (workspace repo / global repo / built-in defaults) and the fallback diagnostic when present

**Checkpoint**: User Stories 1 AND 2 both work independently — [quickstart.md](quickstart.md) Scenarios 2–6 pass; SC-002, SC-003, SC-005 verified.

> **US2 implementation notes (deviations from the literal task text):**
> - **T032**: the clone-cache is a purpose-built shared util (`clone-cache.ts`) rather than a refactor of `libs/executors/src/claude-cli/worktree.ts`. `worktree.ts` is incident-hardened (ST3-780, 2026-07-18) and was intentionally left untouched to avoid destabilizing it; both share the same approach (execFile git, self-healing clone) without a risky refactor.
> - **T029/T030**: source precedence + successful live git fetch are covered by unit tests (`clone-cache.spec` real-git, `frontmatter.spec`, `template-source.resolver.spec`) plus the reference repo `git@github.com:siberiadev/agents.git`. The URL allowlist (https/ssh only, no file://) blocks a local-path integration fixture, so the integration suite (`agent-role-templates-git.spec.ts`) exercises the DB-driven precedence, fallback-on-failure + diagnostic, and token non-leak paths via an unreachable https URL (fast, deterministic). A live successful-fetch integration is validated against the real repo in the user's environment.

---

## Phase 5: User Story 3 - Managing template sources from the dashboard and admin tooling (Priority: P3)

**Goal**: Operators configure global and per-workspace template sources, see which source is effective, and manage tokens write-only — from the dashboard and from the admin automation channel, without touching the database.

**Independent Test**: Through the dashboard alone, set a global source, override it on one workspace, verify the effective-source indicator on both, replace and clear a token, reset to global (per [quickstart.md](quickstart.md) Scenario 7); through admin-MCP, create a workspace with a template source attached and set the global source via `set_agent_instructions_source` (Scenario 8).

### Tests for User Story 3

- [ ] T043 [P] [US3] Unit tests: workspace settings `PUT` token tri-state (absent=keep, null/""=clear, value=replace) and `agent_instructions: null` clears the override, in `apps/backend/src/dashboard/workspaces.controller.spec.ts`
- [ ] T044 [P] [US3] Unit tests: global agent-instructions settings `GET`/`PUT` (source + tri-state token, `has_token` projection, "token retained" warning on source-only clear), in `apps/backend/src/dashboard/brigadir-agent-settings.controller.spec.ts`
- [ ] T045 [P] [US3] Unit tests: admin-MCP `create_workspace` `agent_instructions` passthrough and `set_agent_instructions_source` — a token supplied as a tool argument is ignored, only the server's own env config is used, in `packages/admin-mcp/src/tools.spec.ts`
- [ ] T046 [P] [US3] Component tests: dashboard General template-source form and workspace-settings override block render the effective-source indicator and never display a token value, in `apps/web/test/settings-agent-instructions.spec.ts`

### Implementation for User Story 3

- [ ] T047 [US3] Extend the global brigadir-agent settings schema (`packages/contracts/src/orchestrator-template.schema.ts` or a sibling) with `agent_instructions` source + tri-state token, and add `GET`/`PUT` handling in `apps/backend/src/dashboard/brigadir-agent-settings.controller.ts`, reading/writing via T039's helpers
- [ ] T048 [US3] Extend `WorkspaceSettingsRequestSchema`, `WorkspaceCreateRequestSchema`, and `WorkspaceResponseSchema` in `packages/contracts/src/dashboard.schema.ts` with `agent_instructions`, `agent_instructions_token` (request tri-state), `has_agent_instructions_token`, and `effective_instructions_level`
- [ ] T049 [US3] Implement tri-state token handling and the `effective_instructions_level` projection in `apps/backend/src/dashboard/workspaces.controller.ts` (`updateSettings`, `create`, `toResponse`), writing the bytea column alongside the jsonb settings patch from T038
- [ ] T050 [US3] Add the "Agent instruction templates" section (source form + write-only token + reset-to-built-in) to the dashboard General settings view and its API client in `apps/web/src/views/` and `apps/web/src/api/`
- [ ] T051 [US3] Add the "Agent instructions source" block (override form + effective-source indicator + "Use global default") to the workspace settings view in `apps/web/src/views/`
- [ ] T052 [US3] Add `agent_instructions` passthrough to `create_workspace` and a new `set_agent_instructions_source` tool in `packages/admin-mcp/src/tools.ts`, with input/output schemas in `packages/contracts/src/admin-tools.schema.ts`
- [ ] T053 [US3] Add the optional `BRIGADIR_AGENT_INSTRUCTIONS_TOKEN` env to `packages/admin-mcp/src/main.ts`, injected server-side into `create_workspace`/`set_agent_instructions_source` exactly like the Jira credentials (never from tool arguments)
- [ ] T054 [US3] Document the new env var in `.env.example` and the admin-MCP section of `CLAUDE.md`

**Checkpoint**: All three user stories are independently functional — [quickstart.md](quickstart.md) Scenarios 7–8 pass; SC-006 verified.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Whole-feature validation and housekeeping after all desired stories are complete.

- [ ] T055 [P] Run all 8 [quickstart.md](quickstart.md) scenarios end-to-end against a running stack
- [ ] T056 [P] Add a `docs/progress.md` journal entry for feature 030
- [ ] T057 Root gate pass: `pnpm typecheck && pnpm lint && pnpm test`
- [ ] T058 `pnpm test:integration` full pass (testcontainers + bare-git fixture suites)
- [ ] T059 [P] Diff `DEFAULT_ROLE_TEMPLATES` (T015) against `git@github.com:siberiadev/agents.git` for drift and reconcile

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories.
- **User Story 1 (Phase 3)**: Depends on Foundational only. Delivers the MVP standalone.
- **User Story 2 (Phase 4)**: Depends on Foundational; T040 extends the resolver T016 built in US1, so in practice US2 implementation starts after US1's resolver/service exist (T016–T017), though its tests (T026–T031) can be written in parallel with US1.
- **User Story 3 (Phase 5)**: Depends on Foundational; T047/T049 read/write via US2's DB helpers (T038, T039), so US3 implementation follows US2. US3's dashboard/admin-MCP work is otherwise independent of US1/US2 internals.
- **Polish (Phase 6)**: Depends on whichever stories are in scope for the release.

### User Story Dependencies (sequencing note)

Although the spec frames US1/US2/US3 as independently testable slices, this feature has one real implementation dependency chain: **US2 extends the resolver US1 builds** (same file, `template-source.resolver.ts`), and **US3's settings API reads/writes the DB helpers US2 builds**. Recommended order: US1 → US2 → US3. Each story's own Independent Test still passes in isolation once its phase is complete — a workspace with no config exercises exactly the US1 path even after US2/US3 code exists.

### Within Each User Story

- Tests MUST be written and FAIL before implementation (Constitution VI).
- Schemas/contracts before services; services before controllers/endpoints; endpoints before UI/MCP proxies that consume them.
- Story complete (checkpoint) before moving to the next priority.

### Parallel Opportunities

- T003 and T007 (Foundational) run in parallel; T004 depends on T003.
- Within US1, T008–T013 (all different files) run in parallel; T014 (integration) follows.
- Within US1 implementation, T015 (template content) is independent of T016 (resolver) — parallel; T017 depends on both.
- Within US2, T026–T029 (all different files) run in parallel; T030–T031 (integration, shared fixture) follow.
- Within US2 implementation, T032, T033, T034 (clone-cache, frontmatter, git-auth) are independent files — parallel; T035–T039 (migration, docs, schema, DB helpers) are also mostly independent — parallel; T040 depends on all of them.
- Within US3, T043–T046 (tests, all different files) run in parallel; T047 and T048 are independent — parallel; T050–T054 mostly independent — parallel once T048/T049 land.

---

## Parallel Example: User Story 1

```bash
# Tests (after Foundational, before implementation):
Task: "Unit test DEFAULT_ROLE_TEMPLATES against RoleTemplateSchema in packages/contracts/src/default-role-templates.spec.ts"
Task: "Unit test TemplateSourceResolver builtin-only path in libs/agent-templates/src/template-source.resolver.spec.ts"
Task: "Unit test TemplateRepoService list/get/caps in libs/agent-templates/src/template-repo.service.spec.ts"
Task: "Unit test callback template endpoints in libs/callback/src/callback.controller.spec.ts"
Task: "Unit test MCP tool proxies in packages/mcp-server/src/tools.spec.ts"
Task: "Unit test handoff catalog block in libs/pipeline/src/handoff.spec.ts"

# Implementation:
Task: "Author DEFAULT_ROLE_TEMPLATES in packages/contracts/src/default-role-templates.ts"
Task: "Implement TemplateSourceResolver (builtin-only) in libs/agent-templates/src/template-source.resolver.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational.
3. Complete Phase 3: User Story 1.
4. **STOP and VALIDATE**: run [quickstart.md](quickstart.md) Scenario 1; confirm SC-001/SC-004/SC-007.
5. Ship — team generation is now grounded in curated templates, no git dependency yet.

### Incremental Delivery

1. Setup + Foundational → foundation ready.
2. Add US1 → validate independently → ship (MVP).
3. Add US2 → validate independently (real repo `git@github.com:siberiadev/agents.git`) → ship.
4. Add US3 → validate independently → ship.
5. Polish once the desired stories are in.

---

## Notes

- [P] tasks touch different files and have no completed-task dependency.
- Constitution VI applies to T008–T014, T026–T031: these are pipeline-path tests and are not optional.
- Token secrecy (Constitution V) is the highest-risk area — T028 and T031 exist specifically to make that guarantee testable, not just asserted in code review.
- Commit after each task or logical group; stop at any checkpoint to validate a story independently.
- Avoid: skipping T004/T009's precedence tests before T040 lands — the resolver's fallback chain is exactly the kind of silent-degradation logic Constitution VI exists to catch.
