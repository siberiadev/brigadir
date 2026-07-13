import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { BRIGADIR_DASHBOARD_TOKEN } from './dashboard-token.provider';

/** Minimal request shape — avoids an `@types/express` dependency. */
interface DashboardHttpRequest {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Guards all `/api/*` dashboard routes with the shared bearer (feature 005, R5).
 * Comparison is constant-time (`crypto.timingSafeEqual`) on equal-length
 * buffers; a length mismatch is an immediate reject (timingSafeEqual throws on
 * unequal lengths, which would itself leak length via the exception path — so we
 * short-circuit first without revealing timing).
 *
 * Structurally separate from `RunTokenGuard` (callbacks): a dashboard token
 * never authorizes a callback, and a run token never authorizes `/api/workspaces`.
 */
@Injectable()
export class DashboardTokenGuard implements CanActivate {
  constructor(@Inject(BRIGADIR_DASHBOARD_TOKEN) private readonly token: string) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<DashboardHttpRequest>();
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('missing bearer token');
    }
    const provided = Buffer.from(header.slice('Bearer '.length));
    const expected = Buffer.from(this.token);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new UnauthorizedException('invalid dashboard token');
    }
    return true;
  }
}
