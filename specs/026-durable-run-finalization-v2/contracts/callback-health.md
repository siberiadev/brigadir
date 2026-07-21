# Contract: Callback channel health endpoint

**Additive** — no existing callback route changes (spec FR-016).

## `GET /api/callbacks/health`

| Aspect | Value |
|---|---|
| Auth | **None** (no `RunTokenGuard`; deliberately outside the `api/callbacks/runs/:runId` guarded controller) |
| Request | No params, no body |
| Response 200 | `{ "status": "ok" }` — static body |
| Other statuses | None produced by the handler; transport-level failures (conn refused, timeout) are what the probe interprets as "dead" |
| Sensitive data | None: no DB access, no version/config/topology echo (spec FR-012) |

## Probe semantics (worker side)

- URL: `<BRIGADIR_CALLBACK_BASE_URL default http://127.0.0.1:3000/api/callbacks>/health`
- Method GET, `AbortSignal.timeout(2000)`.
- Alive ⇔ HTTP 2xx. Any non-2xx, timeout, or network error ⇒ dead.
- Liveness only: a 200 proves the backend HTTP stack is up and routing —
  the 2026-07-19 outage class. It does NOT prove DB readiness or detect
  client-side bugs / mid-run channel death (stated spec limitation; the
  outbox + reconcile paths cover those).

## Compatibility

- Backend deployments without this endpoint (rollout skew): probe gets
  404 ⇒ non-2xx ⇒ callback-wired runs would be held. Therefore slice D
  (worker probe) MUST NOT be deployed before the backend carries this
  endpoint — enforced by landing controller + probe in the same slice and
  the single-image deploy model (backend and worker are built from one
  image).
