# Implementation Plan: Agent Identity — persona name, role, and routing key

**Branch**: `014-agent-identity` (working branch: `claude/brigadir-agent-identity-c86ad6`) | **Date**: 2026-07-16 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/014-agent-identity/spec.md`

## Summary

Split the agent's single `name` field (currently unique per workspace and used as identity in routing, seeding, and validation) into three concerns: `id` (existing UUID — the only internal reference), `key` (new NOT NULL immutable readable slug, `UNIQUE(workspace_id, key)` — the only handle at the LLM/UI boundary), and `name` + `role` (editable presentation: themed persona + function). One canonical `slugifyAgentKey(name, role)` in `packages/contracts` generates the key exactly once on every creation path; updates never touch it. The orchestrator roster and `routing.target_agent` switch from name to key; team generation prompts instruct the model to invent ONE random theme per workspace (no theme list in code). Ships with migration `0007` + SQL review doc, architecture.md §3 sync, and unit + integration tests in the same iteration.

## Technical Context

**Language/Version**: TypeScript 5.x, `strict: true` (pnpm monorepo)

**Primary Dependencies**: NestJS 11, Drizzle ORM (raw-SQL migrations in `drizzle/`), BullMQ 5, Zod 4 (`packages/contracts`), Vue 3 + Element Plus (`apps/web`), `@modelcontextprotocol/sdk` (`packages/admin-mcp`)

**Storage**: Postgres 16 (system of record; `agents` table changes), Redis (unaffected — no durable state)

**Testing**: Vitest unit (`pnpm test`) + integration against real Postgres/Redis via testcontainers (`pnpm test:integration`, shared containers per run, `BULLMQ_PREFIX` namespacing)

**Target Platform**: Linux/macOS server (docker compose: postgres, redis, backend, worker) + browser dashboard

**Project Type**: Web service + worker + SPA monorepo (`apps/backend`, `apps/web`, `libs/*`, `packages/*`)

**Performance Goals**: N/A — no hot-path changes; key resolution is one indexed lookup at report-processing time

**Constraints**: Migration must backfill NOT NULL `key` deterministically on live data with zero manual fixes; `routing.target_agent` field name is kept (semantics change from name to key); pagination keeps a deterministic ORDER BY after name uniqueness is dropped

**Scale/Scope**: ~13 edit sites across 5 libs, 2 packages, 2 apps; 1 migration; ≤ 20 agents per workspace (existing cap)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | Principle | Verdict | Notes |
|---|-----------|---------|-------|
| I | Dual Source of Truth | ✅ Pass | name/role/key are presentation/handle only (spec FR-020); run lifecycle, tickets, and reconciliation untouched. |
| II | Idempotency at Three Levels | ✅ Pass | All three layers key on ids (`runs_one_active` on `(ticket_id, agent_id)`, queue dedup on `ticket:agent`) — ids unchanged. No layer touched. |
| III | System-Only Jira Writes | ✅ Pass | Only display strings in ADF/human-task text change ("name (role)", key); the write path and per-issue queue are untouched. |
| IV | Run Completion Contract | ✅ Pass with care | `ReportSchema` gains `role` in `TeamAgentSchema` and re-documents `target_agent` as key. Validation applies at submission time only; stored historical reports are read leniently (existing behavior) and pre-feature keys equal old slugged names, so old `target_agent` values remain resolvable. Contract tests updated in the same change (Principle VI). |
| V | Secret Isolation & Output Scrubbing | ✅ Pass | No secrets involved. |
| VI | Test-Mandatory Pipeline Logic | ✅ Pass | Routing resolution, setup-apply, seeding, and the backfill are pipeline logic → unit + integration tests planned in the same iteration (spec FR-021). |
| — | Technology Constraints (lazy resolution, schema sync) | ✅ Pass | No module-decorator resource init. `docs/architecture.md` §3 updated with migration `0007` + `REVIEW-0007` SQL review (repo rule 5). |

**Post-Phase-1 re-check**: no violations introduced by the design below. Complexity Tracking stays empty.

## Project Structure

### Documentation (this feature)

```text
specs/014-agent-identity/
├── spec.md              # Feature specification
├── plan.md              # This file
├── research.md          # Phase 0 — decisions D1..D8
├── data-model.md        # Phase 1 — agents table delta, key lifecycle
├── quickstart.md        # Phase 1 — end-to-end validation guide
├── contracts/
│   └── contracts-delta.md  # Phase 1 — slug function, report/admin/dashboard schema deltas
└── tasks.md             # Phase 2 (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
packages/contracts/src/
├── agent-key.ts                 # NEW: slugifyAgentKey + ensureUniqueAgentKey + RESERVED_AGENT_KEYS (dep-free)
├── report.schema.ts             # TeamAgentSchema + role; target_agent re-documented as key
├── admin-tools.schema.ts        # create_agent/create_team/generate_agents: + role, key in responses
├── dashboard.schema.ts          # AgentResponse + key/role; AgentWriteRequest + role (strict ⇒ key rejected)
├── agents-config.schema.ts      # config-file agents: + role, dedup by derived key
└── index.ts                     # export agent-key

libs/database/src/
├── schema/agents.ts             # + role, + key NOT NULL, UNIQUE(workspace_id,key), drop UNIQUE(workspace_id,name)
└── orchestrator-seed.ts         # role="teamlead", key=ORCHESTRATOR_AGENT_KEY; lookup by is_orchestrator, onConflict (workspace_id,key)

libs/pipeline/src/
├── pipeline.service.ts          # resolveRoutingTarget: match by key; human-task texts "name (role)"
├── handoff.ts                   # roster: key+name+role+description, "route by key"; setup prompt: themed persona instruction
└── setup-apply.service.ts       # validateTeam: intra-proposal persona dedup; insertTeamAgents: derive key + suffix

libs/app-config/src/
└── config-seeder.ts             # 4th creation path: lookup/insert by derived key, not name

libs/ingest/src/reconcile.service.ts   # log lines: key (technical context)
libs/jira/src/adf-composer.ts          # routed line already prints target_agent (= key) verbatim — verify only

apps/backend/src/dashboard/
├── agents.controller.ts         # create: slugifyAgentKey+suffix; update: never touches key; ORDER BY key; DTO + key/role
├── runs.controller.ts           # agent DTO + key/role (display)
└── human-tasks.controller.ts    # agent DTO + key/role (display)

apps/web/src/
├── views/AgentsList.vue         # show name + role, key as read-only technical id
└── components/AgentForm/        # name/role editable; key read-only display

packages/admin-mcp/src/tools.ts  # create_agent/create_team responses include key; generate_agents unchanged (prompt lives in handoff)

drizzle/
├── 0007_agent_identity.sql      # migration + deterministic backfill
└── REVIEW-0007_agent_identity.md  # SQL review vs architecture.md §3 (repo convention)

docs/architecture.md             # §3 agents table updated

Tests (same iteration):
packages/contracts/src/agent-key.spec.ts
libs/pipeline/src/{pipeline.service,setup-apply.service,handoff}.spec.ts (updated)
libs/database/src/orchestrator-seed.spec.ts (updated)
test/integration/  (agent-identity: creation paths, immutability, routing key→id, migration backfill)
```

**Structure Decision**: Existing monorepo layout; no new projects. The only new module is `packages/contracts/src/agent-key.ts` — dep-free (no zod import) following the `pagination.constants.ts` precedent, exported through the main barrel (web only displays keys, it never computes them, so no subpath alias is needed).

## Phase 0 → research.md (decisions D1–D8)

All spec-level unknowns were resolved; see [research.md](research.md). Highlights: orchestrator key `brigadir` reserved via `RESERVED_AGENT_KEYS` (D1); SQL backfill re-implements the slug deterministically in SQL with an integration test asserting parity with the TS function (D3); `key` in update payloads is rejected automatically by the existing `.strict()` request schemas (D5); intra-proposal duplicate persona names remain a 422 while collisions against existing rows are suffixed silently (D4); agents list ordering switches to `ORDER BY key` (unique ⇒ deterministic, repo pagination rule) (D7).

## Phase 1 → data-model.md, contracts/, quickstart.md

- [data-model.md](data-model.md) — `agents` table delta, key lifecycle/immutability, backfill algorithm, §3 sync notes.
- [contracts/contracts-delta.md](contracts/contracts-delta.md) — `slugifyAgentKey` signature + rules; `TeamAgentSchema`/`ReportRoutingSchema`, admin-tools, dashboard, agents-config schema deltas; handoff prose contract.
- [quickstart.md](quickstart.md) — runnable validation: migration on pre-feature data, create paths, immutability, routed key→id, themed generation, UI checks.

**Agent context update**: skipped — this speckit installation has no update-agent-context script (`.specify/scripts/bash/` contains only setup/check scripts), and repo guidance lives in CLAUDE.md, which needs no change for this feature.

## Complexity Tracking

No constitution violations — table intentionally empty.
