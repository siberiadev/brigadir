# Contract — Multi-workspace reconcile pass (US5)

Not an HTTP contract — the internal contract of the worker reconcile pass after it stops
being single-workspace. Governs `ReconcileService` and the step services it drives.

## Before (single workspace)
`ReconcileService.run()` selects `workspaces LIMIT 1`, resolves board type, and runs four
steps against the **global** `JIRA_CLIENT` (which itself resolves `workspaces LIMIT 1`).

## After (all enabled workspaces, per-workspace client) — FR-026, FR-027, FR-028, FR-029

```
run():
  workspaces = SELECT id, projectKey, boardId, boardType
               FROM workspaces
               WHERE settings->>'enabled' IS DISTINCT FROM 'false'    # R3: absent ⇒ enabled
  if workspaces is empty: log "nothing to do"; return
  for ws in workspaces:                        # FR-026: every enabled workspace, per pass
    try:                                        # FR-029: per-workspace isolation
      jira = jiraClientFactory.forWorkspace(ws.id)   # FR-027: per-workspace client (005 R6)
      boardType = ensureBoardType(ws, jira)          # introspect+persist if null; skip pass on failure
      if boardType is null: continue                 # introspection failed → skip this ws only
      ctx = { id, projectKey, boardId, boardType }
      step('poll & diff',        () => poller.pollAndDiff(ctx, jira))
      step('dependency re-eval', () => reEvaluateDependencies(ctx, jira))
      step('watchdog',           () => watchdog.sweep(ctx))
      step('drift repair',       () => drift.repair(ctx, jira))
    catch err:
      log(`workspace ${ws.id}: reconcile pass failed (others continue): ${err}`)
      continue
```

### Isolation guarantees
- **FR-028**: a workspace with `settings.enabled === false` is not selected → skipped
  entirely (no poll, no watchdog, no drift).
- **FR-029**: two isolation layers — a **per-workspace** try/catch (client resolution,
  board introspection, or any step throwing for that workspace is logged and that workspace
  is skipped for the pass) and the existing **per-step** try/catch within a workspace. A
  Jira outage or credential-decode failure in workspace A never prevents workspace B's pass
  from completing.
- **Per-workspace state** is already keyed by `ws.id`: `getReconcileState` /
  `setReconcileState` (high-water mark, active sprint), `getScopeJql`. Unchanged.

### Signature changes (thread the client, drop the global inject)
- `PollerService.pollAndDiff(ws)` → `pollAndDiff(ws, jira)`; drop `@Inject(JIRA_CLIENT)`.
- `ReconcileService.reEvaluateDependencies(ws)` → `(ws, jira)`; drop the injected client.
- `DriftRepairService.repair(ws)` → `repair(ws, jira)` (only if it makes Jira calls; keep
  as-is otherwise).
- `WatchdogService.sweep(ws)` — unchanged if it performs no Jira calls (DB-only sweep).
- `ensureBoardType` takes the per-workspace `jira` for introspection.

### Provisioning (constitution tech-constraint — lazy resolution)
`JiraClientFactory` must be exported from the worker-side `JiraModule` provider set and
injected into `ReconcileService`. It resolves credentials **lazily** inside `forWorkspace`
(a DI method call at pass time), never at module composition — compliant, and it is the
same fingerprint-cached factory the dashboard uses (rotation-safe, 005 R6).

## Workspace pause toggle (FR-030)
Exposed in workspace settings (feature 005 settings endpoint) as `settings.enabled`. Toggling
it changes which workspaces the **next** pass selects. No separate endpoint — it rides the
existing `PUT /api/workspaces/:id/settings`.

## Tests (Principle VI — pipeline logic, testcontainers + mock-jira, no broker mocks)
- Two enabled + one disabled → one pass polls both enabled, skips the disabled (FR-028).
- Two enabled where A's Jira fails → B's pass still completes (FR-029).
- Each enabled workspace gets its own board scope / HWM / dependency re-eval / watchdog /
  drift within one pass (FR-026).
- Per-workspace client: a call for workspace B uses B's site/credentials, not A's (FR-027).
