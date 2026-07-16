import { Body, Controller, Get, Inject, Put, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  DRIZZLE,
  type BrigadirDb,
  schema,
  getDefaultOrchestratorInstruction,
} from '@brigadir/database';
import {
  GeneralSettingsSchema,
  DEFAULT_ORCHESTRATOR_INSTRUCTION_KEY,
  type GeneralSettings,
} from '@brigadir/contracts';
import { DashboardTokenGuard } from './dashboard-token.guard';
import { validationError, zodIssuePath } from './dashboard.errors';

/**
 * Platform General-settings surface (feature 010, FR-021/022). Backed by the
 * `global_settings` key-value table. GET returns the built-in default when the
 * key is unset (so the UI field is never empty); PUT upserts the key. The value
 * is copied into a workspace's orchestrator at CREATION time — changing it
 * affects only workspaces created afterward (SC-006).
 */
@Controller('api/general-settings')
@UseGuards(DashboardTokenGuard)
export class GeneralSettingsController {
  constructor(@Inject(DRIZZLE) private readonly db: BrigadirDb) {}

  @Get()
  async get(): Promise<GeneralSettings> {
    return { default_orchestrator_instruction: await getDefaultOrchestratorInstruction(this.db) };
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

    await this.db
      .insert(schema.globalSettings)
      .values({
        key: DEFAULT_ORCHESTRATOR_INSTRUCTION_KEY,
        value: parsed.data.default_orchestrator_instruction,
      })
      .onConflictDoUpdate({
        target: schema.globalSettings.key,
        set: {
          value: parsed.data.default_orchestrator_instruction,
          updatedAt: sql`now()`,
        },
      });

    return { default_orchestrator_instruction: parsed.data.default_orchestrator_instruction };
  }
}
