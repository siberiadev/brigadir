import { Body, Controller, Get, Inject, Put, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  DRIZZLE,
  type BrigadirDb,
  schema,
  getDefaultOrchestratorInstruction,
  getWorkspaceSetupInstruction,
} from '@brigadir/database';
import {
  GeneralSettingsSchema,
  DEFAULT_ORCHESTRATOR_INSTRUCTION_KEY,
  WORKSPACE_SETUP_INSTRUCTION_KEY,
  type GeneralSettings,
} from '@brigadir/contracts';
import { DashboardTokenGuard } from './dashboard-token.guard';
import { validationError, zodIssuePath } from './dashboard.errors';

/**
 * Platform General-settings surface (feature 010, FR-021/022). Backed by the
 * `global_settings` key-value table. GET returns the built-in defaults when a
 * key is unset (so the UI fields are never empty); PUT upserts both keys.
 *
 * Two brigadir instruction texts (2026-07-16):
 * - `default_orchestrator_instruction` (routing/triage) — copied into a
 *   workspace's orchestrator at CREATION time; changing it affects only
 *   workspaces created afterward (SC-006).
 * - `workspace_setup_instruction` (agent creation) — read LIVE by the
 *   workspace-setup handoff; changing it affects the next generate-agents
 *   run in every workspace.
 */
@Controller('api/general-settings')
@UseGuards(DashboardTokenGuard)
export class GeneralSettingsController {
  constructor(@Inject(DRIZZLE) private readonly db: BrigadirDb) {}

  @Get()
  async get(): Promise<GeneralSettings> {
    return {
      default_orchestrator_instruction: await getDefaultOrchestratorInstruction(this.db),
      workspace_setup_instruction: await getWorkspaceSetupInstruction(this.db),
    };
  }

  @Put()
  async put(@Body() body: unknown): Promise<GeneralSettings> {
    const parsed = GeneralSettingsSchema.safeParse(body);
    if (!parsed.success) {
      throw validationError(
        'General settings could not be saved.',
        parsed.error.issues.map((i) => ({
          path: zodIssuePath(i.path),
          code: i.code,
          message: i.message,
          level: 'error' as const,
        })),
      );
    }

    const entries: Array<{ key: string; value: string }> = [
      {
        key: DEFAULT_ORCHESTRATOR_INSTRUCTION_KEY,
        value: parsed.data.default_orchestrator_instruction,
      },
      { key: WORKSPACE_SETUP_INSTRUCTION_KEY, value: parsed.data.workspace_setup_instruction },
    ];
    for (const { key, value } of entries) {
      await this.db
        .insert(schema.globalSettings)
        .values({ key, value })
        .onConflictDoUpdate({
          target: schema.globalSettings.key,
          set: { value, updatedAt: sql`now()` },
        });
    }

    return parsed.data;
  }
}
