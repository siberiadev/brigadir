import {
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { GetTicketSchema, SearchTicketsSchema } from '@brigadir/contracts';
import { CallbackService } from './callback.service';
import { JiraReadService } from './jira-read.service';
import { TemplateReadService } from './template-read.service';
import { RunTokenGuard } from './run-token.guard';

/**
 * CallbackController (contracts/callback-http-api.md). Base path
 * `/api/callbacks/runs/:runId`; every route is guarded by RunTokenGuard
 * (FR-003) before the handler runs.
 */
@Controller('api/callbacks/runs/:runId')
@UseGuards(RunTokenGuard)
export class CallbackController {
  constructor(
    private readonly callback: CallbackService,
    // feature 011 (FR-008..011): read-only Jira reads for EVERY run — same
    // guard, workspace-scoped, credential-free for the agent.
    private readonly jiraRead: JiraReadService,
    // feature 030: read-only role-template catalog for EVERY run — same guard,
    // workspace-scoped, carries template TEXT only (never source creds).
    private readonly templateRead: TemplateReadService,
  ) {}

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
  async complete(
    @Param('runId') runId: string,
    @Body() body: unknown,
    // Feature 024 (US3): observed worktree HEADs, attached by the tool server
    // (never by the agent's tool input). Absent for non-repo/legacy callers.
    @Headers('x-brigadir-observed-heads') observedHeads: string | undefined,
  ): Promise<unknown> {
    const result = await this.callback.complete(runId, body, observedHeads);
    if ('kind' in result) {
      if (result.kind === 'validation') {
        throw new UnprocessableEntityException({ ok: false, errors: result.errors });
      }
      throw new ConflictException({ ok: false, error: 'conflict' });
    }
    return result;
  }

  // --- feature 011: read-only Jira tools (contracts/jira-read-tools.md) ---

  @Get('jira/overview')
  async jiraOverview(@Param('runId') runId: string): Promise<unknown> {
    return this.jiraRead.overview(runId);
  }

  @Post('jira/search')
  @HttpCode(200)
  async jiraSearch(@Param('runId') runId: string, @Body() body: unknown): Promise<unknown> {
    const parsed = SearchTicketsSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new UnprocessableEntityException({ ok: false, errors: parsed.error.issues });
    }
    return this.jiraRead.search(runId, parsed.data);
  }

  @Get('jira/tickets/:key')
  async jiraTicket(@Param('runId') runId: string, @Param('key') key: string): Promise<unknown> {
    const parsed = GetTicketSchema.safeParse({ key });
    if (!parsed.success) {
      throw new UnprocessableEntityException({ ok: false, errors: parsed.error.issues });
    }
    return this.jiraRead.getTicket(runId, parsed.data);
  }

  // --- feature 030: read-only role-template tools (contracts/role-templates.md §2).
  // Never 5xx on a bad template source — resolution falls back to built-ins with
  // a diagnostic in the `source` block. A 404 (unknown slug) carries `available`.

  @Get('templates')
  async listTemplates(@Param('runId') runId: string): Promise<unknown> {
    return this.templateRead.list(runId);
  }

  @Get('templates/:slug')
  async getTemplate(@Param('runId') runId: string, @Param('slug') slug: string): Promise<unknown> {
    return this.templateRead.get(runId, slug);
  }
}
