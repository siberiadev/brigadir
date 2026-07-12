import {
  CanActivate,
  ConflictException,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { BRIGADIR_JWT_SECRET } from '@brigadir/app-config';
import { verifyRunToken } from '@brigadir/contracts';

/**
 * Callback auth guard (FR-003, contracts/run-jwt.md). Minimal structural
 * request shape — avoids an `@types/express` dependency; any real Express
 * request satisfies it.
 */
export interface CallbackHttpRequest {
  params: Record<string, string | undefined>;
  headers: Record<string, string | string[] | undefined>;
  runId?: string;
}

/** DB run states a callback may legitimately target (FR-003). */
const ACCEPTABLE_RUN_STATUSES = new Set(['running', 'awaiting_human']);

function extractBearerToken(headers: CallbackHttpRequest['headers']): string | undefined {
  const raw = headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !value.startsWith('Bearer ')) return undefined;
  return value.slice('Bearer '.length).trim() || undefined;
}

/**
 * Guard semantics (contracts/run-jwt.md):
 * 1. `verifyRunToken` — signature + `exp` (else 401).
 * 2. `claims.sub === :runId` path param (else 401).
 * 3. DB re-read: run `status ∈ {running, awaiting_human}` (else 409).
 *
 * The token is an authentication factor only — the DB run `status` is the
 * authorization source of truth, re-read on every call (never cached).
 */
@Injectable()
export class RunTokenGuard implements CanActivate {
  constructor(
    @Inject(DRIZZLE) private readonly db: BrigadirDb,
    @Inject(BRIGADIR_JWT_SECRET) private readonly jwtSecret: string,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<CallbackHttpRequest>();
    const runIdParam = request.params.runId;
    if (!runIdParam) {
      throw new UnauthorizedException('missing :runId path parameter');
    }

    const token = extractBearerToken(request.headers);
    if (!token) {
      throw new UnauthorizedException('missing bearer token');
    }

    let claimsSub: string;
    try {
      claimsSub = verifyRunToken(token, this.jwtSecret).sub;
    } catch {
      throw new UnauthorizedException('invalid or expired run token');
    }

    if (claimsSub !== runIdParam) {
      throw new UnauthorizedException('run token does not authorize this run');
    }

    const [run] = await this.db
      .select({ status: schema.runs.status })
      .from(schema.runs)
      .where(eq(schema.runs.id, runIdParam))
      .limit(1);

    if (!run || !ACCEPTABLE_RUN_STATUSES.has(run.status)) {
      throw new ConflictException('run is not in an acceptable state for callbacks');
    }

    request.runId = runIdParam;
    return true;
  }
}
