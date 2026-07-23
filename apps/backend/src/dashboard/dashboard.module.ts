import { Module } from '@nestjs/common';
import { RunsModule } from '@brigadir/runs';
import { PipelineModule } from '@brigadir/pipeline';
import { WorkspacesController } from './workspaces.controller';
import { AgentsController } from './agents.controller';
import { ExecutorsController } from './executors.controller';
import { RunsController } from './runs.controller';
import { HomeController } from './home.controller';
import { MetricsController } from './metrics.controller';
import { HumanTasksController } from './human-tasks.controller';
import { BrigadirAgentSettingsController } from './brigadir-agent-settings.controller';
import { ChannelHealthController } from './channel-health.controller';
import { ChannelHealthService } from './channel-health.service';
import { ReconcileController } from './reconcile.controller';
import { ReconcileService } from './reconcile.service';
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
    HomeController,
    // Feature 029: read-only metrics timeline aggregates.
    MetricsController,
    HumanTasksController,
    BrigadirAgentSettingsController,
    // Feature 027 (US4): channel-health агрегат.
    ChannelHealthController,
    // Статус/ручной запуск реконсайл-цикла (кнопка «Sync now» на Runs).
    ReconcileController,
  ],
  providers: [
    dashboardTokenProvider,
    DashboardTokenGuard,
    ExecutorBackfillService,
    OrchestratorBackfillService,
    ChannelHealthService,
    ReconcileService,
  ],
})
export class DashboardModule {}
