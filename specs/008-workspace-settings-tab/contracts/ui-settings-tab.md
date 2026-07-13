# Contract: Settings tab UI (routes, components, selectors)

Frontend contract for the Settings tab — the surface tests assert against.

## Route

Nested child of `/workspaces/:id` (`WorkspacePage`), declared **before** the `:catchAll`
redirect:

```ts
{ path: 'settings', name: 'settings', component: () => import('../views/WorkspaceSettings.vue'), props: true }
```

- `/workspaces/:id/settings` → resolves to route name `settings`, Settings tab active.
- Former top-level `{ name: 'workspace-settings' }` route is **removed**.
- `WorkspaceList` Settings action pushes `{ name: 'settings', params: { id } }`.
- `WorkspacePage.tabs` = `[agents, runs, settings]` (Settings third).

## Component seams (props / expose / emits)

| Component | Props | Exposes | Emits |
|-----------|-------|---------|-------|
| `WorkspaceSettings.vue` (tab body) | `id: string` | — | — |
| `ConnectionForm/ConnectionForm.vue` | `workspaceId`, `botEmail: string \| null` | `{ submit(), saving }` | `saved` |
| `ConfigForm/ConfigForm.vue` | `workspaceId`, `branchPrefix`, `scopeJql`, `repositories` | `{ submit(), saving }` | `saved` |
| `FormDialog.vue` (shared, edited) | `modelValue`, `title`, `width?` | — | `update:modelValue` |

`FormDialog` gains `destroy-on-close` on its inner `el-dialog`; dismissal rules unchanged
(`close-on-click-modal=false`, close via X / ESC / footer only).

## `data-test` selectors (stable for tests)

Read-only blocks:
- `settings-jira-block`, `settings-config-block`, `settings-executors-block`
- within Jira block: `jira-site`, `jira-project`, `jira-board`, `jira-bot-email`,
  `jira-token-expiry`, `credential-status` (existing `CredentialBadge`)
- within config block: `config-branch-prefix`, `config-scope-jql`,
  `config-repo-<i>` rows, `config-repo-default-tag` (on first repo)
- Edit buttons: `edit-jira-connection`, `edit-config`

Edit modals (reuse existing form selectors where possible):
- Connection modal: `rotate-email`, `rotate-token`, `rotate-expiry`, `reconnect-button`,
  `rotate-error`
- Config modal: `branch-prefix`, `toggle-advanced`, `scope-jql`, `repo-row-<i>`,
  `repo-name-<i>`, `repo-url-<i>`, `repo-branch-<i>`, `repo-remove-<i>`, `add-repo`,
  `save-settings`
- Executors (unchanged): `new-executor`, `executors-table`, `executor-edit-<id>`,
  `executor-delete-<id>`, `executor-save`, `executor-cancel`

## Acceptance mapping (spec → assertion)

| Spec | Assertion |
|------|-----------|
| US1 / FR-001..004, FR-009 | Settings tab present (3rd); Jira + config blocks render as `el-descriptions` (no editable inputs in read-only view); default repo tagged; executors table present |
| US2 / FR-005..008 | Edit buttons open the right modal; submit closes + block reflects saved value; cancel leaves data unchanged |
| US3 / FR-010..012 | Direct visit + list action land on route `settings` with Settings tab active; no standalone page rendered; unknown tab → agents |
| US4 / FR-013 | Reopen modal within close-animation window → body fields present (no empty shell) |
| FR-015 | Null board/expiry/bot_email + empty repositories render placeholders, not blank/broken rows |
