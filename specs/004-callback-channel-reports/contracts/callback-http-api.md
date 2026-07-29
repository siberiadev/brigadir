# Contract: Callback HTTP API

Backend `CallbackModule`, mounted in `apps/backend`. Agents reach it over **localhost HTTP**
(single-host model). Base path `/api/callbacks`. Normative source: architecture §5.

All three endpoints require `Authorization: Bearer <run JWT>` and are gated by `run-token.guard`:

1. Verify HS256 signature (`BRIGADIR_JWT_SECRET`) and `exp` (else **401**).
2. `claims.sub === :runId` path param (else **401/403**).
3. Re-read the run row; require `status ∈ {running, awaiting_human}` (else **409**). — FR-003.

Free-text fields are **scrubbed** (secret regex + entropy) before persistence and before any Jira
write (FR-024).

---

## `POST /api/callbacks/runs/:runId/progress`  → FR-021

Body = `ReportProgressSchema` (`packages/contracts`):
```jsonc
{ "stage": "implementing", "message": "wired the handler", "percent": 40 }
```
Effect: insert `run_events(type='progress', payload)`, `job.updateProgress()`, SSE to dashboard.
Run status unchanged. **200** `{ "ok": true }`.

---

## `POST /api/callbacks/runs/:runId/human`  → FR-012 / FR-014 / FR-015 / FR-020

Body = `RequestHumanSchema`:
```jsonc
{ "kind": "question", "title": "Which auth flow — OAuth or API token?", "details": "…", "blocking": true }
```
Effect:
- Create `human_tasks` row (kind, scrubbed title/details, blocking, `run_id`, `ticket_id`,
  `workspace_id`), deduped to one open task per run (FR-020).
- **blocking=true:** park run → `awaiting_human`; transition ticket → agent's blocked status +
  ADF comment carrying the (scrubbed) question (via `PipelineService`/`JiraClient`). Response tells
  the agent it may finish **without** `complete_task`. The MCP server writes the completion marker on
  this 2xx (FR-013).
- **blocking=false:** create task only; run stays `running` (FR-014).

**200** `{ "ok": true, "blocking": true, "mayFinishWithoutComplete": true }` (blocking) or
`{ "ok": true, "blocking": false }`.

---

## `POST /api/callbacks/runs/:runId/complete`  → FR-007 / FR-008 / FR-009 / FR-025

Body = `ReportSchema` (the full structured report). Effect:
- Validate against `ReportSchema`. **Invalid → 422** with `{ "ok": false, "errors": [zod issues] }`;
  run **not** finalized (FR-008; agent repairs & resubmits — the MCP client does not retry 4xx, D9).
- Valid → `RunsService.finalizeWithReport` (guarded terminal UPDATE + `run_checks` +
  `needs_human` human-task dedup) then `PipelineService.onRunFinished` (Jira transition + ADF
  checklist comment). Report free-text scrubbed first.
- **FR-025:** if the agent's delivery mode is `pull_request` and `outcome=success` with
  `artifacts.pr_url`, create a **non-blocking** `kind=review` human task carrying the PR reference.
  The orchestrator never merges.
- The MCP server writes the completion marker on 2xx (FR-013).
- Repeat completion for an already-finalized run → **409** `{ "ok": false, "error": "conflict" }`
  (FR-009; the guarded UPDATE matches 0 rows).
- **Feature 033 (side effect, evidence-gated, fail-open):** after a successful finalize, if the
  request carried a parseable `x-brigadir-observed-heads` header, the run is ticket-bound, and the
  report has ≥1 `pass` check, the backend whole-replaces `tickets.verification` with a sha-anchored
  receipt (`VerificationReceiptSchema`: `{version, runId, agentRole, agentName, outcome,
  recordedAt, gates[≤10, pass-only, deduped], repos{name→sha}}`) and writes a
  `run_events` row (`type:'log'`, `payload.source:'verification-receipt'`). Written for ALL report
  outcomes. Any failure in this block is logged and never affects the completion response; the
  worker exit-time/outbox finalization paths carry no observed heads and never write receipts.

**200** `{ "ok": true, "outcome": "success" }`.

---

## Error surface (repair loop, FR-006/FR-008)

| HTTP | Meaning | MCP client action |
|---|---|---|
| 200 | accepted | return success to model |
| 422 | schema invalid | return `errors[]` to model as tool error; **no retry** |
| 401/403 | bad/expired/mismatched token | return error; no retry |
| 409 | run not in acceptable state / already finalized | return error; no retry |
| 5xx / network | transient | **bounded retry** (≤3, backoff), then surface (D9) |
