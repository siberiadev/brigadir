# Contract — GET /api/workspaces/:id/waiting

Dashboard read endpoint (dashboard-token guard, like every `/api/*` dashboard route). Pure DB read — no Jira calls (FR-008: visibility without log access; data freshness = last release pass).

## Request

- Path: `GET /api/workspaces/:workspaceId/waiting`
- Query: standard pagination only — `page` (default 1), `page_size` (default 10, max 100), parsed via `parsePagination` (`dashboard.helpers.ts`).
- Errors: `404` unknown workspace; `401` bad/missing dashboard token.

## Response — paginated envelope (mandatory factory)

Schema built ONLY with `makePaginatedResponseSchema(WaitingTicketSchema)` from `packages/contracts/src/pagination.schema.ts`. Deterministic order: `ORDER BY priority_id ASC NULLS LAST, jira_key ASC`.

```jsonc
{
  "items": [
    {
      "ticket_id": "uuid",
      "jira_key": "BRIG-42",
      "summary": "Implement the flux capacitor",
      "priority_id": 2,              // int | null
      "priority_name": "High",       // string | null
      "blocked_by": ["BRIG-40", "BRIG-41"],   // non-empty array of issue keys
      "blocked_state": "waiting"     // "waiting" | "cycle" | "dead_end" | "out_of_scope"
    }
  ],
  "page": 1,
  "page_size": 10,
  "total": 3
}
```

`WaitingTicketSchema` (zod, packages/contracts — dashboard workspace schemas):

```ts
const BlockedState = z.enum(['waiting', 'cycle', 'dead_end', 'out_of_scope']);
const WaitingTicketSchema = z.object({
  ticket_id: z.string().uuid(),
  jira_key: z.string(),
  summary: z.string().nullable(),
  priority_id: z.number().int().nullable(),
  priority_name: z.string().nullable(),
  blocked_by: z.array(z.string()).min(1),
  blocked_state: BlockedState,
});
```

## Semantics

- Row set: `tickets WHERE workspace_id = :id AND blocked_state IS NOT NULL`. A released or de-triggered ticket disappears from the list on the pass that cleared its state (spec Story 3 scenario 2).
- `blocked_state` meanings (UI renders as tags; brand colors only via `--el-color-*`):
  - `waiting` — ordinary gate wait (info tag);
  - `cycle` — member of a blocked-by cycle among trigger-status tickets (danger tag; FR-009 warning);
  - `dead_end` — some blocker is resolved into a non-done status category (warning tag; FR-010 warning);
  - `out_of_scope` — some blocker is outside the observed board scope; a run-less human task exists for this ticket (warning tag; FR-010 human-task case).

## Web consumer

`apps/web`: `useWaitingTickets(workspaceId, page, pageSize)` — TanStack query with `placeholderData: (prev) => prev`; rendered in `WorkspaceWaiting.vue` (new `waiting` child route of `/workspaces/:id`) with the shared `<ListPagination>` + `usePagination` pair (visibility rule: hidden when `total ≤ 10`).
