import { Module } from '@nestjs/common';
import { DatabaseModule } from '@brigadir/database';
import { AppConfigModule } from '@brigadir/app-config';
import { QueuesModule } from '@brigadir/queues';
import { ExecutorsModule } from '@brigadir/executors';
import { RunsModule } from '@brigadir/runs';
import { JiraModule } from '@brigadir/jira';
import { PipelineModule } from '@brigadir/pipeline';
import { IngestModule } from '@brigadir/ingest';
import { HumanTaskService } from '@brigadir/human-tasks';
import { ReconcileProcessor } from './reconcile.processor';
import { ReconcileScheduler } from './reconcile.scheduler';
import { RunProcessor } from './run.processor';
import { ClaudeCliRunProcessor } from './claude-cli-run.processor';
import { KimiRunProcessor } from './kimi-run.processor';

/**
 * Worker composition. JiraModule.forRootAsync() is @Global and LAZY — it exposes
 * JIRA_CLIENT app-wide without reading credentials at boot (credential-free boot;
 * the reconcile pass resolves the client on first use). PipelineModule drives the
 * run→Jira write; IngestModule owns the reconcile job. `ClaudeCliRunProcessor`
 * binds to `run.claude_cli`, auto-provisioned by `QueuesModule.register()`
 * whenever `agents.yaml` declares a `claude_cli` executor (T083). AppConfigModule
 * imported directly (same accepted multi-import pattern as ExecutorsModule) so
 * `ClaudeCliRunProcessor` can inject BRIGADIR_JWT_SECRET (feature 004) to mint
 * run tokens for callback-wired runs.
 */
@Module({
  imports: [
    DatabaseModule.forRoot(),
    AppConfigModule,
    QueuesModule.register(),
    ExecutorsModule,
    RunsModule,
    JiraModule.forRootAsync(),
    PipelineModule,
    IngestModule,
  ],
  // `HumanTaskService` is provided DIRECTLY (feature 020: the repo-scoping
  // gate parks runs from the worker) rather than via HumanTasksModule — the
  // module also carries ResolveController + the fail-fast dashboard-token
  // provider, which the worker deliberately does not have (compose gives the
  // worker no BRIGADIR_DASHBOARD_TOKEN). The service's own deps (DRIZZLE,
  // JiraClientFactory) are already global here.
  providers: [
    RunProcessor,
    ClaudeCliRunProcessor,
    // Feature 025: `run.kimi` — the same processor logic bound to the kimi
    // queue/profile budget (see kimi-run.processor.ts).
    KimiRunProcessor,
    ReconcileProcessor,
    ReconcileScheduler,
    HumanTaskService,
  ],
})
export class WorkerAppModule {}
