import { z } from 'zod';

/**
 * General (platform-global) settings — feature 010, FR-021/022.
 * Backed by the `global_settings` key-value table; surfaced through the
 * `GET/PUT /api/general-settings` endpoints and the "General" settings tab.
 *
 * First and only key so far: `default_orchestrator_instruction`, copied into a
 * workspace's seeded orchestrator at creation time (changing it affects only
 * workspaces created afterward — SC-006).
 */
export const GeneralSettingsSchema = z
  .object({
    default_orchestrator_instruction: z.string().max(20000),
  })
  .strict();

export type GeneralSettings = z.infer<typeof GeneralSettingsSchema>;

/** `global_settings.key` under which the default orchestrator instruction is stored. */
export const DEFAULT_ORCHESTRATOR_INSTRUCTION_KEY = 'default_orchestrator_instruction';
