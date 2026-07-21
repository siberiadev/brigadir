# Research — sprint-sequencing (Phase 0)

All Technical Context unknowns resolved. Decisions R1–R8.

## R1. The release loop already exists — build on it, don't rebuild it

**Decision**: Keep `ReconcileService.reEvaluateDependencies` (`libs/ingest/src/reconcile.service.ts`, reconcile pass step 2, originally FR-036 of feature 001) as the correctness core; extract it into a shared `DependencyReleaseService` and extend it (ordering, waiting-state persistence, classification) rather than writing a new mechanism.

**Rationale**: The design brief's premise ("B will never trigger") is out of date: step 2 already selects every ticket sitting in an enabled agent's trigger status with no active/succeeded run for that agent, batch-fetches fresh links via `project = K AND key in (...)` (deliberately independent of the HWM floor, since resolving a blocker changes only the blocker's `updated`), re-evaluates the gate, and triggers through `RunTriggerService`. It is integration-tested (`test/integration/dependency-gate.spec.ts`, T066/SC-010: fires exactly once when the blocker moves to Done, zero after). The clarify decision "pull is the guarantee" is therefore already implemented; the acceptance chain A→B→C most likely walks today, and the E2E test in quickstart.md will prove it. What is genuinely missing: deterministic order, persisted waiting visibility, diagnostics, and the immediate fast path.

**Alternatives considered**: (a) new event-driven release on blocker completion (push-only) — rejected in clarify: Jira never bumps a dependent's `updated`, push would need its own delivery guarantee; (b) leaving the logic in `ReconcileService` and duplicating it for the fast path — rejected: two copies of trigger-ordering logic drift apart.

**Update (2026-07-21)**: the candidate re-fetch's documented independence above is from the HWM floor only — this research never documented, and the implementation never applied, the workspace's `scope_jql`/sprint scope to that same re-fetch, even though R4 immediately below reuses `scope_jql` for the blocker probe. That silence let a compliance gap against feature 002-jira-core's FR-038 regress unnoticed: a locally-cached candidate that had drifted out of `scope_jql` scope (sprint ended, `scope_jql` narrowed) still triggered. Fixed by folding the same `buildScopeJql(...)` call R4 already uses into the candidate re-fetch itself — see `specs/022-sprint-sequencing/spec.md` Revision History and FR-002.

## R2. Priority representation and ordering key

**Decision**: Add `priority` to `POLL_FIELDS`; extend `JiraIssue['fields']` with optional `priority?: { id: string; name: string }`; persist on `tickets` as `priority_id int NULL` (parsed from Jira's numeric string id; NULL when absent/unparseable) + `priority_name text NULL`. Release order: `ORDER BY priority_id ASC NULLS LAST, jira_key ASC` (in SQL for the dashboard, and the same comparator in the release loop before triggering).

**Rationale**: Jira's built-in priority scheme uses numeric ids ordered Highest(1) → Lowest(5), so ascending id = descending importance without an extra API call. `jira_key` is a stable, human-predictable tiebreaker (spec FR-006). NULLS LAST implements "un-prioritized tickets order after prioritized ones" (spec assumption).

**Alternatives considered**: (a) fetching `/rest/api/3/priority` to resolve true scheme rank — correct for exotic custom schemes but adds a call, a cache, and a failure mode for an internal tool on the default scheme; documented limitation instead: custom priority schemes whose id order differs from rank order will sort by id (still deterministic, which is the hard requirement); (b) storing the raw priority object in jsonb — rejected: cannot ORDER BY it deterministically without expression indexes.

## R3. Waiting-state persistence (FR-001)

**Decision**: Two diff-cache columns on `tickets`: `blocked_by jsonb NULL` (array of blocker keys, e.g. `["BRIG-1","BRIG-7"]`) and `blocked_state text NULL` (`waiting | cycle | dead_end | out_of_scope`; NULL = not blocked-waiting). Written from exactly two places: the trigger-skip path in `PipelineService.onStatusChanged` (first observation of a blocked trigger-status ticket) and each `DependencyReleaseService` pass (kept current; cleared when the gate clears, the ticket triggers, or the ticket leaves the trigger status).

**Rationale**: The release loop needs an enumerable waiting set anyway (it already derives candidates from `last_seen_status` join); persisting the blocker keys + classification alongside makes the dashboard a pure DB read (no Jira calls per FR-008) and matches the established `last_seen_*` diff-cache pattern (Principle I: cache, never truth — release decisions still made on fresh fetch).

**Alternatives considered**: separate `ticket_blocks` relation table — normalized but overkill for a display cache re-derived every pass; jsonb array is atomic to swap and never queried row-wise.

## R4. Blocker classification (dead-end, out-of-scope) — two batched probes

**Decision**: Per release pass, over the distinct blocker keys of the (non-empty) waiting set:
1. **Blocker fetch**: one search `key in (<blockerKeys>)` with fields `status,resolution` (no project clause — cross-project blockers must resolve). Blocker with `resolution != null` and status category `!= done` ⇒ dependents get `blocked_state='dead_end'` (warning; e.g. closed as Won't Do into a non-done category).
2. **Scope probe**: one search `<workspace scope JQL> AND key in (<blockerKeys>)` (scrum: current sprint clause; kanban: project clause; plus `scope_jql` filter). Blockers absent from the result ⇒ dependents get `blocked_state='out_of_scope'` + one run-less human task (R5). Blockers present ⇒ ordinary `waiting`.

**Rationale**: The dependent's own `issuelinks` snapshot embeds only the blocker's status — not resolution, not sprint membership — so classification needs the blockers themselves, but never one-by-one: both probes are single batched searches, executed only when the waiting set is non-empty (Performance Goal: ≤2 extra Jira calls/pass). Scope probe reuses `buildScopeJql` clauses verbatim (the `since` clause is NOT included — membership, not recency).

**Alternatives considered**: treating any never-done blocker as dead-end after a time threshold — rejected: time-based heuristics misfire on legitimately slow tickets and are untestable deterministically.

## R5. Run-less human task for out-of-scope blockers

**Decision**: New `HumanTaskService.createTicketBlocked(workspaceId, ticketId, {title, details})`: inserts a `human_tasks` row with `run_id = NULL`, `kind='blocker'`, `blocking=false`; deduplicated by "an open task with `ticket_id = X AND run_id IS NULL` already exists" (one per ticket across passes, spec Story 4 scenario 4). No run parking (there is no run), no Jira transition, no comment — the ticket legitimately stays in its trigger status.

**Rationale**: `human_tasks.run_id` is already nullable (feature 011 made it so for setup runs) — schema untouched. The existing `createNonBlocking` requires a run row, so a sibling entry point is needed; dedup keyed on the ticket instead of the run mirrors the FR-020 pattern. When the human resolves/dismisses the task without changing the board, re-creation on a later pass is correct behavior (the condition genuinely persists) — resolution is expected to change the board (bring blocker into scope / break the link), which flips the classification and stops re-creation.

**Alternatives considered**: reusing `createNonBlocking` with a synthetic run — rejected, fabricating runs violates the run ledger's meaning; blocking=true — rejected, nothing is parked and the queue semantics of blocking tasks assume a run.

## R6. Sharing the release code without an import cycle: move `scope-jql.ts` to `libs/jira`

**Decision**: `DependencyReleaseService` lives in `libs/pipeline` (used by both `ReconcileService` and the fast path in `PipelineService`). It needs `POLL_FIELDS`/`buildScopeJql`, which live in `libs/ingest` — but ingest already imports pipeline (`poller → pipeline.onStatusChanged`), so pipeline importing ingest would be a cycle. Move `scope-jql.ts` file-wholesale (zero logic edits — the HWM `since` format comment is load-bearing) into `libs/jira/src/`, exported from `@brigadir/jira`; `libs/ingest` re-imports from there.

**Rationale**: `scope-jql.ts` depends only on `@brigadir/contracts` types and is conceptually Jira query-building — `libs/jira` is its natural home. Both pipeline and ingest already depend on `@brigadir/jira`.

**Alternatives considered**: (a) put the service in a new lib — package overhead for one service; (b) callback/DI-token indirection so ingest injects the JQL builder into pipeline — obscures a static dependency for no gain.

## R7. Fast path wiring (FR-003 SHOULD)

**Decision**: `DependencyReleaseService.releaseDependentsOf(workspaceId, blockerJiraKey)`: narrows the waiting-set query to tickets whose `blocked_by` array contains the key, then runs the same fetch→gate→order→trigger pass. Called from `PipelineService.onWorkerFinished` (worker success branch) **after** the `transitionTo(statusSuccess)` succeeds, wrapped in try/catch and logged non-fatally — a fast-path failure must never fail run finalization; the next reconcile pass is the guarantee (clarify decision: fast path is an optimization only).

**Rationale**: Reuses the exact release code (same ordering, same dedup) so both paths provably produce the same outcome (FR-003). Placing the call after the Jira transition means the blocker's done-status is already observable — the fresh fetch of dependents sees it in their issuelinks. jsonb containment (`blocked_by @> '["KEY"]'`) makes the narrowing a cheap indexless scan at this scale.

**Alternatives considered**: enqueueing a BullMQ job for the fast path — adds a queue for something the reconcile pass already guarantees; synchronous call with non-fatal guard is strictly simpler.

## R8. Dashboard surface

**Decision**: New paginated endpoint `GET /api/workspaces/:id/waiting` (contract in [contracts/dashboard-waiting.md](contracts/dashboard-waiting.md)): items from `tickets WHERE workspace_id=:id AND blocked_state IS NOT NULL`, `ORDER BY priority_id ASC NULLS LAST, jira_key ASC` (deterministic per pagination convention), envelope via `makePaginatedResponseSchema`. Web: new child route/tab "Waiting" on `WorkspacePage` (`apps/web/src/views/WorkspaceWaiting.vue`) using `<ListPagination>` + `usePagination` + TanStack query with `placeholderData: (prev) => prev`; `blocked_state` rendered as a tag (`waiting` neutral, `cycle`/`dead_end`/`out_of_scope` warning/danger via `--el-color-*` variables only), blocker keys listed per row. Cycle/dead-end/out-of-scope rows ARE the FR-009/FR-010 operator-visible warnings (plus existing structured logs).

**Rationale**: No tickets surface exists today (tickets appear only through runs), so a dedicated list is the smallest new surface satisfying FR-008's "no log access needed"; every list convention (pagination factory, deterministic ORDER BY, ListPagination, placeholderData) is mandated by CLAUDE.md and reused as-is.

**Alternatives considered**: pushing waiting rows into the Home "needs attention" list — that list is task/run-centric and would mix semantics; a per-run banner — there is no run to hang it on (that's the point of the feature).
