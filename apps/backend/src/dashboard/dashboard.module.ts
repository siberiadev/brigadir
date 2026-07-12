import { Module } from '@nestjs/common';
import { RunsModule } from '@brigadir/runs';
import { WorkspacesController } from './workspaces.controller';
import { AgentsController } from './agents.controller';
import { dashboardTokenProvider } from './dashboard-token.provider';
import { DashboardTokenGuard } from './dashboard-token.guard';

/**
 * Dashboard REST module (feature 005). Guards all `/api/workspaces*` and
 * `/api/agents*` routes with the shared bearer (DashboardTokenGuard). Relies on
 * the global JiraModule (JiraClientFactory + StatusesService), DatabaseModule
 * (DRIZZLE) and QueuesModule; RunsModule provides RunTriggerService for test-run.
 * The callback routes stay on their own module + RunTokenGuard — no overlap.
 */
@Module({
  imports: [RunsModule],
  controllers: [WorkspacesController, AgentsController],
  providers: [dashboardTokenProvider, DashboardTokenGuard],
})
export class DashboardModule {}
