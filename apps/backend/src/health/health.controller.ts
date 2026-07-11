import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { HealthService, type HealthReport } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  async check(): Promise<HealthReport> {
    const report = await this.health.check();
    if (report.status !== 'ok') {
      // 503 so the compose healthcheck marks the service unhealthy.
      throw new ServiceUnavailableException(report);
    }
    return report;
  }
}
