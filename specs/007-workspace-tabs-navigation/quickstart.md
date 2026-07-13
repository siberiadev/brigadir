# Quickstart & Validation: Workspace Tabs Navigation

Frontend-only feature in `apps/web`. Validate with the automated component tests (primary)
and a quick manual click-through (secondary). No backend/DB setup required.

## Prerequisites

- Repo bootstrapped: `pnpm install` at the root.
- Node ≥22, pnpm.

## Automated validation (primary)

Run the web unit/component suite:

```bash
pnpm --filter @brigadir/web test        # vitest run
pnpm --filter @brigadir/web typecheck   # vue-tsc --noEmit (TS strict must stay green)
pnpm --filter @brigadir/web lint 2>/dev/null || pnpm lint   # if a web lint script exists
```

Expected: existing specs stay green (the `mount.ts` change is backward compatible) and the new
`test/workspace-tabs.spec.ts` passes. That spec covers every acceptance scenario:

| Scenario (spec) | Test assertion |
|-----------------|----------------|
| US1 #2/#3 — tab switch swaps body, no reload (FR-007) | Mount the real router at `/workspaces/ws-1/agents`; assert `agents-table` present; click `workspace-tab-runs`; assert `runs-table`/`runs-empty` present and `agents-table` gone; route name is `runs`. Click back to Agents; assert `agents-table` returns. |
| US1 #4 / FR-008 — URL reflects tab | After each switch, assert `router.currentRoute.name` is `agents`/`runs` and path matches. |
| US2 #1 — deep-link runs (FR-009) | Push `/workspaces/ws-1/runs`; assert Runs body renders and active tab = Runs. |
| US2 #2 — deep-link agents (FR-009) | Push `/workspaces/ws-1/agents`; assert Agents body renders and active tab = Agents. |
| US2 #3 / FR-010 — back returns to prior tab | Switch agents→runs, `router.back()`, assert route name back to `agents`. |
| US1 #1 / US3 — row click navigates (FR-003) | Mount `WorkspaceList` with the real router; `trigger('click')` on a `workspaces-table` row (`.el-table__row`); assert route becomes `/workspaces/<id>/agents`. |
| FR-004 — action controls don't navigate | Click `toggle-pause-<id>` (and Settings); assert route did **not** change to the workspace page. |
| FR-001 — buttons removed | Assert no Agents/Runs button text/links in `WorkspaceList` rows. |
| FR-012 — unknown-tab fallback | Resolve/push `/workspaces/ws-1/bogus`; assert it lands on `agents`. |
| FR-009 guard — settings still resolves | `router.resolve('/workspaces/ws-1/settings').name === 'workspace-settings'` (not swallowed by the unknown-tab redirect). |

The API boundary stays faked by the existing 006 msw handlers (`/api/agents?workspace=`,
`/api/workspaces/:id/runs`, `/api/workspaces/:id/runs/cost`, `/api/workspaces`). No handler
changes required unless a scenario needs a second workspace row (extend `handlers.ts` if so).

### Test harness note

`test/mount.ts` gains optional `routes` + `initialPath`. Navigation tests build the router
from the app's real workspace routes (import from `src/router` or construct the equivalent
subset), `await router.isReady()`, then mount. Existing specs that pass no `routes` keep the
current catch-all stub router — no changes needed to them.

## Manual validation (secondary)

```bash
pnpm --filter @brigadir/web dev     # vite dev server
```

1. Enter the dashboard token; land on **Workspaces**.
2. Confirm each row shows **Settings** and **Start/Pause** only — **no** Agents/Runs buttons
   (FR-001); the row shows a pointer cursor.
3. Click a workspace **row** → the workspace page opens on the **Agents** tab; the agents list
   renders (FR-003, FR-006).
4. Click the **Runs** tab → the runs list replaces the agents list, the URL becomes
   `/workspaces/<id>/runs`, and the page/nav does not fully reload (FR-007, FR-008).
5. Browser **Back** → returns to the Agents tab (FR-010).
6. Paste `/workspaces/<id>/runs` into the address bar → opens with the Runs tab active
   (FR-009); do the same for `/agents`.
7. Visit `/workspaces/<id>/anything-else` → lands on the Agents tab (FR-012).
8. Back on the list, click **Start/Pause** and **Settings** → each performs only its own action
   (pause toggles; Settings opens its dialog) and does **not** navigate into the workspace
   (FR-004).

## Out of scope (do not validate here)

- Icon sidebar (iteration 8).
- Converting Settings to a standalone page / FormDialog race fix (separate task).
- Any new data on the tabs — bodies are the existing lists, unchanged (FR-011).
