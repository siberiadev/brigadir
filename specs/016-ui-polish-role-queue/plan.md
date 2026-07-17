# Implementation Plan: UI polish — agent role & executor visibility, human queue ordering

**Branch**: `016-ui-polish-role-queue` | **Date**: 2026-07-17 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/016-ui-polish-role-queue/spec.md`

## Summary

Four small dashboard improvements: (1) a "Role" column in the workspace runs list (data already present in `RunAgentRefSchema.role`, em-dash fallback); (2) the needs-human queue's OPEN tab flips from oldest-first to newest-first — one server-side `ORDER BY` change in `HumanTasksController.list()` shared by the global page and the workspace tab, with a deterministic `id` tie-breaker; (3) the Agents page splits "Name (role)" into a Name column and a separate Role column rendered as an `el-tag`; (4) the Agents page gains an "Executor" column resolving `executor_id` → executor profile name via the existing `useExecutors` composable. No schema, migration, or contract-shape changes; frontend + integration tests updated in the same iteration.

## Technical Context

**Language/Version**: TypeScript strict (per constitution), Node 22, Vue 3 (`<script setup>`), NestJS 11

**Primary Dependencies**: Element Plus (el-table/el-tag), TanStack Query (vue-query), Drizzle ORM, zod contracts in `packages/contracts`

**Storage**: PostgreSQL 16 (read-only for this feature — one `ORDER BY` change, no schema/migration changes)

**Testing**: apps/web — Vitest + jsdom + @vue/test-utils + MSW (`apps/web/test/*.spec.ts`, harness `test/mount.ts`); backend — integration tests via vitest + testcontainers (`test/integration/*.spec.ts`)

**Target Platform**: Self-hosted web dashboard (backend REST + Vue SPA)

**Project Type**: Web application (pnpm monorepo: `apps/backend`, `apps/web`, `packages/contracts`)

**Performance Goals**: N/A — display-only changes; executor lookup is one cached platform-scoped list query (executors are few)

**Constraints**: UI conventions from CLAUDE.md — brand colors only via `--el-color-*`, shared `<ListPagination>`/`usePagination` (untouched here), lucide icons static outside sidebar (no new icons introduced); paginated endpoints require deterministic `ORDER BY`

**Scale/Scope**: 3 Vue components touched (`Runs.vue`, `AgentsList.vue`, plus test fixtures), 1 controller method (`human-tasks.controller.ts`), 0 contract schema changes, ~4 test files touched

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Applies? | Status | Notes |
|---|---|---|---|
| I. Dual Source of Truth | Marginal | ✅ PASS | Read path only; human tasks remain Postgres-authoritative. No new source of truth, no Jira reads/writes. |
| II. Idempotency at Three Levels | No | ✅ PASS | No run-triggering path touched. |
| III. System-Only Jira Writes | No | ✅ PASS | No Jira interaction. |
| IV. Run Completion Contract | No | ✅ PASS | Run lifecycle untouched. |
| V. Secret Isolation & Output Scrubbing | No | ✅ PASS | No secrets involved; executor list already omits API keys (`has_api_key` boolean only). |
| VI. Test-Mandatory Pipeline Logic | Yes (lightly) | ✅ PASS | The ordering change lives in a dashboard read endpoint, not pipeline logic, so the UI "lighter coverage" clause applies — but spec FR-009 self-imposes tests in the same change: existing integration test `test/integration/human-queue.spec.ts` (asserts oldest-first at L78-87) is updated to newest-first; new web component tests cover the new columns. |
| Technology Constraints | Yes | ✅ PASS | No new dependencies; strict TS; contracts unchanged; no `@Module()`-decorator resource init (no module changes at all). |

**Initial gate: PASS** (no violations; Complexity Tracking empty).
**Post-design re-check: PASS** — design introduces no new projects, dependencies, or contract changes; the only backend delta is two lines of `orderBy`.

## Project Structure

### Documentation (this feature)

```text
specs/016-ui-polish-role-queue/
├── spec.md              # Feature specification
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── human-tasks-ordering.md   # Behavioral contract delta (no schema changes)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
apps/backend/src/dashboard/
└── human-tasks.controller.ts     # MODIFY: open-tab orderBy (L92-93) → desc(created_at), desc(id);
                                  #         closed-tab orderBy (L87) gains desc(id) tie-breaker

apps/web/src/views/
├── Runs.vue                      # MODIFY: add "Role" column (row.agent.role ?? '—')
└── AgentsList.vue                # MODIFY: Name column drops "(role)" suffix; new Role column (el-tag);
                                  #         new Executor column (name via executors lookup)

apps/web/src/composables/
└── useExecutors.ts               # REUSE as-is (TanStack query, key ['executors'])

packages/contracts/src/
├── runs.schema.ts                # NO CHANGE — RunAgentRefSchema already carries role (L34-36)
├── human-queue.schema.ts         # NO CHANGE — response shape identical, only row order changes
└── dashboard.schema.ts           # NO CHANGE — AgentResponseSchema already carries role + executor_id

apps/web/test/
├── runs-table.spec.ts            # MODIFY: assert Role column + em-dash fallback
├── human-queue.spec.ts           # MODIFY/EXTEND: open tab newest-first rendering
├── agents-columns.spec.ts        # NEW: Name/Role split, el-tag, empty cells, Executor name resolution + fallback
└── handlers.ts                   # MODIFY: fixtures — agent roles, executors list handler if absent

test/integration/
└── human-queue.spec.ts           # MODIFY: flip "open → oldest-first" assertion (L78-87) to newest-first;
                                  #         add same-instant created_at tie-breaker case
```

**Structure Decision**: Existing web-application monorepo layout is used as-is; no new files outside one new web test spec. The feature is deliberately confined to two Vue views, one controller method, and test files.

## Complexity Tracking

No constitution violations — table intentionally empty.
