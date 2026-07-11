# Research — Jira Core (iteration 2)

Mechanics behind the plan. Architectural choices were fixed by the invoking
instruction; this file records the resolution of the remaining design
questions and the ground-truth Jira facts (from `docs/research.md` §5) that
constrain them. **No NEEDS CLARIFICATION remain.**

## D1 — Jira client: native fetch, no SDK

- **Decision**: hand-written `BasicAuthJiraClient` over Node 22 global `fetch`,
  behind a `JiraClient` interface. Covers REST v3 (`/search/jql`,
  `/issue/{key}/transitions`, `/issue/{key}/comment`) and Agile 1.0
  (`/rest/agile/1.0/board/{id}`, `/board/{id}/sprint?state=active`).
- **Rationale**: precise control over rate-limit headers, `Retry-After`, and
  the exact request shape the msw mock must reproduce; no SDK abstraction to
  fight when serializing per-issue writes. Basic auth = `Authorization: Basic
  base64(email:api_token)`.
- **Alternatives**: `jira.js` / Atlassian SDK — rejected (opaque retry/rate
  handling, harder to intercept deterministically in tests).

## D2 — Credential resolution (Constitution lazy-resolution)

- **Decision**: `JiraModule.forRootAsync` with a `useFactory` that reads the
  `workspaces` row (site URL, project key, decrypted `jira_credentials`) at
  Nest context-init and constructs the client. No `JiraClient` is built inside
  a `@Module()` decorator argument; no env is read at import; no localhost
  fallback.
- **Rationale**: this is the exact failure mode the constitution's lazy-resource
  rule encodes (iteration-1 eager Redis connect). A per-workspace client is
  resolved from the DB, not from ambient env.
- **Note**: credential decryption (AES-256-GCM) is specced for iteration 2+;
  this iteration reads the stored bytes through the same accessor so the seam
  exists. Live smoke supplies a real token via the seeded workspace.

## D3 — Rate limiter beneath the write queue

- **Decision**: a token bucket (`JIRA_MAX_RPS`, default 5) **plus** a global
  concurrency cap (default 8) live in the client layer, *beneath* the per-issue
  write queue. Order per mutating call: acquire issue-queue slot → acquire
  concurrency slot → await token → fetch. On 429: read `Retry-After` (seconds
  or HTTP-date), sleep ≥ that, retry; absent → expo backoff + jitter capped 5
  min; log `RateLimit-Reason`.
- **Rationale**: serialization guarantees per-issue ordering; the token bucket
  smooths global RPS; both are needed (per-issue 20/2s and global pools are
  independent Jira limits, `docs/research.md` §5).
- **Ground truth**: per-issue write budget 20/2s + 100/30s; 429 carries
  `Retry-After` + `RateLimit-Reason ∈ {quota-global-based, burst-based,
  per-issue-on-write}`.

## D4 — Per-issue write serialization

- **Decision**: a `Map<issueKey, PQueue({concurrency:1})>` in the client;
  every mutation (`transitionTo`, `comment`, future `setProperty`) runs inside
  the issue's queue. Reads (search, transitions discovery GET, board/sprint)
  bypass it. A small idle-eviction keeps the map from growing unbounded.
- **Rationale**: single-writer-per-workspace assumption (spec §0.2) makes
  in-process serialization sufficient; BullMQ OSS has no per-key groups.
- **Alternatives**: Redis lock per issue — rejected (unnecessary for one
  writer; adds durable state Redis must not hold).

## D5 — Transition discovery + cache + 409

- **Decision**: `transitionTo(issueKey, targetStatusName)` → GET
  `/issue/{key}/transitions` → match `to.name` case-insensitively → POST the
  id. Cache the discovered map keyed `project|issuetype|fromStatus` with a
  10-min TTL. On POST 409: invalidate that key, re-discover, retry **once**;
  still failing or no matching transition → throw `NoTransitionPath(ticket,
  fromStatus, target)`. If the issue is already in `targetStatusName`, treat as
  satisfied (no POST) — FR-023 idempotency.
- **Rationale**: transition ids are workflow- and state-specific and race under
  concurrent moves (`docs/research.md` §5). The cache key includes `fromStatus`
  because valid transitions depend on the originating status.

## D6 — ADF composer (pure, snapshot-tested)

- **Decision**: `buildRunComment(report: AgentReport): ADFDoc` — a pure
  function returning an ADF document: a `panel` (`info` for success, `error`
  for failure/needs_human) + a `paragraph` summary + a `taskList` of
  `taskItem`s, one per check (`✅ pass / ❌ fail / ⚠ warn / ⏭ skip` + reason).
  Dashboard run link is a TODO placeholder (Phase 1). ADF types live in
  `packages/contracts`.
- **Rationale**: pure function = deterministic snapshot tests; ADF is the only
  comment format in v3 and natively supports `taskList`/`panel`.

## D7 — Reconcile job structure (4 ordered steps, one budget)

- **Decision**: `ReconcileService.run()` executes, in order, each wrapped in
  its own try/catch (a failing step logs + continues, never starves the rest):
  1. **poll & diff** — build scope JQL by board type (kanban: `project AND
     scope_jql AND updated >= HWM-60s`; scrum: additionally `AND sprint IN
     openSprints()`), page `nextPageToken`, upsert tickets, diff
     `last_seen_status` → `onStatusChanged`; handle sprint-switch (D9) and
     scope-entry (absent `last_seen_status`); advance + persist HWM.
  2. **dependency re-eval** — for tickets currently sitting in some agent's
     `trigger_status` with no active/succeeded run for that agent, re-check the
     dependency gate (D10) and trigger if now clear.
  3. **watchdog** — runs `running` past `timeout_minutes + grace` → finalize
     `timed_out`/`failed` with diagnostics + failure-outcome Jira treatment.
  4. **drift repair** — re-apply pending Jira writes for already-persisted
     results (D8); never re-drive a run.
- **Rationale**: mirrors architecture §4's sweeper duties plus the two the spec
  adds; one shared pass-level Jira budget prevents a heavy poll from starving
  the write steps. Idempotent per step so repeated passes are safe.

## D8 — Drift-repair policy (pins spec "per policy") + pending-write marker

- **Decision**: runs are **non-idempotent** — a run whose queue job/process
  vanished is finalized **`failed`** with diagnostics + failure-outcome
  treatment, **never re-driven** automatically (retry is a human/`retry`
  action). The only thing drift repair re-applies is a **pending Jira write**
  for an already-persisted terminal result, which is idempotent (D5/FR-023).
- **Marker**: `onRunFinished` records a `run_events(type='jira_action')` row
  after the transition+comment land. Drift repair finds terminal runs
  (`succeeded`/`failed`) lacking that marker and re-applies. No schema change
  (architecture §5 already defines `jira_action` events).
- **Rationale**: persist-then-write (FR-022) means a crash between the two
  leaves a terminal run with no `jira_action` marker → deterministically
  repairable; re-driving a non-idempotent run could double-mutate a repo.

## D9 — Sprint-switch full rescan

- **Decision**: persist `active_sprint_id` in `workspaces.settings`. Each poll
  reads current `openSprints()`; if the active sprint id changed, run a one-off
  full rescan of the new sprint's issues **without** the `updated >= HWM`
  clause (still applying `scope_jql`), process diffs/scope-entries, then resume
  normal HWM polling. No active sprint → step is an idle no-op.
- **Rationale**: a sprint start does not touch issues' `updated`, so an
  update-bounded query would never surface them (FR-032). Scope entry for a
  ticket already in a trigger status is a trigger (FR-031).

## D10 — Dependency gate

- **Decision**: a ticket is **gated** if it has ≥1 inward "is blocked by" issue
  link whose linked issue's `status.statusCategory.key !== 'done'`. Only inward
  "is blocked by" links gate (not outward "blocks", not "relates to"). Poller
  `fields` include `issuelinks` and `status`; the linked issue's status
  category comes from the `issuelinks[].inwardIssue.fields.status` the search
  returns. `PipelineService.onStatusChanged` and the reconcile dep-re-eval step
  both call the same `evaluateDependencyGate(issue)` and skip the trigger when
  gated (logged with the blocking key).
- **Rationale**: resolving a blocker changes only the *blocker's* `updated`, so
  the blocked ticket is re-evaluated by step 2 independently of the HWM floor
  (FR-036). Routing the eventual trigger through `RunTriggerService` keeps the
  three dedup layers, so it fires exactly once.

## D11 — Mock Jira (msw over fetch)

- **Decision**: one configurable `mockJira()` helper in `test/integration/`
  built on `msw`'s node interceptors. Reproduces: `/search/jql` with
  `nextPageToken` pagination + explicit `fields` echoing; Agile `board/{id}`
  and active-sprint endpoints; `/issue/{key}/transitions` (GET list, POST with
  configurable **409-on-cue**); `429 + Retry-After` on cue; ADF **comment
  capture** (assertable); `issuelinks` on issues (for the gate). Backed by an
  in-memory issue store the test drives (set status, add link, move blocker,
  start sprint). Postgres/Redis stay real via the existing global-setup.
- **Rationale**: msw intercepts `fetch` without touching client code; a single
  stateful helper keeps each spec declarative. No real Jira in automated tests.
- **Alternatives**: `nock` — works, but msw's fetch interception matches our
  transport more directly and is already common for node fetch.

## D12 — Config forward-compatibility

- **Decision**: extend `WorkspaceConfigSchema`: add `board_id` (int, required
  going forward), `scope_jql` (optional string), `branch_prefix` (optional
  string), `repositories` (optional array of `{name, url, default_branch}`).
  Keep `repo`/`default_branch` as optional-deprecated so the committed
  `agents.yaml` still validates. `board_id` + `scope_jql` are consumed now;
  `branch_prefix`/`repositories[]` are validated-but-unused until iteration 3.
  The seeder writes `jira_board_id`/`jira_board_type` (after board
  introspection, D2/D1) and `scope_jql` into `workspaces.settings`.
- **Rationale**: FR-027/FR-039 — the full documented §0.1 example must pass
  fail-fast startup validation rather than be rejected as unknown keys, while
  unused keys stay inert until their executor lands.

## Flagged deviations from architecture docs (per plan constraint)

- **F2 CLOSED**: `onRunFinished` now performs the Jira half (transition +
  ADF comment) for every outcome — the seam iteration 1 left open.
- **F3 CLOSED**: reconcile becomes the real four-step job; the no-op stub is
  replaced.
- **Reconcile = 4 steps vs §4's 3 duties**: dependency re-eval + watchdog added;
  webhook-refresh (3rd duty) is 3LO-only → out of scope. Elaboration, not
  conflict (Complexity Tracking row 1).
- **Pending-write marker = `run_events(type='jira_action')`**: uses an existing
  event type rather than a new column (Complexity Tracking row 2).
- **`WorkspaceConfigSchema` keeps `repo` optional** alongside new
  `repositories[]` for seed back-compat (Complexity Tracking row 3).
- No schema deviation beyond the two approved board columns; `docs/architecture.md`
  §3 is updated in the same change (governance) and re-reviewed in
  `drizzle/REVIEW-0001_jira_board.md`.
