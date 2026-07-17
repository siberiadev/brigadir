# Quickstart: Validating the Agents Diagram View

**Feature**: 018-agents-diagram-view | **Date**: 2026-07-17

How to prove the feature works end-to-end. Interfaces and derivation rules referenced here live in [contracts/components.md](contracts/components.md) and [data-model.md](data-model.md).

## Prerequisites

- Node + pnpm per repo root; `pnpm install` run after the branch adds `@vue-flow/core` / `@dagrejs/dagre` to `apps/web`.
- For manual validation: the full stack (`docker compose up --build` or dev-mode per `docs/local-setup.md`) with a workspace bound to a real Jira board and a few worker agents configured.

## Automated validation (the gate)

```bash
pnpm typecheck && pnpm lint && pnpm test          # statics + all unit/component suites
pnpm --filter @brigadir/web test                  # web suite only, faster loop
```

Expected: the two new suites pass alongside the existing web tests —

- `test/agents-diagram-graph.spec.ts` — `buildGraph` semantics: orchestrator hidden; disabled hidden; success/failure/trigger edge derivation; convergent edges share one status node; JQL-only agent has no incoming edge + `jql` set; unreferenced statuses `muted`; stale references `missing`; `status_running` ignored; cycles/self-loops don't throw; deterministic ordering.
- `test/agents-diagram-view.spec.ts` — interactions (msw-faked API, VueFlow stubbed): default mode is List; toggling to Diagram issues **no** new `/api/agents` request (msw hit counter); status-node "+" opens the dialog with the trigger select pre-filled to that status; agent-node edit opens the edit dialog for that agent; successful save closes the dialog and the diagram re-derives.

No backend/integration suites are affected (`pnpm test:integration` unchanged — zero backend surface).

## Manual validation walk (maps to spec acceptance scenarios)

1. Open `/workspaces/:id/agents` → table renders, toggle shows **List** active (US1-1). Reload the page → still List (nothing persisted).
2. Switch to **Diagram** → graph appears laid out left-to-right; each worker agent shows: incoming edge from its trigger status, solid success-colored edge and dashed danger-colored edge out (US1-2). DevTools network tab: no new `/api/agents` or `/statuses` request fired by the toggle itself (SC-005).
3. Verify visibility rules against the roster: orchestrator absent; disable an agent in List mode → back in Diagram it's gone and any status only it referenced turns dimmed (US1-5, US3-3).
4. Find an agent with `trigger_jql` → JQL badge on its node; hover → tooltip with the JQL text (US1-6/7).
5. Rename a status in Jira (or point an agent at a nonexistent status) → the referenced-but-absent status renders as a "missing"-marked node, edge intact (edge case: stale reference).
6. Pan, zoom, drag a node aside → works; toggle to List and back → layout freshly computed, drag position gone (US1-10).
7. Click "+" on a status node → the existing New-agent dialog opens with Trigger status pre-selected to that status; submit an invalid config → same 422/lint presentation as list-mode; submit a valid one → dialog closes, new node + 3 edges appear with no reload (US2-1..3). Switch to List → the agent is in the table.
8. Click the edit button on an agent node → the standard Edit dialog for that agent; change its failure status → edge re-targets on save (US3-1/2).
9. OS-level "reduce motion" on → no non-essential animation in the diagram. Dark theme on → node/edge colors still read correctly (all colors are `--el-color-*` tokens).
10. Error state: stop the backend (or break the Jira credential so `/statuses` 502s) → Diagram mode shows an explicit error state, not a partial graph (US1-12).

## Success criteria spot-checks

- SC-002: with a warm cache, toggling to Diagram paints in well under 1 s (dagre over ≤35 nodes is sub-millisecond; the budget is component mount).
- SC-004: every create/edit made in either mode is visible in the other without reload — this is structural (shared query key + existing invalidation), confirmed by walk steps 7–8.
