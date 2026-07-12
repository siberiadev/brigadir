import { describe, it, expect } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { signRunToken } from '@brigadir/contracts';
import { RunTokenGuard, type CallbackHttpRequest } from './run-token.guard';

const SECRET = 'test-jwt-secret';

function fakeDb(row: { status: string } | undefined): unknown {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (row ? [row] : []),
        }),
      }),
    }),
  };
}

function fakeContext(params: Record<string, string>, authorization?: string): ExecutionContext {
  const request: CallbackHttpRequest = { params, headers: authorization ? { authorization } : {} };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function tokenFor(runId: string, expiresInSec = 3600, secret = SECRET): string {
  return signRunToken(
    { sub: runId, wsp: 'ws-1', tkt: 'BRIG-1', exp: Math.floor(Date.now() / 1000) + expiresInSec },
    secret,
  );
}

describe('RunTokenGuard (T099)', () => {
  it('accepts a well-formed token whose run is running', async () => {
    const guard = new RunTokenGuard(fakeDb({ status: 'running' }) as never, SECRET);
    const ctx = fakeContext({ runId: 'run-1' }, `Bearer ${tokenFor('run-1')}`);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('accepts a well-formed token whose run is awaiting_human', async () => {
    const guard = new RunTokenGuard(fakeDb({ status: 'awaiting_human' }) as never, SECRET);
    const ctx = fakeContext({ runId: 'run-1' }, `Bearer ${tokenFor('run-1')}`);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('rejects with 401 when the Authorization header is missing', async () => {
    const guard = new RunTokenGuard(fakeDb({ status: 'running' }) as never, SECRET);
    const ctx = fakeContext({ runId: 'run-1' });
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects with 401 when the token is minted for a different run (sub mismatch)', async () => {
    const guard = new RunTokenGuard(fakeDb({ status: 'running' }) as never, SECRET);
    const ctx = fakeContext({ runId: 'run-1' }, `Bearer ${tokenFor('run-OTHER')}`);
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects with 401 when the token is expired', async () => {
    const guard = new RunTokenGuard(fakeDb({ status: 'running' }) as never, SECRET);
    const ctx = fakeContext({ runId: 'run-1' }, `Bearer ${tokenFor('run-1', -10)}`);
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects with 401 when the token was signed with a different secret', async () => {
    const guard = new RunTokenGuard(fakeDb({ status: 'running' }) as never, SECRET);
    const ctx = fakeContext({ runId: 'run-1' }, `Bearer ${tokenFor('run-1', 3600, 'wrong-secret')}`);
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects with 409 when the run is already finalized', async () => {
    const guard = new RunTokenGuard(fakeDb({ status: 'succeeded' }) as never, SECRET);
    const ctx = fakeContext({ runId: 'run-1' }, `Bearer ${tokenFor('run-1')}`);
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ status: 409 });
  });

  it('rejects with 409 when the run does not exist', async () => {
    const guard = new RunTokenGuard(fakeDb(undefined) as never, SECRET);
    const ctx = fakeContext({ runId: 'run-1' }, `Bearer ${tokenFor('run-1')}`);
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ status: 409 });
  });
});
