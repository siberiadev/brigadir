# Quickstart: Workspace Settings Tab

Validation guide for feature 008. Proves the Settings tab, the Edit modals, the deep-link, the
FormDialog reopen-race fix, and the additive response fields end-to-end. See
[data-model.md](./data-model.md), [contracts/](./contracts/) for details.

## Prerequisites

- Repo bootstrapped: `pnpm install`.
- Full stack for manual QA: `docker compose up --build` (postgres, redis, backend, worker) and
  `pnpm --filter @brigadir/web dev` for the dashboard, OR run the component tests (no stack).
- At least one workspace created with repositories and a customized `branch_prefix`/`scope_jql`
  (set via the config edit) to exercise the seed-from-persisted path.

## Automated validation (primary)

```bash
# Frontend component tests (msw, jsdom) — read-only blocks, edit round-trips,
# deep-link → settings tab, FormDialog reopen-race regression:
pnpm --filter @brigadir/web test

# Contract + backend response-mapping (additive fields present, api_token absent):
pnpm --filter @brigadir/contracts test
pnpm --filter @brigadir/backend test   # workspaces.controller response-mapping test

# Repo-wide gates:
pnpm typecheck && pnpm lint && pnpm test
```

Expected: all green. Key assertions (see [contracts/ui-settings-tab.md](./contracts/ui-settings-tab.md)):
- Settings tab is the 3rd tab; Jira + configuration blocks render as read-only `el-descriptions`
  (no editable input in the read-only view); default repo carries the **Default** tag.
- Edit → Connection/Config modal opens seeded from persisted values; submit closes the modal and
  the block reflects the saved value; cancel leaves data unchanged.
- Visiting `/workspaces/:id/settings` (and the list Settings action) lands on route `settings`
  with the tab active; no standalone settings page renders; unknown tab → agents.
- Reopen a modal within the close-animation window → body form fields present (zero empty shell).
- `WorkspaceResponse` carries `bot_email` / `branch_prefix` / `scope_jql`; `api_token` absent.

## Manual validation (secondary)

1. **Read-only tab** — open a workspace → click **Settings**. Confirm three blocks: Jira
   connection, Configuration (repos with the first tagged Default), Executors table. No editable
   fields in the connection/config blocks.
2. **Edit Jira connection** — click Edit on the Jira block → modal opens with bot email
   pre-seeded. Enter a new token + expiry, submit → modal closes, block shows updated values. A
   deliberately bad token surfaces the inline error and retains the working connection.
3. **Edit configuration** — click Edit on the config block → modal seeded with the *persisted*
   branch prefix / scope JQL / repositories (NOT `feat`/empty). Change the prefix, add/remove a
   repo, submit → block reflects it; the toast notes it takes effect next poller pass.
4. **Deep-link** — paste `/workspaces/:id/settings` into the address bar → workspace page opens
   with Settings active. Back/forward across Agents/Runs/Settings works via browser history.
5. **Reopen race** — open an Edit modal, close it, immediately reopen (any Edit button) before
   the fade finishes → the modal always shows its full form body, never a title+footer shell.
6. **Nullable degradation** — a workspace with no board / no token expiry / no repositories
   shows placeholders ("Not configured", "No expiry", "No repositories configured"), no broken
   rows and no phantom default marker.

## Rollback

Frontend-only + one additive nullable response field. Reverting the branch removes the tab and
the three response fields with no schema migration to undo and no pipeline impact (SC-005).
