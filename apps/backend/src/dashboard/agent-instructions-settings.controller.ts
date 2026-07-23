import { Body, Controller, Get, Inject, Put, UseGuards } from '@nestjs/common';
import {
  DRIZZLE,
  type BrigadirDb,
  getGlobalInstructionSource,
  setGlobalInstructionSource,
  setGlobalInstructionToken,
} from '@brigadir/database';
import { sealSecret } from '@brigadir/jira';
import {
  AgentInstructionsGlobalUpdateSchema,
  type AgentInstructionsGlobalSettings,
} from '@brigadir/contracts';
import { DashboardTokenGuard } from './dashboard-token.guard';
import { validationError, zodIssuePath } from './dashboard.errors';

/**
 * Global (platform) agent role-template source (feature 030). GET returns the
 * non-secret source + `has_token` (never the token). PUT is tri-state on both:
 * `source` absent keeps / `null` clears; `token` absent keeps / null-or-empty
 * clears / a value seals & replaces (Principle V — write-only, AES-256-GCM).
 */
@Controller('api/agent-instructions-settings')
@UseGuards(DashboardTokenGuard)
export class AgentInstructionsSettingsController {
  constructor(@Inject(DRIZZLE) private readonly db: BrigadirDb) {}

  @Get()
  async get(): Promise<AgentInstructionsGlobalSettings> {
    const { source, tokenBlob } = await getGlobalInstructionSource(this.db);
    return { source, has_token: tokenBlob !== null };
  }

  @Put()
  async put(@Body() body: unknown): Promise<AgentInstructionsGlobalSettings> {
    const parsed = AgentInstructionsGlobalUpdateSchema.safeParse(body);
    if (!parsed.success) {
      throw validationError(
        'Request could not be validated.',
        parsed.error.issues.map((i) => ({
          path: zodIssuePath(i.path),
          code: i.code,
          message: i.message,
          level: 'error' as const,
        })),
      );
    }
    const { source, token } = parsed.data;

    if (source !== undefined) await setGlobalInstructionSource(this.db, source);
    if (token !== undefined) {
      // null or "" clears; a value seals & replaces.
      await setGlobalInstructionToken(this.db, token ? sealSecret(token) : null);
    }

    return this.get();
  }
}
