# Contract: `ticket_scoping` workspace flag (D2b)

Precedent followed throughout: the feature-006 `enabled` pause flag (jsonb value, absent ⇒
default, additive request/response fields, Settings-tab toggle).

## 1. Settings blob (`packages/contracts/src/jira.types.ts` → `WorkspaceSettingsSchema`)

```
ticket_scoping: z.boolean().optional()
// ABSENT ⇒ OFF. jsonb value only — no DDL (CLAUDE.md rule 5 untouched).
```

Read path: the executor reads it from the same `workspaces.settings` row it already loads
during repository resolution (`resolveRepositories`, `claude-cli.executor.ts:703`) — one
read path, at run time (lazy-resolution rule). Optional convenience accessor
`getTicketScoping()` in `libs/database/src/workspace-settings.ts` for backend/tests.

## 2. Dashboard API (`packages/contracts/src/dashboard.schema.ts`)

```
PUT /api/workspaces/:id/settings   (WorkspaceSettingsRequestSchema, .strict())
  + ticket_scoping?: boolean       // absent ⇒ unchanged (merge-patch semantics as today)

WorkspaceResponseSchema
  + ticket_scoping: boolean        // absent settings key serialized as false
```

Backend: workspaces settings controller/service pass the field through
`patchWorkspaceSettings` (existing validated merge-write); response mapper adds the
serialized boolean. Both additive — existing clients unaffected.

## 3. Dashboard UI (`apps/web`)

Workspace Settings tab gains a toggle "Ticket repository scoping (Jira Components)"
alongside the existing enable/pause switch, seeded from `WorkspaceResponse.ticket_scoping`,
saved via the settings PUT. Standard Element Plus switch; brand colors via `--el-color-*`
only; no custom pagination/animation concerns.

## 4. Behavioral contract

- OFF (absent/false): byte-identical legacy behavior — components are not consulted
  anywhere in run dispatch (spec FR-005, SC-003).
- ON: activates narrowing + the fail-closed gate for normal claude_cli runs in that
  workspace only (spec Story 3, scenario 3 — per-workspace isolation).
- Flipping the flag affects only runs dispatched AFTER the change (read per run at
  resolution; running/parked runs unaffected).
