# Contract: Exclusive Worker Lock

Guarantees FR-004 / SC-002: at most one worker consumes the agent queues per
BullMQ namespace; the double-worker mistake is impossible silently.

## Keys (Redis, same connection/instance as BullMQ)

| key | content | TTL |
|---|---|---|
| `${BULLMQ_PREFIX ?? 'bull'}:worker-lock` | JSON `{ mode, pid, hostname, acquired_at }` | `BRIGADIR_WORKER_LOCK_TTL_MS` (default 15 000 ms) |
| `${BULLMQ_PREFIX ?? 'bull'}:worker-lock:contender` | same identity shape | 30 000 ms fixed |

Prefix is read lazily (same rule as `queues.module.ts`) — integration suites
with per-suite prefixes get automatically isolated locks.

## Semantics

1. **Startup**: every WorkerHost queue consumer starts **paused**. The lock
   service enters an acquire loop (`SET key value NX PX ttl`, cadence ~2 s).
2. **Acquired** → resume all consumers; log info with identity; start
   renewal at TTL/3 using compare-and-extend (Lua: extend only if the stored
   value matches own identity).
3. **Blocked** (key held by другой identity) → stay paused; log **error**
   every attempt naming the holder identity; set the `:contender` key so the
   holder sees the conflict too. Never consume, never exit — waiting is the
   drain mechanism.
4. **Holder sees contender** (renewal tick finds `:contender`) → log
   **error** naming the contender. Both sides are loud within ~2 s of the
   overlap (SC-002's 10 s budget).
5. **Graceful shutdown** → compare-and-del release (Lua) after BullMQ drain;
   a waiting contender acquires on its next tick (drain-then-takeover, the
   clarified mode-switch behavior — in-flight runs finish under the old
   holder because consumers drain before release).
6. **Ungraceful death** → no release; TTL expiry (≤ 15 s) → contender
   acquires. Bounded takeover, never two simultaneous consumers (renewal
   loss on the zombie side ⇒ immediate re-pause before any further job
   pickup).
7. **Renewal failure / lock lost** → re-pause all consumers immediately,
   error log, re-enter acquire loop. Pause is synchronous relative to job
   pickup (BullMQ `pause()` awaited before continuing).

## Invariants

- The lock gates ALL queue consumers in the worker process (run.* queues and
  reconcile queues alike) — one active worker per namespace, full stop.
- The lock holds no durable state (Constitution I): losing Redis loses only
  coordination; BullMQ jobs and run state are unaffected.
- The three idempotency layers (webhook dedup, queue dedup, `runs_one_active`)
  are untouched; the lock is an additional guard, not a replacement.
- Enqueue paths (backends) are NOT gated — either backend may enqueue;
  only consumption is exclusive.
- Phase-0 runs are consumed by the same gated workers — no behavioral change
  beyond the single-consumer guarantee itself.

## Operator surface

- `agents:status` reports whether the stable worker holds the lock (from its
  log tail / process liveness); the dashboard's channel-health popover shows
  guard + failure data but lock state is intentionally log-level only in
  this feature (no new endpoint field; revisit only if practice demands).
