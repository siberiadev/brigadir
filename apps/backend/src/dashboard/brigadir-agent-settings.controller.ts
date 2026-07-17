import { Body, Controller, Get, Inject, Put, UseGuards } from '@nestjs/common';
import { inArray, sql } from 'drizzle-orm';
import {
  DRIZZLE,
  type BrigadirDb,
  schema,
  getBrigadirAgentTemplate,
  getDefaultOrchestratorInstruction,
  getWorkspaceSetupInstruction,
  ensureOrchestratorExecutor,
  ensureSetupExecutor,
  ORCHESTRATOR_EXECUTOR_NAME,
  SETUP_EXECUTOR_NAME,
} from '@brigadir/database';
import {
  BrigadirAgentSettingsSchema,
  BRIGADIR_AGENT_TEMPLATE_KEY,
  DEFAULT_ORCHESTRATOR_INSTRUCTION_KEY,
  WORKSPACE_SETUP_INSTRUCTION_KEY,
  type BrigadirAgentSettings,
} from '@brigadir/contracts';
import { DashboardTokenGuard } from './dashboard-token.guard';
import { validationError, zodIssuePath } from './dashboard.errors';

/**
 * Brigadir agent settings (feature 015) — the global template of the default
 * orchestrator plus the two instruction texts relocated from the General
 * section (iteration 20). Storage stays three `global_settings` keys:
 *
 * - `brigadir_agent_template` — ONE versioned JSON document (research D1);
 *   copy-at-creation for identity/triage/limits, live-read for the `setup`
 *   execution profile.
 * - `default_orchestrator_instruction` / `workspace_setup_instruction` — the
 *   PRE-EXISTING keys (research D2): operator edits made under the old General
 *   endpoint stay visible here with zero migration; the seed and the setup
 *   handoff keep reading them untouched.
 *
 * GET substitutes built-in defaults per unset key (fields never empty). PUT
 * additionally validates that both referenced executor PROFILE NAMES exist and
 * are enabled — a dangling reference at save time is a 422, while the same
 * condition later (profile deleted afterwards) degrades to the built-in
 * fallback + warning at seed/run time (FR-010/FR-018).
 */
@Controller('api/brigadir-agent-settings')
@UseGuards(DashboardTokenGuard)
export class BrigadirAgentSettingsController {
  constructor(@Inject(DRIZZLE) private readonly db: BrigadirDb) {}

  @Get()
  async get(): Promise<BrigadirAgentSettings> {
    return {
      template: await getBrigadirAgentTemplate(this.db),
      routing_instruction: await getDefaultOrchestratorInstruction(this.db),
      workspace_setup_instruction: await getWorkspaceSetupInstruction(this.db),
    };
  }

  @Put()
  async put(@Body() body: unknown): Promise<BrigadirAgentSettings> {
    const parsed = BrigadirAgentSettingsSchema.safeParse(body);
    if (!parsed.success) {
      throw validationError(
        'Brigadir agent settings could not be saved.',
        parsed.error.issues.map((i) => ({
          path: zodIssuePath(i.path),
          code: i.code,
          message: i.message,
          level: 'error' as const,
        })),
      );
    }
    const settings = parsed.data;

    await this.assertExecutorsUsable(settings.template);

    const entries: Array<{ key: string; value: unknown }> = [
      { key: BRIGADIR_AGENT_TEMPLATE_KEY, value: settings.template },
      { key: DEFAULT_ORCHESTRATOR_INSTRUCTION_KEY, value: settings.routing_instruction },
      { key: WORKSPACE_SETUP_INSTRUCTION_KEY, value: settings.workspace_setup_instruction },
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

    return settings;
  }

  /** Both execution profiles must reference an EXISTING, ENABLED executor (422 otherwise). */
  private async assertExecutorsUsable(template: BrigadirAgentSettings['template']): Promise<void> {
    const refs = [
      { path: ['template', 'triage', 'executor'], name: template.triage.executor },
      { path: ['template', 'setup', 'executor'], name: template.setup.executor },
    ];
    // Built-in profiles are insert-if-absent platform rows normally created at
    // workspace seeding — materialize them here so saving the DEFAULT template
    // on a fresh database (no workspaces yet) does not 422.
    if (refs.some((r) => r.name === ORCHESTRATOR_EXECUTOR_NAME)) {
      await ensureOrchestratorExecutor(this.db);
    }
    if (refs.some((r) => r.name === SETUP_EXECUTOR_NAME)) {
      await ensureSetupExecutor(this.db);
    }
    const rows = await this.db
      .select({ name: schema.executors.name, enabled: schema.executors.enabled })
      .from(schema.executors)
      .where(
        inArray(
          schema.executors.name,
          refs.map((r) => r.name),
        ),
      );
    const byName = new Map(rows.map((r) => [r.name, r]));

    const issues = refs.flatMap((ref) => {
      const row = byName.get(ref.name);
      if (row?.enabled) return [];
      return [
        {
          path: ref.path,
          code: 'executor_unusable',
          message: `Executor profile "${ref.name}" ${row ? 'is disabled' : 'does not exist'}.`,
          level: 'error' as const,
        },
      ];
    });
    if (issues.length) {
      throw validationError('Brigadir agent settings could not be saved.', issues);
    }
  }
}
