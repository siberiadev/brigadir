import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Per-run JWT (contracts/run-jwt.md). HS256 via node built-in `crypto` only —
 * no `jsonwebtoken`/`jose` dependency (research D4). Authentication factor
 * only: the DB run `status` is the authorization source of truth (FR-003).
 */

export interface RunTokenClaims {
  sub: string; // runId
  wsp: string; // workspaceId
  // Ticket key — informational only (the guard verifies `sub` + DB run status,
  // never `tkt`). Absent for ticketless workspace-setup runs (feature 011, D4).
  tkt?: string;
  iat: number; // epoch seconds
  exp: number; // epoch seconds
}

const HEADER = { alg: 'HS256', typ: 'JWT' } as const;

function base64url(input: string | Buffer): string {
  return (Buffer.isBuffer(input) ? input : Buffer.from(input)).toString('base64url');
}

function sign(headerAndPayload: string, secret: string): string {
  return base64url(createHmac('sha256', secret).update(headerAndPayload).digest());
}

export function signRunToken(claims: Omit<RunTokenClaims, 'iat'>, secret: string): string {
  const fullClaims: RunTokenClaims = { ...claims, iat: Math.floor(Date.now() / 1000) };
  const headerPart = base64url(JSON.stringify(HEADER));
  const payloadPart = base64url(JSON.stringify(fullClaims));
  const signingInput = `${headerPart}.${payloadPart}`;
  const signaturePart = sign(signingInput, secret);
  return `${signingInput}.${signaturePart}`;
}

export function verifyRunToken(token: string, secret: string): RunTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('malformed run token');
  }
  const [headerPart, payloadPart, signaturePart] = parts;
  const signingInput = `${headerPart}.${payloadPart}`;
  const expectedSignature = sign(signingInput, secret);

  const expectedBuf = Buffer.from(expectedSignature);
  const actualBuf = Buffer.from(signaturePart);
  if (
    expectedBuf.length !== actualBuf.length ||
    !timingSafeEqual(expectedBuf, actualBuf)
  ) {
    throw new Error('run token signature mismatch');
  }

  let claims: RunTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as RunTokenClaims;
  } catch {
    throw new Error('malformed run token payload');
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp < nowSeconds) {
    throw new Error('run token expired');
  }

  return claims;
}
