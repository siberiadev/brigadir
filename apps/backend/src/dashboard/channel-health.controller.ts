import { Controller, Get, UseGuards } from '@nestjs/common';
import type { ChannelHealthResponse } from '@brigadir/contracts';
import { DashboardTokenGuard } from './dashboard-token.guard';
import { ChannelHealthService } from './channel-health.service';

/**
 * GET /api/channel-health (feature 027, US4) — additive read-only агрегат
 * здоровья callback-канала для оператора. За тем же dashboard-bearer'ом, что
 * и весь остальной дашборд; callback-эндпоинты и /health не тронуты
 * (contracts/channel-health-api.md). Безопасен при 5-секундном поллинге:
 * два оконных count'а + мемоизированный stat артефакта.
 */
@Controller()
@UseGuards(DashboardTokenGuard)
export class ChannelHealthController {
  constructor(private readonly health: ChannelHealthService) {}

  @Get('api/channel-health')
  async get(): Promise<ChannelHealthResponse> {
    return this.health.aggregate();
  }
}
