# Phase 1 Data Model: Workspace Settings Tab

No database schema change (FR-014, SC-005). This document captures (a) the single additive
change to the serialized `WorkspaceResponse` and (b) the client-side view-model blocks the
Settings tab renders. Everything derives from data already persisted in `workspaces` and its
`settings` jsonb / encrypted credentials blob.

## 1. Additive response fields (contract boundary)

`WorkspaceResponse` gains three **nullable, non-breaking** fields. Source of each below.

| Field | Type | Source (backend `toResponse`) | Notes |
|-------|------|-------------------------------|-------|
| `bot_email` | `string \| null` | `decodeJiraCredentials(row.jiraCredentials).email` | Only `.email`; `api_token` NEVER serialized (Principle V). Null only if credentials undecodable. |
| `branch_prefix` | `string \| null` | `settings.branch_prefix ?? null` | From `workspaces.settings` jsonb; null when never set (renders placeholder + seeds edit as empty, not `feat`). |
| `scope_jql` | `string \| null` | `settings.scope_jql ?? null` | Advanced ingest filter; null when unset. |

All other `WorkspaceResponse` fields (`id`, `name`, `jira_site_url`, `project_key`, `board_id`,
`board_type`, `expires_at`, `credential_status`, `repositories`, `enabled`, timestamps) are
**unchanged**. The write requests (`WorkspaceRotateRequest`, `WorkspaceSettingsRequest`) are
**unchanged** — the edit modals already send these shapes.

**Validation / invariants**:
- Response `api_token` is absent from the schema shape (asserted by contract test).
- Nullable fields tolerate legacy rows (created before prefix/scope were persisted) → `null`.

## 2. Client view-model blocks (no persistence)

The Settings tab body composes three sections from one cached `WorkspaceResponse`.

### 2a. Jira connection block (read-only `el-descriptions`)
| Item | Value source | Empty/placeholder behavior |
|------|--------------|----------------------------|
| Site | `jira_site_url` | — (always present) |
| Project | `project_key` | — |
| Board | `board_id` + `board_type` | "Not configured" when `board_id`/`board_type` null |
| Bot email | `bot_email` | em-dash / "not set" when null |
| Token expiry | `expires_at` (localized date) | "No expiry" when null |
| Credential status | `credential_status` via `CredentialBadge` | badge always renders a state |

Edit action → `ConnectionForm` modal (seeds `jira_email` from `bot_email`; new token entered).

### 2b. Configuration block (read-only `el-descriptions` + repo list)
| Item | Value source | Empty/placeholder behavior |
|------|--------------|----------------------------|
| Default branch prefix | `branch_prefix` | "Default (feat)" or em-dash when null |
| Scope filter (advanced) | `scope_jql` | "None" when null |
| Repositories | `repositories[]` | "No repositories configured" when empty; first item tagged **Default** |

Edit action → `ConfigForm` modal (seeds `branch_prefix`/`scope_jql`/`repositories` from
persisted values).

### 2c. Executors section (unchanged)
Existing `el-table` + New/Edit/Delete executor controls with their `FormDialog` +
`ExecutorForm`. No data-model change; retained verbatim (FR-009).

## 3. Edit-modal state transitions (client)

```
[Read-only block] --Edit--> [FormDialog open + form body mounted]
      ^                                   |
      | submit ok (@saved → close +       | cancel / X / ESC
      | invalidate workspacesKey)         v
      +---------------------------- [FormDialog closed, body destroyed]
```

- Submit success: modal closes, `workspacesKey` invalidated → blocks re-render from refreshed
  cache (FR-007).
- Cancel/close: no request sent, configuration unchanged (FR-008).
- Reopen within close-animation window: body re-mounts fresh via `destroy-on-close` (FR-013).

## 4. Routing view-model

| Path | Route name | Renders |
|------|-----------|---------|
| `/workspaces/:id` | `workspace` | redirect → `agents` (unchanged) |
| `/workspaces/:id/agents` | `agents` | Agents tab body (unchanged) |
| `/workspaces/:id/runs` | `runs` | Runs tab body (unchanged) |
| `/workspaces/:id/settings` | `settings` | **NEW** Settings tab body (nested child) |
| `/workspaces/:id/<other>` | `:catchAll` | redirect → `agents` (unchanged; declared after `settings`) |

The former top-level `workspace-settings` route is removed; its path is now owned by the
`settings` nested child.
