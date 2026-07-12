import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { DashboardTokenGuard } from './dashboard-token.guard';

const TOKEN = 'the-correct-dashboard-token';

function ctxWithAuth(header?: string): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers: header ? { authorization: header } : {} }) }),
  } as unknown as ExecutionContext;
}

describe('DashboardTokenGuard (T132)', () => {
  const guard = new DashboardTokenGuard(TOKEN);

  it('accepts the correct bearer token', () => {
    expect(guard.canActivate(ctxWithAuth(`Bearer ${TOKEN}`))).toBe(true);
  });

  it('rejects a wrong token', () => {
    expect(() => guard.canActivate(ctxWithAuth('Bearer wrong'))).toThrow(UnauthorizedException);
  });

  it('rejects a wrong token of the SAME length (constant-time path)', () => {
    const sameLen = 'x'.repeat(TOKEN.length);
    expect(() => guard.canActivate(ctxWithAuth(`Bearer ${sameLen}`))).toThrow(UnauthorizedException);
  });

  it('rejects a missing / malformed header', () => {
    expect(() => guard.canActivate(ctxWithAuth())).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(ctxWithAuth(TOKEN))).toThrow(UnauthorizedException); // no "Bearer "
  });

  it('uses timingSafeEqual and guards length mismatch (source check)', () => {
    const src = readFileSync(join(__dirname, 'dashboard-token.guard.ts'), 'utf8');
    expect(src.includes('timingSafeEqual')).toBe(true);
    expect(src.includes('provided.length !== expected.length')).toBe(true);
  });
});
