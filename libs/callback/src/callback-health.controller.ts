import { Controller, Get } from '@nestjs/common';

/**
 * Unauthenticated callback-channel liveness probe (feature 026, US4;
 * contracts/callback-health.md). A sibling of the guarded
 * `api/callbacks/runs/:runId` controller — deliberately NOT on it, so the
 * RunTokenGuard surface stays untouched (FR-016). Returns a static body: a 200
 * proves the backend HTTP stack is up and routing (the 2026-07-19 outage
 * class). No DB access, no version/config/topology echo — liveness only, no
 * sensitive data (FR-012).
 */
@Controller('api/callbacks')
export class CallbackHealthController {
  @Get('health')
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
