# Contract: General (Global) Settings API

**Files**: `packages/contracts/src/global-settings.schema.ts` (new),
`apps/backend/src/dashboard/general-settings.controller.ts` (new),
`libs/database/src/schema/global-settings.ts` (new table — see data-model §1.2). FR-021/022.

## Schema

```ts
export const GeneralSettingsSchema = z
  .object({
    default_orchestrator_instruction: z.string().max(20000),
  })
  .strict();
export type GeneralSettings = z.infer<typeof GeneralSettingsSchema>;
```

## Endpoints (dashboard-token guarded, like other `/api/*` dashboard routes)

### `GET /api/general-settings`
Returns the current General settings. When `default_orchestrator_instruction` is unset in
`global_settings`, returns the built-in default constant (so the UI field is never empty).

```
200 → { "default_orchestrator_instruction": "<text>" }
```

### `PUT /api/general-settings`
Upserts the settings key(s) into `global_settings` (`key='default_orchestrator_instruction'`).

```
Body: { "default_orchestrator_instruction": "<text>" }   // GeneralSettingsSchema
200  → { "default_orchestrator_instruction": "<text>" }
400  → validation error
```

## Seeding semantics (FR-022)

- The value is read **at workspace-creation time** (wizard, yaml seed) and **copied** into the seeded
  orchestrator agent's `instruction`, falling back to the built-in default when the key is unset.
- Changing it affects **only workspaces created afterward** — existing orchestrator agents are never
  touched (no propagation). This is asserted by SC-006.

## UI contract

A new **"General"** tab in the platform-settings page with a single multi-line text field
(default orchestrator instruction) + Save. Save calls `PUT /api/general-settings`.

## Tests (integration)

- `GET` before any `PUT` ⇒ built-in default.
- `PUT` then `GET` ⇒ persisted value.
- Create workspace A, `PUT` new default, create workspace B ⇒ B's orchestrator uses the new default,
  A's orchestrator instruction unchanged (SC-006).
- `PUT` with an extra key ⇒ 400 (`.strict()`).
