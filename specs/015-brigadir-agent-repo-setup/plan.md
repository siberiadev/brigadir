# Implementation Plan: Configurable Default Brigadir Agent + Repo-Mounted Setup Runs

**Branch**: `claude/brigadir-agent-repo-setup-63b0c9` | **Date**: 2026-07-17 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/015-brigadir-agent-repo-setup/spec.md`

## Summary

Two composed blocks. (1) A new Settings → "Brigadir agent" section holds a global, editable **template** of the default orchestrator agent (identity, routing instruction, triage execution profile, limits, enabled) stored as one versioned JSON document in the existing `global_settings` KV; `seedOrchestratorAgent` reads it when seeding every NEW workspace (copy-at-creation, SC-006 semantics), and both brigadir instruction texts move out of Settings → General into this section (General keeps only Theme). (2) The template also carries a **setup execution profile** (executor profile + behavior) read LIVE by runs with trigger source `workspace-setup`: setup runs get a "fat" environment — the workspace default repository mounted (read-only in effect: no push credentials), a more capable model, a larger turn budget — while triage runs stay cheap and repo-less. The feature-010 principle "orchestrator has no repository / no git credentials" is explicitly narrowed to **triage runs** (see Constitution Check).

## Technical Context

**Language/Version**: TypeScript strict (Node 22, pnpm workspace monorepo)

**Primary Dependencies**: NestJS 11 (backend + worker), Drizzle ORM, BullMQ 5, zod (contracts), Vue 3 + Element Plus + TanStack Query (web)

**Storage**: Postgres 16 — existing `global_settings` KV table (`value jsonb`); **no schema/migration changes** (architecture.md §3 stays as-is)

**Testing**: vitest units per package; vitest + testcontainers integration (`test/integration`, shared containers per run); Vue Test Utils for web

**Target Platform**: self-hosted Linux/macOS (docker compose stack: postgres, redis, backend, worker)

**Project Type**: web application (Vue dashboard + NestJS API/worker monorepo)

**Performance Goals**: n/a beyond existing pipeline behavior; setup runs get a longer timeout to accommodate repository clones

**Constraints**: Constitution v1.2.0 — lazy resource resolution (no init in `@Module()` args), system-only Jira writes, secret isolation (no git push credentials in setup runs), test-mandatory pipeline logic; CLAUDE.md hard rules 1–7

**Scale/Scope**: internal team tool; single deployment; template is one JSON document, no pagination surface

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Verdict | Notes |
|---|---|---|
| I. Dual Source of Truth | ✅ PASS | Template lives in Postgres `global_settings`; no new sources of truth. Run state untouched. |
| II. Idempotency at Three Levels | ✅ PASS | No new trigger paths. Setup runs keep their existing dedup posture (`runs_one_active_setup` authority; BullMQ dedup skipped by design for `workspace-setup` — unchanged). Seeding stays insert-if-absent + `onConflictDoNothing` race-safe. |
| III. System-Only Jira Writes | ✅ PASS | No new Jira write paths; setup runs still report via callback tools only. |
| IV. Run Completion Contract | ✅ PASS | Completion semantics of setup/triage runs unchanged; only the execution environment resolution changes. |
| V. Secret Isolation & Output Scrubbing | ⚠️ PASS WITH NARROWING (deliberate, recorded) | See below — the feature-010 corollary "orchestrator has no repository and no git credentials" is narrowed to **triage runs**. Core Principle V itself is NOT violated: setup runs receive exactly the same posture as regular worker runs (git via the host ssh-agent `SSH_AUTH_SOCK` on the explicit env allowlist — the accepted phase-0/1 mechanism, architecture §8; run token in the MCP-server config outside the worktree; sanitized env; `--strict-mcp-config`), and read-only-in-effect is enforced behaviorally (no push path, no push instruction, local-only branch — research D11). |
| VI. Test-Mandatory Pipeline Logic | ✅ PASS | Template-based seeding, settings endpoint, and setup-environment resolution are pipeline-adjacent logic → units + integration tests ship in the same change (spec FR-021). |
| Technology Constraints (lazy resolution) | ✅ PASS | Template reads happen inside services/DI factories at request/run time — never in `@Module()` decorator args. No new queues, no composition-time env reads. |

### Narrowing of the feature-010 "no repository" principle (honest record, spec FR-016)

Feature 010 FR-018 states the orchestrator "MUST run on a dedicated low-cost executor profile without a repository workspace", motivated by Constitution V (git credentials out of the model's reach) and cost. That blanket rule is what keeps the setup protocol's recon branch dormant and produces weak generic teams (the problem this feature fixes).

**New boundary**: the "no repository, no git credentials" rule applies to **triage runs** (`triage`, `answer-triage` sources — short routing decisions over the system's own run history). **Setup runs** (`workspace-setup` source) are a different workload: a one-shot, human-initiated, ticketless recon task whose entire value depends on reading the repository. They get repository access under the same isolation regime as regular worker runs, further restricted:

- **No push, honestly stated**: recon is read-only in effect — the system never commits, pushes, or opens PRs from a setup run, the setup worktree branch is local-only, and the protocol instructs read-only recon (spec FR-015). Git access rides the same host ssh-agent (`SSH_AUTH_SOCK` env-allowlist entry) that worker runs use; SSH cannot distinguish fetch from push, so a setup run technically holds the same capability every worker run already holds — the enforcement is behavioral and uniform with the rest of the phase-0/1 trusted-team posture (research D11). No secret values enter the agent env or argv (Constitution V holds).
- **Same scrubbing**: setup-run reports pass the same secret scrubber as all reports (feature 011 FR-018).
- **Cost control moves from "no repo" to profile limits**: the fat environment is bounded by the setup profile's turn budget, run timeout, and budget cap — configured in the template, defaulted in contracts.

**Justification**: the alternative (keeping setup runs repo-less) permanently caps generated-team quality at "generic role text", which defeats feature 011's purpose. The narrowed rule preserves both original motivations where they matter: triage stays cheap and credential-free (it runs unattended, often in loops); setup runs are rare, human-initiated, and observable.

*Initial gate: PASS (one deliberate, justified narrowing — tracked here and in Complexity Tracking). Post-design re-check: PASS — the design keeps the narrowing exactly as scoped (fetch-only credentials via the existing helper, setup-profile resolution confined to `workspace-setup` runs, triage path byte-identical to today).*

## Project Structure

### Documentation (this feature)

```text
specs/015-brigadir-agent-repo-setup/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── brigadir-agent-settings.md
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
packages/contracts/src/
├── orchestrator-template.schema.ts   # NEW: BrigadirAgentTemplateSchema + BrigadirAgentSettingsSchema + BRIGADIR_AGENT_TEMPLATE_KEY
├── orchestrator-defaults.ts          # EXTENDED: DEFAULT_BRIGADIR_AGENT_TEMPLATE (dep-free, web-importable via existing alias)
├── global-settings.schema.ts         # REMOVED contract surface: GeneralSettingsSchema deleted; the two *_KEY constants stay (storage keys survive)
└── index.ts                          # barrel export updates

libs/database/src/
└── orchestrator-seed.ts              # CHANGED: getBrigadirAgentTemplate (non-coercing jsonb reader, D7/FR-011),
                                      #          ensureSetupExecutor (built-in brigadir-setup profile),
                                      #          template-driven seedOrchestratorAgent + fallback warning
                                      # callers untouched in call shape: workspaces.controller.ts:131 (warning surfaced),
                                      #          config-seeder.ts:168, orchestrator-backfill.service.ts:28 (warn logs)

libs/executors/src/claude-cli/
├── claude-cli.executor.ts            # CHANGED: loadRunConfig selects runs.trigger_event; workspace-setup →
│                                     #          setup-profile config/behavior swap + fallback; ticketless-repo guard narrowed
└── worktree.ts                       # CHANGED: prepare() accepts ticketless identity → branch `setup/<runId8>`

apps/worker/src/
└── claude-cli-run.processor.ts       # CHANGED: setup-run timeout from template.setup.timeout_minutes (existing override seam)

libs/pipeline/src/
└── handoff.ts                        # UNCHANGED (live-read of workspace_setup_instruction keeps working — keys not renamed)

apps/backend/src/dashboard/
├── general-settings.controller.ts    # DELETED (endpoint removed, D3)
├── brigadir-agent-settings.controller.ts  # NEW: GET/PUT /api/brigadir-agent-settings (3-key compose/upsert, executor validation)
└── workspaces.controller.ts          # CHANGED: create response gains warnings[] on seed fallback

apps/web/src/
├── views/settings/PlatformSettings.vue     # CHANGED: third navItems entry
├── views/settings/SettingsGeneral.vue      # CHANGED: theme only
├── views/settings/SettingsBrigadirAgent.vue # NEW: template form + per-field/whole-template resets
├── router/index.ts                          # CHANGED: child route (+ fix stale redirect comment)
├── api/brigadirAgentSettings.ts             # NEW (generalSettings.ts deleted)
└── composables/useBrigadirAgentSettings.ts  # NEW (useGeneralSettings.ts deleted)

test/integration/
├── brigadir-agent-settings.integration.spec.ts  # NEW (supersedes global-settings.integration.spec.ts)
├── orchestrator-lifecycle.integration.spec.ts   # EXTENDED: template-driven seeding, fallback warning, SC-002
└── workspace-setup.integration.spec.ts          # EXTENDED: fat-environment resolution, degraded modes, cleanup
```

**Structure Decision**: existing monorepo layout; the feature touches the four established layers (contracts → database lib → executors/pipeline libs → backend controllers → web views) with no new packages and no DB migrations.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Narrowing of feature-010 FR-018 ("orchestrator has no repository/git credentials") to triage runs | Setup runs must read the actual repository or generated teams stay generic — the recon branch of the setup protocol is dormant without repo access | (a) Keep setup repo-less: permanently defeats feature 011's quality goal. (b) Give the orchestrator agent repo access globally: needlessly grants triage runs credentials they never use and raises their cost — the narrow grant (setup runs only, fetch-only) is strictly smaller. |
| Template carries TWO execution profiles (triage + setup) instead of one | Setup and triage have provably different resource needs (model, turns, repo) and different lifecycles (copy-at-creation vs live-read) | A single profile + hard-coded trigger-source override in the executor (option (b) of the feature description) hides the environment decision in code, makes it non-configurable, and still needs a second set of defaults — same complexity, less visibility. |
