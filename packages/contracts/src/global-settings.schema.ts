/**
 * Storage keys of the two brigadir instruction texts in the `global_settings`
 * KV. Introduced by the General tab (feature 010, FR-021/022); since feature
 * 015 the texts are surfaced by `GET/PUT /api/brigadir-agent-settings`
 * (orchestrator-template.schema.ts) — the KEYS deliberately never changed so
 * operator edits made under the old endpoint survive with zero migration:
 * - `default_orchestrator_instruction` — the routing (triage) instruction,
 *   copied into a workspace's seeded orchestrator at creation time (changing
 *   it affects only workspaces created afterward — feature 010 SC-006);
 * - `workspace_setup_instruction` — the agent-creation (workspace setup)
 *   protocol, read LIVE by the setup handoff on every generate-agents run.
 */

/** `global_settings.key` under which the default orchestrator (routing) instruction is stored. */
export const DEFAULT_ORCHESTRATOR_INSTRUCTION_KEY = 'default_orchestrator_instruction';

/** `global_settings.key` under which the agent-creation (workspace setup) instruction is stored. */
export const WORKSPACE_SETUP_INSTRUCTION_KEY = 'workspace_setup_instruction';
