# Contract: Brigadir Agent Settings API

**Feature**: 015-brigadir-agent-repo-setup

Dashboard-token-guarded (same `DashboardTokenGuard` as all `/api/*` dashboard endpoints). Error envelope, `validationError` shape, and `zodIssuePath` conventions identical to existing dashboard controllers.

## GET /api/brigadir-agent-settings

Returns the effective settings — stored values with built-in defaults substituted per-key when unset (fields are never empty):

```jsonc
// 200 OK
{
  "template": {
    "schema_version": 1,
    "name": "brigadir",
    "role": "teamlead",
    "timeout_minutes": 45,
    "max_budget_usd": null,
    "max_attempts": 2,
    "enabled": true,
    "triage": {
      "executor": "brigadir-orchestrator",
      "behavior": { "workspace_mode": "none" }
    },
    "setup": {
      "executor": "brigadir-setup",
      "behavior": {},
      "timeout_minutes": 60
    }
  },
  "routing_instruction": "You are \"brigadir\"...",        // legacy key default_orchestrator_instruction
  "workspace_setup_instruction": "How to study the project..." // legacy key workspace_setup_instruction
}
```

Corrupt stored template → served as built-in defaults (warning logged), never 5xx (spec FR-011).

## PUT /api/brigadir-agent-settings

Body = same shape as GET (full replacement, `.strict()`). Validation:

- shape/bounds per `BrigadirAgentTemplateSchema` + both instructions `string 1..20000`;
- `template.triage.executor` and `template.setup.executor` must name an EXISTING and ENABLED executor profile → otherwise **422** with a field-level issue (`path: "template.triage.executor"` etc.);
- unknown keys → 422 (strict).

Success: upserts three `global_settings` keys atomically within the handler (`brigadir_agent_template` as JSON document; the two instruction strings under their existing keys), returns the saved payload (200). Concurrent PUTs: last write wins (KV upsert semantics).

```jsonc
// 422 example
{
  "message": "Brigadir agent settings could not be saved.",
  "issues": [
    { "path": "template.setup.executor", "code": "custom",
      "message": "Executor profile \"gone-profile\" does not exist or is disabled.", "level": "error" }
  ]
}
```

## REMOVED: GET/PUT /api/general-settings

Deleted in the same change (research D3): both fields move here; Theme is device-local and was never server-persisted. Web consumers (`apps/web/src/api/generalSettings.ts`, `useGeneralSettings`, `SettingsGeneral.vue` instruction blocks) and tests (`global-settings.integration.spec.ts`, the instruction cases of `apps/web/test/settings-page.spec.ts`) are migrated to the new endpoint. Storage keys are NOT renamed — stored operator edits survive (spec FR-005, SC-006 of this feature's spec).

## Workspace-creation warning (extended response, existing endpoint)

`POST /api/workspaces` — response gains the established optional `warnings[]` array (same `ErrorIssue`-shaped convention as agent-save responses) carrying the seed fallback notice when the template's triage executor is missing/disabled:

```jsonc
{ "id": "…", /* existing fields unchanged */,
  "warnings": [ { "path": "template.triage.executor", "code": "fallback",
                  "message": "Executor profile \"custom-x\" not found — orchestrator seeded on brigadir-orchestrator.",
                  "level": "warning" } ] }
```

Web create flow toasts warnings via the existing `ElMessage.warning` convention. Config-seeder and startup-backfill surface the same condition as a structured warn log (no HTTP response there).

## Setup-run environment (behavioral contract, no HTTP surface)

For runs with `trigger_event.source === 'workspace-setup'`:

- environment resolves from the live template `setup` profile (executor config by name; behavior; timeout) — see data-model §6;
- fallback to built-in `brigadir-setup` on missing/disabled profile + `run_events` warning entry (visible via existing `GET /api/runs/:id` timeline);
- worktree branch `setup/<runId8>`, local-only; cleanup identical to regular runs;
- triage/all other sources: byte-identical resolution to today.
