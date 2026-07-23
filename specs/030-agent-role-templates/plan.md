# Implementation Plan: Agent role instruction templates from a git repository

**Branch**: `030-agent-role-templates` | **Date**: 2026-07-23 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/030-agent-role-templates/spec.md`

## Summary

Team generation (workspace-setup runs) today invents every worker instruction from scratch. This feature gives the setup agent a catalog of curated role templates (`roles/<slug>.md`, YAML frontmatter + prompt body) resolved per workspace as **workspace git override ?? global git setting ?? built-in defaults**. The backend clones/fetches the template repo server-side (reusing the worktree clone-cache pattern); the setup agent consumes templates lazily via two new callback MCP tools (`list_role_templates`, `get_role_template`) and adapts them to the project (reference mode). Private repos are supported via a sealed token (AES-256-GCM secret-box) that never reaches the agent. The setup instruction gains explicit guidance for template usage and for mapping approximate `model_hint`s to real executor profiles. Broken sources never block setup — deterministic fallback to built-ins with run diagnostics.

## Technical Context

**Language/Version**: TypeScript 5.x strict, Node 22 (existing monorepo toolchain)

**Primary Dependencies**: NestJS 11 (backend/worker), Drizzle ORM + Postgres 16, zod (contracts), BullMQ 5 (unchanged), Vue 3 + Element Plus (dashboard), @modelcontextprotocol/sdk (mcp-server, admin-mcp), system `git` via `execFile` (no new git library)

**Storage**: Postgres — `workspaces.settings` jsonb (non-secret source config), new `workspaces.agent_instructions_token` bytea (sealed token, migration 0009), `global_settings` KV (global source + sealed global token); built-in templates as TS constants in `packages/contracts`

**Testing**: vitest unit/component (root gates), vitest + testcontainers integration (real Postgres/Redis; a local bare git repo fixture for source tests)

**Target Platform**: Linux server (docker compose) + macOS dev

**Project Type**: pnpm monorepo — apps/backend, apps/worker, apps/web, packages/contracts, packages/mcp-server, packages/admin-mcp, libs/*

**Performance Goals**: Template fetch adds ≤ one `git fetch` per setup run (setup runs are rare, human-initiated, `maxParallelRuns: 1`); catalog block bounded like other handoff fields; no impact on worker-run hot path

**Constraints**: Token never in argv/agent env/logs/API responses (Constitution V); no eager resource init in `@Module()` args (lazy env reads); setup never blocks on template source (best-effort like repo recon); `agents.instruction` write path unchanged

**Scale/Scope**: Internal tool — few workspaces, template repos ≤ 50 files; caps: ≤ 50 template files, ≤ 32 KB body each, git ops ≤ 30 s

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| I. Dual Source of Truth | ✅ Pass | No new status authority. Template source config lives in Postgres (settings/global KV); the template repo is an input artifact, not a source of truth — every run re-resolves it and falls back deterministically. |
| II. Idempotency at Three Levels | ✅ Pass | No new run-triggering path. Feature only adds inputs to the existing workspace-setup run. |
| III. System-Only Jira Writes | ✅ Pass | No Jira writes added. Built-in template bodies EMBED this rule in every role prompt (workers report via callback tools only). |
| IV. Run Completion Contract | ✅ Pass | Completion flow untouched; team delivery still validated by the existing setup-apply path. New MCP tools are read-only lookups, not completion channels. |
| V. Secret Isolation & Output Scrubbing | ✅ Pass (design-critical) | Token sealed at rest via existing secret-box + `BRIGADIR_CREDENTIALS_KEY`; write-only tri-state API; git auth via `http.extraHeader` config injected per-invocation (never argv URL, never remote config, never agent env); responses expose only `has_agent_instructions_token`. Templates are fetched by the BACKEND — the agent never holds repo credentials. |
| VI. Test-Mandatory Pipeline Logic | ✅ Pass | Resolution chain, fallback, token seal/open, tool proxying, and handoff assembly all ship with unit + integration tests in the same change (detailed per-story in tasks). |
| Tech Constraints (lazy resolution) | ✅ Pass | Template service resolves env (cache root) and DB config lazily at call time; nothing evaluated in `@Module()` args. |
| Schema governance (CLAUDE.md rule 5) | ✅ Pass | Migration 0009 + `docs/architecture.md` §3 update + `REVIEW-0009` in the same change (FR-020). |

**Post-design re-check (Phase 1)**: all gates still pass — see contracts/ and data-model.md; no Complexity Tracking entries needed.

## Project Structure

### Documentation (this feature)

```text
specs/030-agent-role-templates/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   ├── role-templates.md      # template file format + catalog/tool contracts
│   └── settings-api.md        # source-config API contracts (global + workspace)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
packages/contracts/src/
├── role-template.schema.ts        # NEW: RoleTemplate/-Summary/-Source schemas + caps
├── default-role-templates.ts      # NEW: built-in roles (dep-free, like orchestrator-defaults)
├── callback-tools.schema.ts       # + ListRoleTemplates/GetRoleTemplate schemas, CallbackTools reg
├── global-settings.schema.ts      # + agent_instructions_repo / _repo_token keys
├── jira.types.ts                  # WorkspaceSettingsSchema + agent_instructions source block
├── dashboard.schema.ts            # workspace requests/response + token tri-state + has_token
├── admin-tools.schema.ts          # + set_agent_instructions_source; create_workspace passthrough
└── orchestrator-defaults.ts       # DEFAULT_WORKSPACE_SETUP_INSTRUCTION: templates + executor-hint sections

libs/database/src/
├── schema/workspaces.ts           # + agentInstructionsToken bytea column
├── workspace-settings.ts          # + getAgentInstructionsSource accessor
└── global-instruction-source.ts   # NEW: global source + sealed token read/write helpers

libs/agent-templates/src/          # NEW lib: resolution + git fetch + parsing
├── clone-cache.ts                 # extracted ensureCache/git() from executors worktree.ts
├── frontmatter.ts                 # minimal YAML frontmatter parser (no new dep)
├── template-source.resolver.ts    # workspace ?? global ?? built-in resolution
├── template-repo.service.ts       # fetch, list, get, caps, fallback, diagnostics
└── index.ts

libs/executors/src/claude-cli/
├── worktree.ts                    # ensureCache/git() delegated to shared clone-cache
└── args.ts                        # CALLBACK_TOOL_NAMES + 2 new mcp__brigadir__* tools

libs/callback/src/
└── callback.controller.ts         # + GET templates, GET templates/:slug (run-token auth)

libs/pipeline/src/
└── handoff.ts                     # buildWorkspaceSetupSection + bounded catalog block

packages/mcp-server/src/
└── tools.ts                       # + list_role_templates / get_role_template proxies

apps/backend/src/dashboard/
├── workspaces.controller.ts       # settings PUT: source + token tri-state; response has_token
└── brigadir-agent-settings.controller.ts  # or sibling: global source GET/PUT

apps/web/src/
├── views/ (Settings General + Workspace settings)  # source forms, token write-only, effective-source indicator
└── api/ + composables/            # settings client extensions

packages/admin-mcp/src/
├── tools.ts                       # create_workspace passthrough + set_agent_instructions_source
└── main.ts                        # optional BRIGADIR_AGENT_INSTRUCTIONS_TOKEN env

drizzle/
├── 0009_agent_instructions.sql    # + REVIEW-0009, meta snapshot
docs/architecture.md               # §3 workspaces table update

test/integration/                  # bare-git fixture + resolution/fallback/tool E2E suites
```

**Structure Decision**: One new small lib (`libs/agent-templates`) isolates git/parsing/resolution so `libs/pipeline` (handoff) and `libs/callback` (endpoints) depend on a typed service instead of raw git. The clone-cache extraction is the only cross-cutting refactor; `worktree.ts` keeps its public API byte-compatible.

## Complexity Tracking

> No constitution violations — table intentionally empty.
