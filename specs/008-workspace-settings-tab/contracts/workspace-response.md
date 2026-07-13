# Contract: Additive `WorkspaceResponse` extension

The **single** API change in feature 008 (FR-014). Additive, non-breaking, no new endpoint,
no request-shape change, no DB migration.

## Endpoints affected (response shape only)

Every endpoint returning `WorkspaceResponse` gains the three fields below (same mapper):
- `GET /api/workspaces` → `WorkspaceResponse[]`
- `POST /api/workspaces` → `WorkspaceResponse`
- `PUT /api/workspaces/:id/jira-connection` → `WorkspaceResponse`
- `PUT /api/workspaces/:id/settings` → `WorkspaceResponse`

## Added fields

```ts
// packages/contracts/src/dashboard.schema.ts — WorkspaceResponseSchema (additions only)
bot_email:     z.string().nullable(),   // decoded credential email ONLY
branch_prefix: z.string().nullable(),   // settings.branch_prefix ?? null
scope_jql:     z.string().nullable(),   // settings.scope_jql ?? null
```

Full response shape remains `.strict()`; the three keys are always present (value `null` when
absent). `api_token` is NOT and MUST NEVER be a key of this shape.

## Backend mapping (`workspaces.controller.ts` → `toResponse`)

```ts
const settings = await getWorkspaceSettings(this.db, id);
const creds = decodeJiraCredentials(row.jiraCredentials); // existing @brigadir/jira seam
return {
  ...existing fields...,
  bot_email: creds.email ?? null,          // .api_token discarded — never serialized
  branch_prefix: settings.branch_prefix ?? null,
  scope_jql: settings.scope_jql ?? null,
};
```

## Contract & mapping tests (Principle V + VI)

1. **Schema** (`dashboard.schema.spec.ts`): a valid response parses with the three fields;
   the response shape has NO `api_token`/`jira_api_token` key.
2. **Response mapping** (`apps/backend` controller/integration): given a workspace with a
   persisted `branch_prefix`/`scope_jql` and encoded credentials, `toResponse` returns those
   values and the decoded `bot_email`; `api_token` absent from the serialized object.
3. **Nullable/legacy**: a workspace whose settings blob lacks `branch_prefix`/`scope_jql`
   returns `null` for those fields (no throw, no default injection).

## Non-changes (explicit)

- `WorkspaceRotateRequest`, `WorkspaceSettingsRequest`, `WorkspaceCreateRequest`,
  `VerifyResponse` — unchanged.
- No DB column added; `branch_prefix`/`scope_jql` continue to live in the `settings` jsonb.
- No other controller, worker, or pipeline code touched.
