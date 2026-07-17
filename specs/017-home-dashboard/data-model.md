# Data Model — Feature 017: Home Dashboard

**No database schema changes** (FR-029; confirmed viable in research.md R5). Everything below is a **read model**: new response shapes computed from existing tables (`runs`, `workspaces`, `agents`, `tickets`, `human_tasks` — see `docs/architecture.md` §3, implemented as-is in `libs/database/src/schema/`).

All wire shapes live in `packages/contracts/src/home.schema.ts` (new) — zod, `.strict()`, snake_case, types via `z.infer`. Reused vocabularies: `RunStatusSchema`, `RunCostPeriodSchema` (`runs.schema.ts`), `HumanQueueItemSchema` (`human-queue.schema.ts`, unchanged).

## 1. HomeSummary (GET /api/home/summary)

One atomic snapshot for the stat tiles + spend block.

| Field | Type | Source |
|---|---|---|
| `running` | int ≥ 0 | `COUNT(runs) WHERE status='running'` |
| `queued` | int ≥ 0 | `COUNT(runs) WHERE status='queued'` |
| `attention_24h.failed` | int ≥ 0 | `COUNT(runs) WHERE status='failed' AND finished_at >= now()-24h` |
| `attention_24h.timed_out` | int ≥ 0 | same, `status='timed_out'` |
| `human_open` | int ≥ 0 | `COUNT(human_tasks) WHERE status='open'` (same predicate as existing `/api/human-tasks/count`) |
| `spend` | record keyed `'24h'\|'7d'\|'30d'` | per period: `total_cost_usd` string (numeric round-trip, `COALESCE(SUM(cost_usd),0)`), `run_count` int — `FILTER (WHERE created_at >= now()-P)` |

Invariants: tile "failed last 24h" = `attention_24h.failed + attention_24h.timed_out`; `spend` windows on **`created_at`** (must equal Σ of the per-workspace cost endpoint per SC-004); failure windows on **`finished_at`**. All counters cross-workspace, no filters.

## 2. GlobalRunListItem / GlobalRunsResponse (GET /api/runs)

Cross-workspace run row = existing `RunListItem` projection + workspace + finish time.

| Field | Type | Notes |
|---|---|---|
| `run_id` | uuid | |
| `status` | RunStatus | existing 8-value enum |
| `attempt` | int | |
| `agent` | `{ id, name, key, role\|null }` | INNER JOIN agents (as in workspace-scoped list) |
| `ticket` | `{ key, summary\|null, deep_link }` \| null | LEFT JOIN tickets — null for ticketless setup runs; `deep_link` built from the run's workspace `jira_site_url` |
| `workspace` | `{ id, name }` | INNER JOIN workspaces — the new dimension |
| `started_at` | ISO \| null | ticker anchor |
| `finished_at` | ISO \| null | needs-attention display (new vs. RunListItem) |
| `duration_ms` | int \| null | `finished−started`, as existing helper |
| `cost_usd` | string \| null | |
| `created_at` | ISO | queued-age display |

Response envelope: `{ items: GlobalRunListItem[], total: int }` — **not** paginated (`total` = full count matching the filter; powers "view all (N)").

Query contract (`GlobalRunsQuerySchema`): `status` REQUIRED non-empty CSV ⊆ RunStatus (422 otherwise); `finished_within` optional ∈ `24h|7d|30d`; `limit` optional int, default 10, clamp 1..50. Ordering fixed (see contracts/runs-global-api.md): running (oldest `started_at` first) → queued (oldest `created_at` first) → terminal (newest `finished_at` first), tie-break `id`.

## 3. HomeWorkspaceItem / HomeWorkspacesResponse (GET /api/home/workspaces)

Workspace card = light workspace projection + three aggregates.

| Field | Type | Source |
|---|---|---|
| `id`, `name` | | `workspaces` |
| `project_key` | string | `jira_project_key` (card's board chip, per mock) |
| `board_type` | string \| null | |
| `enabled` | boolean | `settings.enabled !== false` (jsonb; NO column — paused = `false`) |
| `agent_count` | int ≥ 0 | `COUNT(agents) GROUP BY workspace_id` |
| `last_run` | `{ run_id, status, started_at\|null, finished_at\|null, created_at }` \| null | `DISTINCT ON (workspace_id) … ORDER BY workspace_id, created_at DESC` (uses `runs_workspace_created` index); null = "no runs yet" |
| `attention_24h` | int ≥ 0 | failed+timed_out with `finished_at >= now()-24h`, `GROUP BY workspace_id` |

Response: `{ items: HomeWorkspaceItem[] }` — all workspaces, ordered `created_at ASC` (matches existing list), no pagination. Built from ≤4 batched queries merged in memory — **no per-workspace fan-out** (FR-020).

## 4. Reused as-is (no changes)

- **HumanQueueItem** — hero rows: `title`, `kind`, `ticket {key, jira_url}|null`, `agent|null`, `workspace {id,name}`, `run_id|null`, `created_at` (waiting age). Hero count = the list response's `total` (single source within the block).
- **RunCostResponse** — per-workspace cost endpoint untouched; Home's spend comes from HomeSummary.

## 5. Client-side view state (no persistence)

- Spend period selector: local `ref<RunCostPeriod>('24h')` — flips between the three preloaded figures, no refetch.
- Live ticker: `useNow()` (1 s) + `max(0, now − started_at)`; server data unchanged between polls.
- Query cache keys: `['home','summary']`, `['runs','global',{status,finished_within,limit}]`, `['home','workspaces']`, existing `['human-tasks','open',...]`.
