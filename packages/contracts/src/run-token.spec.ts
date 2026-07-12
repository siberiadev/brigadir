import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { signRunToken, verifyRunToken, type RunTokenClaims } from './run-token';

const SECRET = 'test-jwt-secret-do-not-use-in-prod';

describe('run-token (T093)', () => {
  it('round-trips: sign then verify returns the same claims', () => {
    const token = signRunToken(
      { sub: 'run-1', wsp: 'ws-1', tkt: 'BRIG-1', exp: Math.floor(Date.now() / 1000) + 3600 },
      SECRET,
    );
    const claims = verifyRunToken(token, SECRET);
    expect(claims.sub).toBe('run-1');
    expect(claims.wsp).toBe('ws-1');
    expect(claims.tkt).toBe('BRIG-1');
    expect(typeof claims.iat).toBe('number');
  });

  it('throws on a token past exp', () => {
    const token = signRunToken(
      { sub: 'run-1', wsp: 'ws-1', tkt: 'BRIG-1', exp: Math.floor(Date.now() / 1000) - 10 },
      SECRET,
    );
    expect(() => verifyRunToken(token, SECRET)).toThrow(/expired/);
  });

  it('throws on a token signed with a different secret', () => {
    const token = signRunToken(
      { sub: 'run-1', wsp: 'ws-1', tkt: 'BRIG-1', exp: Math.floor(Date.now() / 1000) + 3600 },
      SECRET,
    );
    expect(() => verifyRunToken(token, 'a-completely-different-secret')).toThrow(/signature/);
  });

  it('throws when the payload is tampered without re-signing', () => {
    const token = signRunToken(
      { sub: 'run-1', wsp: 'ws-1', tkt: 'BRIG-1', exp: Math.floor(Date.now() / 1000) + 3600 },
      SECRET,
    );
    const [headerPart, payloadPart, sigPart] = token.split('.');
    const claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as RunTokenClaims;
    const tamperedPayload = Buffer.from(JSON.stringify({ ...claims, sub: 'run-2' })).toString('base64url');
    const tamperedToken = `${headerPart}.${tamperedPayload}.${sigPart}`;
    expect(() => verifyRunToken(tamperedToken, SECRET)).toThrow(/signature/);
  });

  it('uses only node built-in crypto — no jsonwebtoken/jose dependency', () => {
    const src = readFileSync(new URL('./run-token.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from ['"]jsonwebtoken['"]|from ['"]jose['"]/);
    expect(src).toMatch(/from ['"]node:crypto['"]/);
  });
});
