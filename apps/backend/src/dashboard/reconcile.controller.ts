import { Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import type { ReconcileStatusResponse, ReconcileTriggerResponse } from '@brigadir/contracts';
import { DashboardTokenGuard } from './dashboard-token.guard';
import { ReconcileService } from './reconcile.service';

/**
 * Реконсайл-цикл для оператора: GET /api/reconcile/status — расписание
 * (интервал/следующий/последний тик) для отсчёта на странице Runs, безопасен
 * при 5-секундном поллинге; POST /api/reconcile/trigger — «Sync now», кладёт
 * ручной тик в очередь (в Jira пишет по-прежнему только worker-цикл).
 */
@Controller()
@UseGuards(DashboardTokenGuard)
export class ReconcileController {
  constructor(private readonly reconcile: ReconcileService) {}

  @Get('api/reconcile/status')
  async status(): Promise<ReconcileStatusResponse> {
    return this.reconcile.status();
  }

  @Post('api/reconcile/trigger')
  @HttpCode(200)
  async trigger(): Promise<ReconcileTriggerResponse> {
    return this.reconcile.trigger();
  }
}
