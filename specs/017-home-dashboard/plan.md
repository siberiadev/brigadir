# Implementation Plan: Home Dashboard

**Branch**: `claude/home-dashboard-spec-5n1pyt` | **Date**: 2026-07-17 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/017-home-dashboard/spec.md`

## Summary

New landing page `/home` answering four questions at a glance: does the system need me (human-queue hero), what's running (live runs + tiles), what broke in 24h (needs-attention list + workspace markers), what does it cost (platform spend 24h/7d/30d). Backend: two new read-only aggregate endpoints under a new `HomeController` (`GET /api/home/summary`, `GET /api/home/workspaces`) plus a bounded cross-workspace runs listing `GET /api/runs` in the existing `RunsController`. Frontend: `HomeDashboard.vue` + six block components, `/` → `/home` redirect, workspace list moved to `/workspaces` (route name preserved), Home added first in the sidebar. Zero DB schema changes; all new shapes in `packages/contracts/src/home.schema.ts`. Full design rationale in [research.md](research.md); wire shapes in [data-model.md](data-model.md) and [contracts/](contracts/).

## Technical Context

**Language/Version**: TypeScript strict (workspace-wide), Node 22, pnpm monorepo

**Primary Dependencies**: NestJS 11 + Drizzle (`@brigadir/database`) on backend; Vue 3.5 + Element Plus 2.9 + `@tanstack/vue-query` 5 + vue-router 4 + `lucide-vue-next` on web; zod v4 in `packages/contracts`

**Storage**: Postgres 16 (read-only queries against existing `runs`, `workspaces`, `agents`, `tickets`, `human_tasks`); Redis untouched by this feature

**Testing**: Vitest everywhere — contract specs colocated in `packages/contracts`; integration in `test/integration` (testcontainers, shared PG/Redis containers, per-suite DB + `BULLMQ_PREFIX` namespace); web in `apps/web/test` (jsdom, `@vue/test-utils`, msw, `mountWithProviders`)

**Target Platform**: self-hosted Linux (docker compose), evergreen browsers for the dashboard

**Project Type**: web application (NestJS backend + Vue SPA + shared contracts package)

**Performance Goals**: Home renders within the same envelope as existing pages; exactly 4 polled data sources for the whole page (summary 5s, global runs ×2 5s, home-workspaces 15s, plus the hero reusing the existing 4s open-tasks query); browser request count independent of workspace count

**Constraints**: no DB schema changes (FR-029 — confirmed viable, research R5); global runs listing bounded by contract (required status filter + limit ≤ 50); no pagination on dashboard blocks; brand colors only via `--el-color-*`; icons static outside sidebar; deterministic ORDER BY on every query

**Scale/Scope**: internal team tool — few workspaces (grid renders all), runs table in the thousands (seq scans acceptable; escalation path documented in research R5); ~6 new Vue components, 3 new endpoints, 1 new contracts module

## Constitution Check

*GATE: evaluated against constitution v1.2.0 before Phase 0; re-checked after Phase 1 design.*

| Principle | Verdict | Notes |
|---|---|---|
| I. Dual Source of Truth | ✅ PASS | Read-only dashboard over Postgres run/human-task state; no ticket-status inference, no Jira reads/writes, no third source introduced. |
| II. Idempotency at Three Levels | ✅ N/A | No run-triggering path added or modified. |
| III. System-Only Jira Writes | ✅ PASS | No Jira interaction at all; `deep_link` URLs are client-side navigation only. |
| IV. Run Completion Contract | ✅ N/A | No run lifecycle changes; new endpoints only read statuses written by the pipeline. |
| V. Secret Isolation & Output Scrubbing | ✅ PASS | New responses serialize no credentials (contract test asserts shapes; `jira_credentials`/tokens never selected). Dashboard token handled by existing guard; frontend token flow unchanged. |
| VI. Test-Mandatory Pipeline Logic | ✅ PASS | Not pipeline logic (UI + read-only aggregates), so lighter coverage would be permitted — but the spec (FR-028) mandates contract + integration + component tests in-iteration anyway; test map in research R9. |
| Technology Constraints | ✅ PASS | Stack unchanged; no `@Module()`-decorator resource init (new controller uses existing DI `DRIZZLE` injection); shared types in `packages/contracts`; TS strict. |
| Development Workflow | ✅ PASS | Single-PR-sized iteration; no cut features reintroduced (no RBAC, no push/SSE — polling only, per spec out-of-scope). |

**Post-design re-check (after Phase 1)**: PASS — design artifacts introduce no violations. Notable clean-bill items: `GET /api/runs` reuses the existing guard + error helpers; summary spend windows on `created_at` specifically to preserve single-source consistency with the per-workspace figure (SC-004); no new indexes (schema §3 untouched per project rule 5). **No Complexity Tracking entries needed.**

## Project Structure

### Documentation (this feature)

```text
specs/017-home-dashboard/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions R1..R10
├── data-model.md        # Phase 1 — read-model shapes
├── quickstart.md        # Phase 1 — validation guide
├── contracts/
│   ├── home-api.md          # GET /api/home/summary, GET /api/home/workspaces
│   ├── runs-global-api.md   # GET /api/runs (bounded cross-workspace listing)
│   └── web-routing-ui.md    # routing change + page composition contract
└── tasks.md             # Phase 2 (/speckit-tasks — NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
packages/contracts/src/
├── home.schema.ts               # NEW: HomeSummary*, HomeWorkspace*, GlobalRuns* schemas
├── home.schema.spec.ts          # NEW: contract tests
└── index.ts                     # export added

apps/backend/src/dashboard/
├── home.controller.ts           # NEW: api/home/summary, api/home/workspaces
├── runs.controller.ts           # MODIFIED: + @Get('api/runs') global listing
└── dashboard.module.ts          # MODIFIED: register HomeController

test/integration/
├── home-summary.spec.ts         # NEW
├── runs-global.spec.ts          # NEW
├── home-workspaces.spec.ts      # NEW
└── dashboard-auth.spec.ts       # MODIFIED: guard coverage for 3 new routes

apps/web/src/
├── router/index.ts              # MODIFIED: / → /home redirect, /home, /workspaces
├── App.vue                      # MODIFIED: remove one-shot /→/human-queue redirect
├── components/AppSidebar.vue    # MODIFIED: Home first item; workspaces item path/active
├── views/HomeDashboard.vue      # NEW: page shell + layout
├── components/Home/
│   ├── StatTiles.vue            # NEW
│   ├── HumanQueueHero.vue       # NEW
│   ├── NeedsAttentionList.vue   # NEW
│   ├── LiveRunsList.vue         # NEW
│   ├── SpendCard.vue            # NEW
│   └── WorkspaceCardsGrid.vue   # NEW
├── api/home.ts                  # NEW: summary + home-workspaces fetchers
├── api/runs.ts                  # MODIFIED: + global runs fetcher
└── composables/
    ├── useHomeSummary.ts        # NEW (5s poll)
    ├── useGlobalRuns.ts         # NEW (5s poll, placeholderData)
    └── useHomeWorkspaces.ts     # NEW (15s poll)

apps/web/test/
├── home-dashboard.spec.ts       # NEW: block behaviors, ticker, switcher, degradation
├── app-sidebar.spec.ts          # MODIFIED: new nav + routing expectations
├── handlers.ts                  # MODIFIED: default handlers + fixtures for 3 new endpoints
└── (any spec seeding initialPath:'/')  # MODIFIED where affected by the redirect
```

**Structure Decision**: Existing three-tier monorepo layout is reused as-is — shared zod contracts in `packages/contracts` consumed by both `apps/backend` (new `HomeController` beside its dashboard siblings) and `apps/web` (new view + `components/Home/` block folder, mirroring the `components/HumanQueue/` precedent). No new packages, modules, or test roots.

## Phase 0 → 1 outputs

- **research.md** — R1 controller placement; R2 global-runs contract (required status CSV, limit clamp, fixed composite ordering); R3 summary composition (spend all-periods, `created_at` window for SC-004 consistency, `finished_at` for failure windows); R4 dedicated `/api/home/workspaces` over extending the paginated list (the decision the spec delegated to planning); R5 no-schema-change viability + escalation path; R6 routing/sidebar + removal of the `App.vue` one-shot redirect (the single behavioral deletion — reviewer attention flagged); R7 composables/polling map; R8 contracts style; R9 test map; R10 ruled-out items (no `ticket.summary` on human tasks — hero uses task `title`; no runtime zod on web; no agent-context script in repo).
- **data-model.md** — HomeSummary, GlobalRunListItem/GlobalRunsResponse, HomeWorkspaceItem/HomeWorkspacesResponse, reused HumanQueueItem, client-side view state.
- **contracts/** — three contract documents (above).
- **quickstart.md** — command-level validation guide mapped to SC-001..SC-007.
- **Agent context update**: N/A — no `update-agent-context` script exists in `.specify/scripts/bash/`; CLAUDE.md needs no changes for this feature (no new conventions introduced; existing UI-convention and pagination sections already cover the rules this feature obeys).

## Complexity Tracking

No constitution violations — table intentionally empty.
