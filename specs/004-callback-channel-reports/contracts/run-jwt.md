# Contract: Run JWT (per-run credential)

HS256, signed and verified with **node built-in `crypto`** — no new dependency (research D4). Lives
in `packages/contracts/src/run-token.ts` as the single typed source (Constitution "Technology
Constraints").

## Claims (`RunTokenClaims`)

```jsonc
{
  "sub": "<runId>",         // authenticates the ONE run this token is scoped to
  "wsp": "<workspaceId>",
  "tkt": "<ticketKey>",     // e.g. BRIG-123
  "iat": 1752000000,        // epoch seconds
  "exp": 1752002700         // = started_at + timeout_ms/1000 + grace (grace = 300s)
}
```

## API

```ts
export interface RunTokenClaims { sub: string; wsp: string; tkt: string; iat: number; exp: number; }
export function signRunToken(claims: Omit<RunTokenClaims,'iat'>, secret: string): string;   // HS256
export function verifyRunToken(token: string, secret: string): RunTokenClaims;               // throws on bad sig/exp
```

- **Header:** `{ "alg": "HS256", "typ": "JWT" }`. Standard `base64url(header).base64url(payload).sig`.
- **Secret:** `BRIGADIR_JWT_SECRET`, shared by worker (sign) and backend (verify), read in a **DI
  factory** — never at `@Module()` composition (Constitution "Lazy resource resolution"). No silent
  localhost/default fallback: absent secret → boot error.

## Guard semantics (backend `run-token.guard`) — FR-003

The token is an **authentication factor only**; the DB run `status` is the **authorization source of
truth**:

1. `verifyRunToken` — signature + `exp` valid (else 401).
2. `claims.sub === :runId` path param (else 401/403).
3. DB re-read: run `status ∈ {running, awaiting_human}` (else 409).

Consequences (SC-004, SC-007; spec edge cases):
- Token minted for a **different** run → `sub` mismatch → rejected.
- **Expired** token (run ran past `exp`) → rejected; callbacks cannot silently keep a run alive.
- Token for an already **finalized/cancelled/superseded** run → status check fails → rejected; no
  resurrection, nothing persisted.
