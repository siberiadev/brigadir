import { z } from 'zod';

/**
 * Brigadir agent template (feature 015) — the global, editable template of the
 * default orchestrator agent, stored as ONE versioned JSON document in the
 * `global_settings` KV under BRIGADIR_AGENT_TEMPLATE_KEY (no dedicated table,
 * research D1). `seedOrchestratorAgent` copies it into every NEW workspace's
 * orchestrator (copy-at-creation, feature 010 SC-006 semantics); the `setup`
 * execution profile is read LIVE by every `workspace-setup` run (research D8).
 *
 * The two instruction texts are deliberately NOT embedded here — they keep
 * their own `global_settings` keys so stored operator edits survive the move
 * from the General section without a data migration (research D2). The
 * settings API composes them into BrigadirAgentSettings.
 */

/** `global_settings.key` under which the template document is stored. */
export const BRIGADIR_AGENT_TEMPLATE_KEY = 'brigadir_agent_template';

/**
 * Behavior carried by an execution profile. Passthrough like
 * AgentBehaviorRequestSchema: only `workspace_mode` is UI-editable (triage);
 * unknown keys round-trip unchanged through the settings form (analysis U1).
 */
const TemplateBehaviorSchema = z
  .object({
    workspace_mode: z.string().optional(),
  })
  .passthrough();

/**
 * Triage execution profile: how routing/triage runs execute. Copied into the
 * seeded agent row (executor resolved name→id at seed time).
 */
const TriageProfileSchema = z
  .object({
    /** Executor PROFILE NAME (globally unique, §3) — not an id. */
    executor: z.string().min(1),
    behavior: TemplateBehaviorSchema,
  })
  .strict();

/**
 * Setup execution profile: how `workspace-setup` runs execute. Read live at
 * every setup-run start — never copied anywhere.
 */
const SetupProfileSchema = z
  .object({
    /** Executor PROFILE NAME (globally unique, §3) — not an id. */
    executor: z.string().min(1),
    behavior: TemplateBehaviorSchema,
    /**
     * Setup-run timeout (spec FR-019): applied by the worker processor to
     * `workspace-setup` runs instead of the agent's `timeout_minutes`;
     * generous enough to accommodate repository clones.
     */
    timeout_minutes: z.number().int().positive(),
  })
  .strict();

export const BrigadirAgentTemplateSchema = z
  .object({
    schema_version: z.literal(1),
    /** Persona name of the seeded orchestrator (feature 014 semantics). */
    name: z.string().min(1).max(100),
    /** The orchestrator's function; carries no system meaning (the flag does). */
    role: z.string().min(1).max(100),
    // Numeric bounds mirror AgentWriteRequestSchema (dashboard.schema.ts).
    timeout_minutes: z.number().int().positive(),
    max_budget_usd: z.number().positive().nullable(),
    max_attempts: z.number().int().min(1),
    enabled: z.boolean(),
    triage: TriageProfileSchema,
    setup: SetupProfileSchema,
  })
  .strict();

export type BrigadirAgentTemplate = z.infer<typeof BrigadirAgentTemplateSchema>;

/**
 * GET/PUT payload of `/api/brigadir-agent-settings`: the template plus the two
 * relocated instruction texts (stored under their pre-existing keys —
 * DEFAULT_ORCHESTRATOR_INSTRUCTION_KEY / WORKSPACE_SETUP_INSTRUCTION_KEY).
 */
export const BrigadirAgentSettingsSchema = z
  .object({
    template: BrigadirAgentTemplateSchema,
    routing_instruction: z.string().min(1).max(20000),
    workspace_setup_instruction: z.string().min(1).max(20000),
  })
  .strict();

export type BrigadirAgentSettings = z.infer<typeof BrigadirAgentSettingsSchema>;
