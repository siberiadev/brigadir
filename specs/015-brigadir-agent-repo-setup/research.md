# Research: Configurable Default Brigadir Agent + Repo-Mounted Setup Runs

**Feature**: 015-brigadir-agent-repo-setup | **Date**: 2026-07-17

All Technical Context items were resolvable from the codebase; no external research needed. Each decision below records: Decision / Rationale / Alternatives considered.

## D1 — Template storage: one versioned JSON document in `global_settings`

**Decision**: Store the whole template under a single new key `brigadir_agent_template` in the existing `global_settings` KV (`value jsonb`). Schema `BrigadirAgentTemplateSchema` (zod) lives in `packages/contracts/src/orchestrator-template.schema.ts` with a `schema_version: 1` literal field. No DB migration; architecture.md §3 unchanged (the table already exists and its comment already describes it as the platform KV).

**Rationale**: The KV table was introduced (feature 010) exactly for platform-global settings; `value` is `jsonb`, so a structured document is idiomatic. One key = one atomic upsert = no partial-save states. A version field lets later features migrate the shape without guessing.

**Alternatives considered**: (a) One KV key per field — rejected: multi-key PUT is non-atomic, validation becomes cross-key, and reads scatter. (b) A dedicated table — rejected: requires a migration and §3 update for a single-row config document; overkill. (c) Reuse a special `agents` row as template — rejected: agents are workspace-scoped (FK), a template has no workspace; NULL-workspace special-casing would leak everywhere.

## D2 — Legacy-key continuity for the two instruction texts (no data migration)

**Decision**: The two existing keys keep their storage roles: `default_orchestrator_instruction` and `workspace_setup_instruction` stay where they are. The template document does NOT embed the instruction texts; the new GET endpoint composes the response from the template document + the two legacy keys, and PUT writes each to its own key (template JSON + two text keys) in one request handler. Readers (`getDefaultOrchestratorInstruction`, `getWorkspaceSetupInstruction`, handoff live-read) keep working untouched.

**Rationale**: Spec FR-005 requires zero visible data loss. Keeping the keys means no migration code, no first-read migration edge cases, and the live-read path in `handoff.ts` (`getWorkspaceSetupInstruction`) is untouched — the lowest-risk way to preserve iteration-20 behavior. The seeding path already reads the routing key; it now additionally reads the template document for the other fields.

**Alternatives considered**: (a) Fold both texts into the template JSON and migrate on first read — rejected: dual-source ambiguity during transition, and the setup instruction's live-read consumer would need rework for no user-visible gain. (b) Fold in with an explicit SQL migration — rejected: CLAUDE.md rule 5 pressure (migrations reviewed against §3) for zero functional benefit.

## D3 — API surface: new endpoint, General shrinks to theme-only (no server fields left)

**Decision**: New controller `GET/PUT /api/brigadir-agent-settings` (dashboard-token guarded) serving `BrigadirAgentSettings` = template fields + the two instruction texts. The existing `GET/PUT /api/general-settings` endpoint and `GeneralSettingsSchema` are **removed** along with their web client/composable — Theme is device-local (`useTheme` → localStorage, never server-persisted), so after the move General has no server-backed fields at all. Web tests for general-settings move/adapt to the new endpoint.

**Rationale**: The general-settings endpoint exists solely for the two instruction texts (verified: controller handles exactly those two keys; Theme lives in `useTheme`/localStorage and never round-trips). Keeping an empty endpoint would be dead contract surface. The spec's contract-migration note (FR-005) is satisfied by updating all consumers and tests in the same change; internal tool, atomic deploy.

**Alternatives considered**: (a) Keep `/api/general-settings` and extend it with the template — rejected: the section is named "Brigadir agent" and General keeps only Theme; a misnamed endpoint outlives the UI it mirrors. (b) Keep the old endpoint as deprecated alias — rejected: no external consumers exist (internal tool), aliasing adds test surface for nothing.

## D4 — Template shape (fields and what is hidden)

**Decision** (`BrigadirAgentTemplate`, zod, `.strict()`):

```
schema_version: 1
name: string min 1 max 100            (default 'brigadir')
role: string min 1 max 100            (default 'teamlead')
instruction: string max 20000          — NOT stored here (see D2); exposed in the
                                        settings payload as routing_instruction
timeout_minutes: int > 0               (default 45)
max_budget_usd: number > 0 | null      (default null)
max_attempts: int >= 1                 (default 2)
enabled: boolean                       (default true)
triage: { executor: string min 1,      (default 'brigadir-orchestrator')
          behavior: AgentBehaviorRequestSchema-shaped object
                                        (default { workspace_mode: 'none' }) }
setup:  { executor: string min 1,      (default 'brigadir-setup')
          behavior: object             (default {}) — repo-mounted: workspace
                                        default repo, no workspace_mode:'none' }
```

Executor references are **by profile name** (globally unique per §3), not id — names survive re-seeding and are meaningful in a global document. Numeric bounds mirror `AgentWriteRequestSchema` (`timeout_minutes` positive int, `max_budget_usd` positive nullable, `max_attempts` min 1). Hidden/not-in-template per spec FR-003: `trigger_status`, `trigger_jql`, `status_running/success/failure` (seed keeps inert `—` placeholders), `description`, `key` (system-derived, reserved 'brigadir').

**Rationale**: Mirrors the regular agent form minus fields that are meaningless for the orchestrator; the two execution profiles implement spec FR-012 (option (a)).

**Alternatives considered**: embedding full executor config (model, maxTurns) inline in the template instead of referencing profiles — rejected: executors are the platform's single home for model/limits (§3, decision 2026-07-14 "agent owns no model"); duplicating config in the template would create a second source of truth.

## D5 — Reset-to-default UX

**Decision**: Per-field Reset buttons for the two instruction texts (existing iteration-20 pattern: local ref := built-in constant, disabled when already default, takes effect on Save) + one "Reset all to defaults" button for the whole template (confirmation via `ElMessageBox.confirm`, then all local refs := built-in defaults; takes effect on Save). Built-in defaults come from `@brigadir/contracts/orchestrator-defaults` (dep-free module, runtime-importable by web — extended with the template defaults object).

**Rationale**: Spec FR-006 decided both granularities; the per-field pattern already exists in `SettingsGeneral.vue` (`routingIsDefault`/`resetRouting`). Everything stays unsaved-until-Save, matching current behavior. Note: the `@brigadir/contracts/orchestrator-defaults` subpath is aliased for web via `apps/web/tsconfig.json` + `vite.config.ts` (not package.json exports) — the new template-defaults object rides the same dep-free module, no new alias needed.

**Alternatives considered**: server-side reset endpoint — rejected: client already has the defaults (dep-free import), a round-trip adds contract surface with no benefit.

## D6 — Settings navigation

**Decision**: Third entry in `PlatformSettings.vue` `navItems` (`{ key: 'brigadir-agent', label: 'Brigadir agent', to: '/settings/brigadir-agent' }`) + child route `platform-settings-brigadir-agent` lazy-loading new `SettingsBrigadirAgent.vue`. `SettingsGeneral.vue` keeps only the Theme radio group. New view follows the SettingsGeneral layout conventions (no `el-form`; `.field-label`/`.hint`/`.instruction-header` patterns) with `el-input-number` bounds mirroring AgentForm (`:min` guards; server-authoritative zod).

**Rationale**: Navigation is data-driven (verified `navItems` array + nested `RouterView`); one array entry + one route is the whole wiring. Also fixes in passing the stale router comment ("Bare /settings lands on Executors" vs actual redirect to general).

**Alternatives considered**: reusing `AgentForm.vue` for the template — rejected: AgentForm is workspace-bound (board statuses, workspace executor context, linter on live agents); the template has no workspace. The orchestrator-mode branches of AgentForm serve as the field-list precedent only.

## D7 — Template-driven seeding + executor fallback at workspace creation

**Decision**: `seedOrchestratorAgent` (and its callers — the wizard at `workspaces.controller.ts:131`, config seeding at `config-seeder.ts:168`, the startup backfill at `orchestrator-backfill.service.ts:28`) read the template document via a new helper `getBrigadirAgentTemplate(db)` in `libs/database` (zod-validated, falling back to built-in defaults on missing/corrupt value — spec FR-011; NOTE: the existing `getInstructionSetting` reader string-coerces `value` and cannot be reused for a JSON document) and seed the agent row from it: name, role, instruction (legacy key, D2), triage executor resolved by name, triage behavior, limits, enabled. If the triage executor name resolves to a missing or disabled profile, fall back to `ensureOrchestratorExecutor` (built-in `brigadir-orchestrator`, insert-if-absent) and return a warning marker; the workspace-creation path surfaces it via the established `warnings[]`-in-response convention (toasted by the web `onSaved`/`onCreated` pattern). Insert-if-absent semantics and `onConflictDoNothing` race handling stay byte-identical.

**Rationale**: Spec FR-009/FR-010; the seed already has the fallback profile machinery (`ensureOrchestratorExecutor`); the `warnings[]` response convention already exists in agent-save responses.

**Alternatives considered**: failing workspace creation on a dangling executor reference — rejected by spec FR-010 (creation must succeed); validating at save-time only — insufficient: the profile can be deleted after the template was saved.

## D8 — Setup-run environment resolution (fat setup, thin triage)

**Decision**: In `ClaudeCliExecutor.loadRunConfig`, additionally select `runs.trigger_event` in the existing `runs ⋈ agents ⋈ executors` joined query (`claude-cli.executor.ts:455-467`) and branch on `trigger_event.source === 'workspace-setup'`. For such runs, resolve the execution environment from the template's `setup` profile read live: executor profile looked up by name (model, maxTurns, cli config from that profile's `executors.config` replace the agent's profile config), behavior from `template.setup.behavior` (notably: no `workspace_mode:'none'` → repo-mounted), repo = workspace default repository. Missing/disabled setup executor → `ensureSetupExecutor` (built-in `brigadir-setup`, insert-if-absent) + a warning `run_event` on the run (spec FR-018). Workspace without a default repo → proceed with the no-repo scratch path exactly as today (spec FR-017). Triage and all other sources: resolution untouched (agent's own executor/behavior) — the triage path stays byte-identical.

**Fact base (verified)**: the trigger source has NO dedicated column — it lives in `runs.trigger_event` jsonb (`schema/runs.ts:37`); today only the worker **processor** reads it (handoff assembly, resume detection, timeout override) and the executor derives repo-less-ness purely from `agents.behavior.workspace_mode === 'none'` (`claude-cli.executor.ts:481`). `RunContext.limits.maxTurns` is an existing but never-populated override seam (processor `buildContext` doesn't set it; `buildArgs` prefers it at `claude-cli.executor.ts:258`) — we do not need it, since the whole profile config is swapped inside `loadRunConfig`.

**Rationale**: Spec FR-012/FR-013 (option (a)); the executor already queries the run row, so selecting one more column adds no new state or query, and the environment decision stays inside the one function that owns environment resolution. Live-read matches the setup instruction's lifecycle (edits affect the next run everywhere).

**Alternatives considered**: (b) hard-coded trigger-source override of model/maxTurns in the executor — rejected (spec decision): non-configurable, still needs defaults, hides the environment decision in code. (c) A second hidden per-workspace "setup agent" row — rejected: pollutes the roster, needs delete-guards, duplicates identity.

## D9 — Built-in setup executor profile (fallback target + default)

**Decision**: New seeded profile `brigadir-setup` (insert-if-absent by global name, sibling of `brigadir-orchestrator`), `type: 'claude_cli'`, config: `model: 'claude-sonnet-5'`, `maxTurns: 60`, `useCallbackChannel: true`, no `workspaceMode: 'none'` (repo-mounted), `maxParallelRuns: 1`. Template default `setup.executor = 'brigadir-setup'`. Default setup-run timeout: the template's `timeout_minutes` applies to triage (it is copied into the seeded agent row); setup runs get a dedicated `setup.timeout_minutes` (default 60 — generous enough for clones, spec FR-019), applied by the worker processor, which already owns run-timeout computation and already has a trigger-event-driven timeout-override seam (`claude-cli-run.processor.ts:148`); for `workspace-setup` runs it reads the template's setup timeout instead of the agent's `timeout_minutes`.

**Rationale**: Strong-but-standard model tier (Sonnet 5 is the workhorse tier per plan-internal cost notes), 4× triage turn budget for recon+generation, low parallelism (setup runs are rare and human-initiated). Numbers live in `orchestrator-defaults.ts` next to the instruction defaults so web Reset and seed share one source.

**Alternatives considered**: Opus-tier default — rejected: cost default should be conservative; operators can point the setup profile at any executor. Reusing `brigadir-orchestrator` with per-run overrides — rejected: would mutate the shared triage profile's meaning and its type-capacity math.

## D10 — Ticketless repo-mounted worktree (setup runs)

**Decision**: Extend the worktree `prepare()` path to accept a ticketless identity: for setup runs the branch/worktree name derives from the run id (`setup/<run-id-prefix>` instead of `<branch_prefix>/<ticket-key>`). The existing guard "ticketless run requires a no-repository agent" is narrowed: it rejects ticketless repo runs **except** `workspace-setup` source. The local branch is never pushed (no push happens in a setup run — FR-015); cleanup of worktree + `.repos/<name>` clones inside it rides the existing run-cleanup path unchanged (FR-014).

**Rationale**: Spec FR-020. Branch naming from run id is deterministic, collision-free, and needs no ticket. (Backed by executor code reading at `claude-cli.executor.ts:136-145` — the rejection exists only because branch naming assumed a ticket key.)

**Alternatives considered**: cloning to a detached checkout without a branch — rejected: diverges from the shared `prepare()` machinery (cache, cleanup) for no gain.

## D11 — Read-only recon: credential posture for setup runs

**Fact base (verified, corrects an earlier assumption)**: git access for repo-carrying runs is the **host user's ssh-agent** — `SSH_AUTH_SOCK` is on the explicit env allowlist (`libs/executors/src/claude-cli/env-allowlist.ts`, comment: https has no credential source in a headless spawn). There is no credential helper, no per-run token, and SSH cannot distinguish fetch from push: any run that can clone a private repo can technically push. Worker runs push by design; this is the accepted phase-0/1 trusted-team posture (architecture §8 ladder).

**Decision**: Setup runs reuse the same `SSH_AUTH_SOCK` channel — it is required for cloning private repos, which is the whole point of recon. "Read-only in effect" (spec FR-015) is enforced by three mechanisms, honestly acknowledged as behavioral rather than cryptographic: (1) **no system push path** — no code commits, pushes, or opens PRs for a setup run, and the setup worktree branch is local-only; (2) the setup **protocol instructs read-only recon** (existing text); (3) the setup run's report passes the same scrubber/validation as all reports, and its only actionable output is the team proposal (agents are created by the system from the validated report, never by the run writing anywhere). This grants setup runs no capability that worker runs don't already hold — the narrowing (plan Constitution Check) is strictly smaller than the existing worker-run posture.

**Rationale**: Fetch-only credentials are impossible with the current ssh-agent mechanism without new infrastructure (per-provider deploy keys or a broker), which architecture §8 schedules for later phases. Within the current trust model, "no push path + no push instruction + local-only branch" is exactly the same level of enforcement that keeps worker runs from, say, force-pushing main — behavioral, but uniform.

**Alternatives considered**: (a) separate read-only deploy keys per provider — deferred to the §8 phase-2+ hardening ladder: real work, no threat-model gain while worker runs hold the same agent socket. (b) Dropping `SSH_AUTH_SOCK` for setup runs — rejected: breaks private-repo recon, the feature's core value. (c) HTTPS with read-only tokens — rejected: contradicts the existing SSH-only posture and adds a second credential channel to scrub.

## D12 — Warning surfacing

**Decision**: Two warning channels per the two failure points: (a) workspace-creation fallback (D7) → `warnings[]` in the creation response, toasted via the existing `ElMessage.warning` convention in the create flow; (b) setup-run fallback (D8) → a `run_events` row (`type: 'error'`-adjacent informational event, payload naming the missing profile and the fallback) visible in the run card timeline, plus a worker log line.

**Rationale**: Matches spec SC-007 ("warning visible to the operator") using the two existing surfaces; no new UI.

**Alternatives considered**: persistent `el-alert` banners — rejected: warnings are one-shot facts about a single creation/run, the timeline/toast surfaces fit better than persistent state that would need dismissal logic.

## D13 — Test strategy (Constitution VI, spec FR-021)

**Decision**:
- **Contracts (unit)**: `BrigadirAgentTemplateSchema` validation cases (bounds, strictness, version literal, corrupt-input rejection).
- **Database lib (unit/integration)**: `getBrigadirAgentTemplate` fallback on missing/corrupt value; `seedOrchestratorAgent` from an edited template; executor-name fallback + warning; existing-workspace untouched (SC-002); race-safety unchanged.
- **Backend (integration, testcontainers)**: GET returns defaults when unset; PUT validates (bounds, unknown executor name → 422 field error); PUT→GET round-trip; legacy-key continuity (pre-seeded old keys visible in new GET); general-settings endpoint removal (404) and theme-only General.
- **Executor (integration)**: `workspace-setup` run resolves setup profile (model/maxTurns/repo-mounted assertions via mock/CLI-stub); triage run unchanged (repo-less, cheap profile); no-default-repo workspace degrades to scratch; missing setup executor falls back + emits run event; ticketless worktree branch naming + cleanup.
- **Web (vitest + MSW)**: settings sub-nav shows third item; SettingsBrigadirAgent loads/saves; per-field reset + reset-all; SettingsGeneral shows only Theme; existing settings-page spec updated for moved fields.

**Rationale**: Mirrors the suites that already exist (`apps/web/test/settings-page.spec.ts`, orchestrator-seed integration tests) and CLAUDE.md rules 4/6 (testcontainers, namespaced BullMQ prefix).

## D14 — Non-goals (bounded scope)

- No backfill/update of existing workspaces' orchestrators (SC-006 semantics; operators edit in place).
- No change to the setup protocol text (its recon branch already covers both repo/no-repo modes).
- No per-workspace template overrides (global only; per-workspace tuning = edit the seeded agent).
- No read-only credential minting (D11 deferral).
- No changes to `anthropic_api`/`deepseek_api`/`claude_routines` executors — setup-profile resolution lands in the `claude_cli` executor the orchestrator rides today; the resolver helper is written to be executor-agnostic for later reuse.
