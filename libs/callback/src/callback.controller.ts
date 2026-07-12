import {
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Param,
  Post,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { CallbackService } from './callback.service';
import { RunTokenGuard } from './run-token.guard';

/**
 * CallbackController (contracts/callback-http-api.md). Base path
 * `/api/callbacks/runs/:runId`; every route is guarded by RunTokenGuard
 * (FR-003) before the handler runs.
 */
@Controller('api/callbacks/runs/:runId')
@UseGuards(RunTokenGuard)
export class CallbackController {
  constructor(private readonly callback: CallbackService) {}

  @Post('progress')
  @HttpCode(200)
  async progress(@Param('runId') runId: string, @Body() body: unknown): Promise<unknown> {
    const result = await this.callback.progress(runId, body);
    if ('kind' in result) {
      throw new UnprocessableEntityException({ ok: false, errors: result.errors });
    }
    return result;
  }

  @Post('human')
  @HttpCode(200)
  async human(@Param('runId') runId: string, @Body() body: unknown): Promise<unknown> {
    const result = await this.callback.human(runId, body);
    if ('kind' in result) {
      throw new UnprocessableEntityException({ ok: false, errors: result.errors });
    }
    return result;
  }

  @Post('complete')
  @HttpCode(200)
  async complete(@Param('runId') runId: string, @Body() body: unknown): Promise<unknown> {
    const result = await this.callback.complete(runId, body);
    if ('kind' in result) {
      if (result.kind === 'validation') {
        throw new UnprocessableEntityException({ ok: false, errors: result.errors });
      }
      throw new ConflictException({ ok: false, error: 'conflict' });
    }
    return result;
  }
}
