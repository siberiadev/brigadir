import { describe, it, expect, afterEach } from 'vitest';
import { resolveJwtSecret, JwtSecretMissingError } from './jwt-secret.provider';

describe('resolveJwtSecret (T097)', () => {
  const original = process.env.BRIGADIR_JWT_SECRET;

  afterEach(() => {
    if (original === undefined) delete process.env.BRIGADIR_JWT_SECRET;
    else process.env.BRIGADIR_JWT_SECRET = original;
  });

  it('returns the env value when set', () => {
    process.env.BRIGADIR_JWT_SECRET = 'a-real-secret';
    expect(resolveJwtSecret()).toBe('a-real-secret');
  });

  it('throws a boot error when absent — no silent default', () => {
    delete process.env.BRIGADIR_JWT_SECRET;
    expect(() => resolveJwtSecret()).toThrow(JwtSecretMissingError);
  });

  it('throws when the env value is an empty string — no silent default', () => {
    process.env.BRIGADIR_JWT_SECRET = '';
    expect(() => resolveJwtSecret()).toThrow(JwtSecretMissingError);
  });
});
