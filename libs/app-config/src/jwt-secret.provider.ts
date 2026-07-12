import { Provider } from '@nestjs/common';

/**
 * Run-token signing secret (feature 004, contracts/run-jwt.md). Shared by the
 * worker (mints, `signRunToken`) and the backend (verifies, `run-token.guard`).
 * Resolved in a DI factory — NOT at `@Module()` composition — so it honors
 * env set by test harnesses/process managers after module-import time
 * (Constitution "Lazy resource resolution"). No silent localhost/dev
 * fallback: an absent secret is a boot error.
 */

export const BRIGADIR_JWT_SECRET = Symbol('BRIGADIR_JWT_SECRET');

export class JwtSecretMissingError extends Error {
  constructor() {
    super('BRIGADIR_JWT_SECRET env var is required (run-token signing/verification) — no default fallback');
    this.name = 'JwtSecretMissingError';
  }
}

export function resolveJwtSecret(): string {
  const secret = process.env.BRIGADIR_JWT_SECRET;
  if (!secret) {
    throw new JwtSecretMissingError();
  }
  return secret;
}

export const jwtSecretProvider: Provider = {
  provide: BRIGADIR_JWT_SECRET,
  useFactory: (): string => resolveJwtSecret(),
};
