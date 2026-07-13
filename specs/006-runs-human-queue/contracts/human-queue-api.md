# Contract — Human Queue API (US1)

Guarded by `DashboardTokenGuard`. Shared error envelope. `snake_case` bodies. Types in
`packages/contracts/src/human-queue.schema.ts` (new). The **resolve** endpoint already exists
(feature 004) and is reused unchanged in behavior; it only **gains the guard**.

The queue is **global across workspaces** (US1 — one list), though every task belongs to a
workspace.

---

## GET `/api/human-tasks` — list (FR-001, FR-006)

Query: `status` ∈ `open | closed` (default `open`).

**200** →
```jsonc
{
  "items": [
    {
      "id": "uuid",
      "kind": "blocker",                 // question | blocker | review
      "title": "Which DB should I migrate?",
      "details": "…",                    // nullable
      "blocking": true,
      "ticket": { "key": "BRIG-42", "jira_url": "https://acme.atlassian.net/browse/BRIG-42" },
      "agent": { "id": "uuid", "name": "migrator" },   // via the blocked run, when present
      "run_id": "uuid",                  // blocked run, nullable
      "created_at": "2026-07-12T09:00:00.000Z",   // UI derives age
      // closed-only fields (status=closed):
      "status": "resolved",              // resolved | dismissed
      "resolution": "use Postgres",      // nullable
      "resolved_by": "dima",             // nullable
      "resolved_at": "…"
    }
  ]
}
```
Open list ordered **oldest-first** (longest-waiting on top). Closed list ordered
`resolved_at desc`. No open tasks → `items: []` (empty state; the queue is NOT forced as the
landing view — FR-002 / spec Edge Case).

## GET `/api/human-tasks/count` — badge (FR-005)

**200** → `{ "open": 3 }` — count of `status='open'`. Polled ~3 s (research R1) to drive the
navbar badge live.

---

## POST `/api/human-tasks/:id/resolve` — existing (FR-003, FR-004) — **now guarded**

Unchanged request/response from feature 004 (`ResolveController` + `ResumeService`). The one
change: `DashboardTokenGuard` is applied (was `// unguarded this iteration`) to satisfy
FR-032. No behavior change (FR-033).

Request (`ResolveHumanTaskSchema`, `packages/contracts`):
```jsonc
{ "action": "resume" | "done_manually" | "dismiss", "answer": "…?", "resolved_by": "…?" }
```

Responses (existing):
- **200** `{ "ok": true, "action": "resume", "newRunId": "<uuid>" }` — blocking task resumed;
  drives the feature-004 resume path (supersede parked run + insert next attempt through the
  three dedup layers). FR-004 / SC-004.
- **200** `{ "ok": true, "action": "done_manually" | "dismiss" }` — closed, no new attempt.
- **404** `{ ok:false, error:"human task not found" }`.
- **409** `{ ok:false, error:"task not open, or its run is no longer awaiting_human" }`.
- **422** `{ ok:false, errors:[…] }` — schema-invalid body.

---

## Landing-view rule (FR-002)
The SPA reads `GET /api/human-tasks/count` on load: `open > 0` → the human queue is the
default landing view; `open == 0` → normal landing (workspaces), queue reachable but showing
its empty state. This is a client routing decision on top of the count endpoint — no server
redirect.
