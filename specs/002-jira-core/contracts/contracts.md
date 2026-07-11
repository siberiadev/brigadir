# Contracts — Jira Core (iteration 2)

Interface boundaries introduced this iteration. Signatures are the stable
contract; bodies land in implementation. All new shared types live in
`packages/contracts` (framework-free).

## C1 — `JiraClient` (libs/jira)

The single typed surface for Jira; `BasicAuthJiraClient` implements it (an
`OAuthJiraClient` may be added in a later phase). Reads bypass the per-issue
write queue; mutations go through it.

```ts
export interface JiraClient {
  // --- reads (rate-limited, not serialized per issue) ---
  searchUpdated(jql: string, fields: string[]): Promise<JiraIssue[]>;   // nextPageToken loop
  getBoard(boardId: number): Promise<{ type: 'kanban' | 'scrum'; projectKey: string }>;
  getActiveSprintId(boardId: number): Promise<number | null>;          // openSprints() head, null if none
  getTransitions(issueKey: string): Promise<JiraTransition[]>;

  // --- mutations (serialized per issue key, rate-limited) ---
  transitionTo(issueKey: string, targetStatusName: string): Promise<void>; // discovery+cache+409; NoTransitionPath
  addComment(issueKey: string, body: ADFDoc): Promise<void>;
}
```

- `transitionTo`: if the issue is already in `targetStatusName`, no-op
  (FR-023). On POST 409: invalidate cache key, re-discover, retry once; no
  matching transition → throw `NoTransitionPath`.
- 429 handling (all calls): honor `Retry-After`; never counts as a run failure.

## C2 — Jira value types (packages/contracts)

```ts
export interface JiraIssue {
  key: string; id: string;
  fields: {
    summary: string | null;
    status: JiraStatus;
    updated: string;                 // ISO
    issuelinks?: JiraIssueLink[];
  };
}
export interface JiraStatus { name: string; statusCategory: { key: 'new' | 'indeterminate' | 'done' } }
export interface JiraIssueLink {
  type: { name: string; inward: string; outward: string };   // e.g. name "Blocks", inward "is blocked by"
  inwardIssue?: { key: string; fields: { status: JiraStatus } };
  outwardIssue?: { key: string; fields: { status: JiraStatus } };
}
export interface JiraTransition { id: string; to: { name: string } }
export type ADFDoc = { version: 1; type: 'doc'; content: unknown[] };
```

## C3 — ADF composer (libs/jira, pure)

```ts
export function buildRunComment(report: AgentReport): ADFDoc;
```

- `panel` (`info` for `success`, `error` otherwise) + summary paragraph +
  `taskList` of checks (`pass/fail/warn/skip` glyph + optional reason).
- Pure & deterministic → snapshot-tested for all three outcomes.

## C4 — Rate limiter + per-issue write queue (libs/jira, internal)

```ts
class RateLimiter { schedule<T>(fn: () => Promise<T>): Promise<T>; } // token bucket + concurrency cap; 429/Retry-After
class PerIssueWriteQueue { run<T>(issueKey: string, fn: () => Promise<T>): Promise<T>; } // p-queue map, concurrency 1/key
```

Composition per mutation: `perIssue.run(key, () => rateLimiter.schedule(() => fetch(...)))`.

## C5 — `JiraModule` DI (libs/jira)

```ts
JiraModule.forRootAsync({
  imports: [DatabaseModule],
  useFactory: async (db: BrigadirDb): Promise<JiraClientConfig> => {
    const ws = await loadWorkspace(db);              // site URL, project key, decrypted token
    return { baseUrl: ws.jiraSiteUrl, auth: basic(ws.email, ws.token), maxRps: 5, concurrency: 8 };
  },
  inject: [DRIZZLE],
})
```

**Constitution lazy-resolution**: nothing here executes at import; the client
is built at context-init from the workspace row (no env read, no localhost
fallback). Composition-time reads are limited to static structure.

## C6 — `PipelineService` (libs/pipeline)

```ts
class PipelineService {
  // ingest & webhook converge here; idempotent by construction
  onStatusChanged(input: {
    ticketId: string; issue: JiraIssue;
    fromStatus: string | null; toStatus: string; source: 'poller' | 'webhook' | 'scope_entry';
  }): Promise<void>;

  // called by RunProcessor AFTER the result is persisted (persist-then-write)
  onRunFinished(runId: string): Promise<void>;
}

export function evaluateDependencyGate(issue: JiraIssue): 'clear' | 'blocked';
```

- `onStatusChanged`: match enabled agents by `trigger_status`, apply
  `evaluateDependencyGate`, trigger clear ones via `RunTriggerService` (three
  dedup layers).
- `onRunFinished`: read persisted run+report+agent → `transitionTo(success|failure)`
  + `addComment(buildRunComment)` → write `run_events(type='jira_action')`
  marker. All writes via `JiraClient` (Principle III).

## C7 — `ReconcileService` (libs/ingest)

```ts
class ReconcileService {
  run(): Promise<void>;   // one pass: 4 ordered steps, each try/caught, shared Jira budget
}
```

Ordered steps (D7): `pollAndDiff()` → `reEvaluateDependencies()` →
`watchdog()` → `repairDrift()`.

- `pollAndDiff`: board-type scope JQL + `scope_jql` + HWM; `nextPageToken`
  loop; upsert tickets; diff `last_seen_status` → `onStatusChanged`
  (scope-entry when `last_seen_status` absent); sprint-switch rescan (D9);
  advance+persist HWM.
- `reEvaluateDependencies`: tickets in a `trigger_status` with no
  active/succeeded run for that agent → re-check gate → trigger if clear.
- `watchdog`: `running` past `timeout+grace` → finalize + failure-outcome
  treatment.
- `repairDrift`: terminal runs missing the `jira_action` marker → re-apply the
  pending Jira write (idempotent). **Never re-drives a run** (D8).

The worker `ReconcileProcessor.process()` delegates to `ReconcileService.run()`.

## C8 — Mock Jira test helper (test/integration/mock-jira.ts)

```ts
interface MockJira {
  server: SetupServerApi;                       // msw
  // drive state:
  seedIssue(key: string, opts: { status: string; category?: StatusCat; sprintId?: number; updated?: string }): void;
  setStatus(key: string, status: string): void;
  addBlockedByLink(key: string, blockerKey: string): void;
  moveBlocker(blockerKey: string, status: string, category: StatusCat): void;
  startSprint(boardId: number, sprintId: number, issueKeys: string[]): void;
  // arm behaviors:
  arm409OnNextTransition(key: string): void;
  arm429(retryAfterSeconds: number): void;
  // assert:
  commentsFor(key: string): ADFDoc[];
  transitionsFor(key: string): string[];        // target status names applied, in order
}
export function mockJira(config?: { boardId: number; boardType: 'kanban' | 'scrum'; projectKey: string }): MockJira;
```

Reproduces (D11): `/search/jql` pagination (`nextPageToken`, echoes requested
`fields`), Agile `board/{id}` + active sprint, `/transitions` GET+POST (409 on
cue), 429+`Retry-After` on cue, ADF comment capture, `issuelinks`. Backed by an
in-memory store; Postgres/Redis remain real via global-setup.
