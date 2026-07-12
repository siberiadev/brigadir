import {
  Body,
  ConflictException,
  Controller,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ResolveHumanTaskSchema } from '@brigadir/contracts';
import { ResumeService } from './resume.service';

/** `POST /api/human-tasks/:id/resolve` (quickstart.md) — unguarded this iteration (Tasks UI out of scope). */
@Controller('api/human-tasks')
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
      case 'resumed':
        return { ok: true, action: 'resume', newRunId: result.newRunId };
      case 'closed':
        return { ok: true, action: parsed.data.action };
    }
  }
}
