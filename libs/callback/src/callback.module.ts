import { Module } from '@nestjs/common';
import { AppConfigModule } from '@brigadir/app-config';
import { RunsModule } from '@brigadir/runs';
import { PipelineModule } from '@brigadir/pipeline';
import { HumanTasksModule } from '@brigadir/human-tasks';
import { AgentTemplatesModule } from '@brigadir/agent-templates';
import { CallbackController } from './callback.controller';
import { CallbackHealthController } from './callback-health.controller';
import { CallbackService } from './callback.service';
import { JiraReadService } from './jira-read.service';
import { TemplateReadService } from './template-read.service';
import { RunTokenGuard } from './run-token.guard';

/**
 * CallbackModule — the guarded callback HTTP API (contracts/callback-http-api.md).
 * Imports AppConfigModule directly (Nest DI is module-scoped — RunTokenGuard
 * needs BRIGADIR_JWT_SECRET visible in ITS OWN module graph, not just the
 * app root; same accepted multi-import pattern used elsewhere). Relies on
 * globally-provided DRIZZLE (DatabaseModule), JIRA_CLIENT
 * (JiraModule.forRootAsync), and the `run.<type>` BullMQ queue providers
 * (QueuesModule.register()) — expected to already be composed at the app
 * root (apps/backend), since ResumeService's resolve endpoint enqueues from
 * this process.
 */
@Module({
  imports: [AppConfigModule, RunsModule, PipelineModule, HumanTasksModule, AgentTemplatesModule],
  // CallbackHealthController is additive and unguarded (feature 026, US4).
  controllers: [CallbackController, CallbackHealthController],
  providers: [CallbackService, JiraReadService, TemplateReadService, RunTokenGuard],
})
export class CallbackModule {}
