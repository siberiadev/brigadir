import { Module } from '@nestjs/common';
import { RunsModule } from '@brigadir/runs';
import { PipelineModule } from '@brigadir/pipeline';
import { WorkspacesController } from './workspaces.controller';
import { AgentsController } from './agents.controller';
import { ExecutorsController } from './executors.controller';
import { RunsController } from './runs.controller';
import { HumanTasksController } from './human-tasks.controller';
import { GeneralSettingsController } from './general-settings.controller';
import { ExecutorBackfillService } from './executor-backfill.service';
import { OrchestratorBackfillService } from './orchestrator-backfill.service';
import { dashboardTokenProvider } from './dashboard-token.provider';
import { DashboardTokenGuard } from './dashboard-token.guard';

/**
 * Dashboard REST module (feature 005). Guards all `/api/workspaces*` and
 * `/api/agents*` routes with the shared bearer (DashboardTokenGuard). Relies on
 * the global JiraModule (JiraClientFactory + StatusesService), DatabaseModule
 * (DRIZZLE) and QueuesModule; RunsModule provides RunTriggerService for test-run.
 * The callback routes stay on their own module + RunTokenGuard — no overlap.
 *
 * Feature 012: PipelineModule provides SetupApplyService for the admin
 * `POST /api/workspaces/:id/team` endpoint (atomic team spawn reusing the
 * feature-011 validator/applier WITHOUT a run).
 */
@Module({
  imports: [RunsModule, PipelineModule],
  controllers: [
    WorkspacesController,
    AgentsController,
    ExecutorsController,
    RunsController,
    HumanTasksController,
    GeneralSettingsController,
  ],
  providers: [
    dashboardTokenProvider,
    DashboardTokenGuard,
    ExecutorBackfillService,
    OrchestratorBackfillService,
  ],
})
export class DashboardModule {}
