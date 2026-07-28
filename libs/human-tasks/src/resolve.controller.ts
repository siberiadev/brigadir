import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { ResolveHumanTaskSchema } from '@brigadir/contracts';
import { DashboardTokenGuard } from '@brigadir/app-config';
import { ResumeService } from './resume.service';

/**
 * `POST /api/human-tasks/:id/resolve` (quickstart.md). Feature 006 (FR-032/033):
 * now behind the shared dashboard bearer guard — behavior unchanged, guard only.
 */
@Controller('api/human-tasks')
@UseGuards(DashboardTokenGuard)
export class ResolveController {
  constructor(private readonly resume: ResumeService) {}

  @Post(':id/resolve')
  @HttpCode(200)
  async resolve(@Param('id') id: string, @Body() body: unknown): Promise<unknown> {
    const parsed = ResolveHumanTaskSchema.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({ ok: false, errors: parsed.error.issues });
    }

    const result = await this.resume.resolve(id, parsed.data);
    switch (result.outcome) {
      case 'not_found':
        throw new NotFoundException({ ok: false, error: 'human task not found' });
      case 'not_open':
        throw new ConflictException({ ok: false, error: 'task not open, or its run is no longer awaiting_human' });
      case 'invalid_target':
        throw new BadRequestException({
          ok: false,
          error: 'target_agent_id is not a valid, enabled agent in this workspace',
        });
      case 'active_run_conflict':
        throw new ConflictException({
          ok: false,
          error:
            'another run is active on this ticket — wait for it to finish (or cancel it), then resume again',
        });
      case 'resumed':
        return { ok: true, action: 'resume', newRunId: result.newRunId };
      case 'closed':
        return { ok: true, action: parsed.data.action };
    }
  }
}
