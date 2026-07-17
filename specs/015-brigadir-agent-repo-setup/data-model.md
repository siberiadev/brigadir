# Data Model: Configurable Default Brigadir Agent + Repo-Mounted Setup Runs

**Feature**: 015-brigadir-agent-repo-setup | **Date**: 2026-07-17

No database schema changes. All new data lives in the existing `global_settings` KV (`key text PK, value jsonb, updated_at`) and in `packages/contracts` zod schemas. Architecture.md §3 unchanged (CLAUDE.md rule 5 satisfied by construction).

## 1. `BrigadirAgentTemplate` (new contracts schema, stored document)

Stored under `global_settings.key = 'brigadir_agent_template'` (new constant `BRIGADIR_AGENT_TEMPLATE_KEY`). Zod: `BrigadirAgentTemplateSchema` in `packages/contracts/src/orchestrator-template.schema.ts`, `.strict()` at every level.

| Field | Type / bounds | Default (built-in) | Lifecycle |
|---|---|---|---|
| `schema_version` | literal `1` | `1` | versioning hook |
| `name` | string 1..100 | `'brigadir'` | copy-at-creation |
| `role` | string 1..100 | `'teamlead'` | copy-at-creation |
| `timeout_minutes` | int > 0 | `45` | copy-at-creation (triage runs) |
| `max_budget_usd` | number > 0 \| null | `null` | copy-at-creation |
| `max_attempts` | int ≥ 1 | `2` | copy-at-creation |
| `enabled` | boolean | `true` | copy-at-creation |
| `triage.executor` | string ≥ 1 (executor profile **name**) | `'brigadir-orchestrator'` | copy-at-creation (resolved to `executor_id` at seed) |
| `triage.behavior` | object (AgentBehavior shape, passthrough) | `{ workspace_mode: 'none' }` | copy-at-creation. UI exposes only `workspace_mode` (none / default-repo select); all other keys round-trip unchanged through the settings form |
| `setup.executor` | string ≥ 1 (executor profile **name**) | `'brigadir-setup'` | **live-read** at every setup-run start |
| `setup.behavior` | object (passthrough) | `{}` (repo-mounted: no `workspace_mode:'none'`) | live-read |
| `setup.timeout_minutes` | int > 0 | `60` | live-read (applied by the worker processor to `workspace-setup` runs) |

**Not in the template** (spec FR-003): `trigger_status`, `trigger_jql`, `status_running`, `status_success`, `status_failure` (seed keeps `null`/inert `'—'` exactly as today), `description`, `key` (reserved `'brigadir'`, system-owned), model/maxTurns (live in the referenced executor profiles — §3 single-source rule).

**Instruction texts are NOT embedded** (research D2): they stay under their existing keys and are composed into the settings API payload.

**Validation on write (PUT)** — beyond shape: referenced `triage.executor` and `setup.executor` must name an existing, enabled executor profile (422 with field-level issue otherwise). Validation on read (seed/run): missing/disabled profile → built-in fallback + warning (spec FR-010/FR-018), never a failure.

**Corrupt stored value** (spec FR-011): `getBrigadirAgentTemplate(db)` safe-parses; on missing key or parse failure returns built-in defaults and logs a warning. (New reader — the existing `getInstructionSetting` string-coerces and is unsuitable for a JSON document.)

## 2. `BrigadirAgentSettings` (API payload, new)

The GET/PUT body of `/api/brigadir-agent-settings` — the template plus the two relocated instruction texts:

```
BrigadirAgentSettings = BrigadirAgentTemplate fields (flattened as `template`)
  + routing_instruction: string 1..20000   (storage: legacy key default_orchestrator_instruction)
  + workspace_setup_instruction: string 1..20000 (storage: legacy key workspace_setup_instruction)
```

GET composes from three KV keys (template + 2 legacy text keys), substituting built-in defaults for any unset key — the UI is never empty. PUT validates the whole payload, then upserts the three keys (template JSON, two strings) in one handler.

## 3. `GeneralSettings` (existing contract — REMOVED)

`GeneralSettingsSchema`, `GET/PUT /api/general-settings`, `generalSettingsApi`, `useGeneralSettings` are deleted (research D3): both fields move to the new endpoint and Theme is device-local (localStorage, never server-persisted). The two **storage keys stay** (D2) — only the API/contract surface moves. Integration test `global-settings.integration.spec.ts` is superseded by the new endpoint's suite (its legacy-key continuity case keeps the old keys covered).

## 4. Built-in `brigadir-setup` executor profile (seeded row, existing table)

New insert-if-absent row in `executors` (no schema change), sibling of `brigadir-orchestrator`:

| Column | Value |
|---|---|
| `name` | `'brigadir-setup'` (global unique) |
| `type` | `'claude_cli'` |
| `config` | `{ model: 'claude-sonnet-5', cliPath: 'claude', useCallbackChannel: true, maxTurns: 60 }` (no `workspaceMode: 'none'` → repo-mounted) |
| `max_parallel_runs` | `1` |
| `enabled` | `true` |

Created by `ensureSetupExecutor(db)` (mirror of `ensureOrchestratorExecutor`, same `onConflictDoNothing` + re-read race handling), invoked from seeding and from the setup-run fallback path.

## 5. Seeded orchestrator agent row (existing table, values now template-driven)

`seedOrchestratorAgent` output changes only in WHERE values come from:

| Column | Source (was → now) |
|---|---|
| `name`, `role` | constants → `template.name` / `template.role` |
| `executor_id` | `ensureOrchestratorExecutor` → resolve `template.triage.executor` by name (fallback: `ensureOrchestratorExecutor` + warning) |
| `instruction` | `getDefaultOrchestratorInstruction` (unchanged — legacy key) |
| `behavior` | `{ workspace_mode: 'none' }` → `template.triage.behavior` |
| `timeout_minutes`, `max_budget_usd`, `max_attempts`, `enabled` | column defaults → template values |
| `key`, `is_orchestrator`, `trigger_*`, `status_*` | unchanged (reserved key, inert placeholders) |

Insert-if-absent identity and race handling unchanged. Existing rows never touched (this feature's SC-002; feature 010's SC-006 copy-at-creation semantics).

## 6. Setup-run environment resolution (runtime state, no persistence change)

`runs.trigger_event.source === 'workspace-setup'` (existing jsonb, no new column) now additionally drives, at run start:

- **Executor config swap** in `ClaudeCliExecutor.loadRunConfig`: profile config = setup executor's `config` (model, maxTurns, cli settings) instead of the agent's profile.
- **Behavior swap**: `template.setup.behavior` instead of `agents.behavior` (→ `noRepo` false unless the workspace has no repositories).
- **Repo**: workspace default repository (first of `workspaces.settings.repositories`); none configured → scratch-dir path as today.
- **Worktree identity** (spec FR-020): branch `setup/<first 8 chars of run id>`, worktree dir keyed by run id as today; local-only branch, never pushed; cleanup path unchanged.
- **Timeout**: processor applies `template.setup.timeout_minutes` for `workspace-setup` runs.
- **Warning event** on fallback: `run_events` row (existing table) `{ type: 'log', payload: { message: 'setup executor <name> missing/disabled — fell back to brigadir-setup' } }`-shaped, visible in the run timeline.

State machine, dedup (`runs_one_active_setup`), completion contract: unchanged.

## 7. Relationships

```
global_settings['brigadir_agent_template'] ──(seed: copy-at-creation)──▶ agents (is_orchestrator=true, new workspaces only)
                                          └─(run start: live-read)────▶ workspace-setup run environment
global_settings['default_orchestrator_instruction'] ─(copy-at-creation)▶ agents.instruction
global_settings['workspace_setup_instruction'] ──────(live-read)──────▶ setup handoff (unchanged)
template.triage.executor ──(name→id at seed)──▶ executors
template.setup.executor ──(name→config at run start)──▶ executors
```
