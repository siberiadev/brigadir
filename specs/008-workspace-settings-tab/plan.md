# Implementation Plan: Workspace Settings Tab

**Branch**: `008-workspace-settings-tab` | **Date**: 2026-07-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/008-workspace-settings-tab/spec.md`

## Summary

Add a third router-driven tab **Settings** to the workspace page (after **Agents | Runs**,
reusing the `WorkspaceTabs` component from feature 007). The tab renders the workspace
configuration as **read-only structured data** — Element Plus `el-descriptions` blocks, not
forms with disabled fields — in three sections: a **Jira connection** block (site, project,
board + type, bot email, token expiry, credential status), a **configuration** block (default
branch prefix, advanced scope filter, repositories with the default marked), and the existing
**executors** admin section (table + create/edit modals, unchanged). Each editable block gains
an **Edit** button that opens the corresponding form inside the shared `FormDialog` modal.

The standalone settings page is **retired**: the shipped address `/workspaces/:id/settings`
becomes a nested `settings` tab child of `WorkspacePage`, so deep-links keep resolving (now to
the tab) and the list's Settings action targets the tab. `WorkspaceSettings.vue` is replaced by
a thin `WorkspaceSettings` tab body that composes the read-only blocks and the Edit modals; its
inline forms are extracted into dialog-agnostic form bodies (`ConnectionForm`, `ConfigForm`)
that expose `submit()`/`saving`, mirroring the existing `ExecutorForm` convention.

Two defects are fixed in the same iteration because the new edit flows depend on them:
1. **FormDialog reopen race** (FR-013) — reopening a `FormDialog` while the prior instance's
   close transition is still running renders an empty title+footer shell. Fixed in
   `components/FormDialog.vue`.
2. **Settings seeded from hard-coded defaults** (FR-014) — the standalone form seeded
   `branch_prefix`/`scope_jql` from `feat`/`""` because `GET /api/workspaces/:id` never
   serialized them, so re-saving could overwrite a customized prefix. The **single additive,
   non-breaking API extension** in scope adds `bot_email`, `branch_prefix`, and `scope_jql` to
   the workspace response (credentials still never serialized); the Edit modals seed from these
   persisted values.

**Frontend + one additive contract field** only: no DB schema change, no run/callback pipeline
change, no other endpoint touched. Coverage is msw component tests for the read-only blocks,
both Edit-modal round-trips, the settings deep-link resolving to the tab, and a regression test
for the FormDialog reopen race; plus a contract/response-mapping test for the additive fields.

## Technical Context

**Language/Version**: TypeScript strict (Node ≥22); Vue 3 SFCs (`<script setup lang="ts">`);
backend NestJS 11 (only the workspace response mapper + contract touched).

**Primary Dependencies**: Vue 3.5, Vue Router 4.5 (nested route child), Element Plus 2.9
(`el-descriptions`/`el-descriptions-item`, `el-dialog`, `el-tabs`), Pinia,
`@tanstack/vue-query` 5 (cache invalidation after edits already wired in `useWorkspaces`), Zod
(contracts). No new dependency.

**Storage**: Postgres 16 — **no schema change**. The additive fields read existing data:
`branch_prefix`/`scope_jql` from the `workspaces.settings` jsonb blob (already loaded via
`getWorkspaceSettings`), and `bot_email` from the AES-256-GCM `jiraCredentials` blob via the
existing `decodeJiraCredentials` seam (only `.email` surfaced; `api_token` never serialized).

**Testing**: Vitest 2 + `@vue/test-utils` 2 + msw 2 (`jsdom`) for `apps/web`, run via
`pnpm --filter @brigadir/web test`; backend response-mapping + contract tests via Vitest
(`packages/contracts` schema spec, `apps/backend` controller/integration). Router assertions
use a real memory-history router built from the app's routes; the API boundary stays faked by
the existing msw handlers.

**Target Platform**: Browser SPA (the existing dashboard behind App.vue's token gate) + the
NestJS dashboard API.

**Project Type**: Web application within the pnpm monorepo — `apps/web` (frontend, primary),
`apps/backend` + `packages/contracts` (single additive response field).

**Performance Goals**: Selecting the Settings tab swaps only the nested `<router-view>`; the
workspace list query is cached, so the read-only blocks render from cache with no refetch. Edit
submits invalidate `workspacesKey`, refreshing the blocks in place.

**Constraints**: URL is the single source of truth for the active tab (feature 007 rule
preserved). Read-only blocks MUST be `el-descriptions`, not disabled inputs (SC-001). Dialogs
keep their dismissal rules — close only via the X, ESC, or explicit footer buttons; no
close-on-outside-click. Credentials NEVER serialized (Principle V). All nullable fields degrade
gracefully (FR-015).

**Scale/Scope**: ~2 new form component folders (`ConnectionForm/`, `ConfigForm/`), ~2 new
read-only block components (or inline `el-descriptions` in the tab body), 1 rewritten tab body
(`WorkspaceSettings.vue`), edits to `router/index.ts`, `WorkspacePage.vue`, `WorkspaceList.vue`,
`FormDialog.vue`; backend: `dashboard.schema.ts` (+3 response fields), `workspaces.controller.ts`
`toResponse` (+3 field mappings). ~3 tabs, ~6 routes.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Applies? | Assessment |
|-----------|----------|------------|
| I. Dual Source of Truth | No | No run/ticket state written or cached; the read-only blocks project existing workspace config, edits use the existing rotate/settings endpoints unchanged. |
| II. Idempotency at Three Levels | No | No run-triggering path touched. |
| III. System-Only Jira Writes | No | No Jira write and no agent path touched; the reconnect/re-verify flow is unchanged, only relocated into a modal. |
| IV. Run Completion Contract | No | No run lifecycle or callback code touched. |
| V. Secret Isolation & Output Scrubbing | Yes | The additive `bot_email` decodes the credential blob to surface ONLY `.email`; `api_token` is never serialized (asserted by a contract/response test). No token ever placed in a URL. |
| VI. Test-Mandatory Pipeline Logic | Yes (UI + contract) | UI-only surface is under the "UI/cosmetic MAY ship lighter" exemption, yet full msw coverage ships for every acceptance scenario. The additive response field is a contract boundary → gets a contract test (fields present, `api_token` absent) per Principle VI. |
| Tech Constraints (TS strict, Vue.js dashboard, lazy resource resolution) | Yes | Vue.js is the mandated dashboard stack; `strict: true` preserved (no `any` at new boundaries). Backend change is inside an existing request-scoped mapper — no `@Module()`-argument resource init, so the lazy-resolution rule is not implicated. |

**Result**: PASS. No violations; Complexity Tracking not required. The single API change is the
one additive, non-breaking extension explicitly sanctioned by the checkpoint amendment
(FR-014) and recorded in the spec Assumptions.

**Post-design re-check (after Phase 1)**: Still PASS. The design adds client views/components,
one nested route, a shared-dialog lifecycle fix, and three additive read-only response fields
mapped from already-persisted data. No persistence schema change, no pipeline change, no Jira
write, no new secret surface (email only, token never), no DI/module composition. Principle V
is actively upheld by a test; Principle VI coverage ships for both the UI scenarios and the
contract boundary.

## Project Structure

### Documentation (this feature)

```text
specs/008-workspace-settings-tab/
├── plan.md              # This file (/speckit-plan output)
├── research.md          # Phase 0 output — R1..R5 decisions
├── data-model.md        # Phase 1 output — view-model blocks + additive response fields
├── quickstart.md        # Phase 1 output — manual + test validation
├── contracts/
│   ├── workspace-response.md   # Phase 1 — additive WorkspaceResponse fields (bot_email, branch_prefix, scope_jql)
│   └── ui-settings-tab.md      # Phase 1 — route child, block layout, data-test selectors
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
apps/web/
├── src/
│   ├── router/
│   │   └── index.ts                 # EDIT: move `settings` under /workspaces/:id as a nested child
│   │                                #       of WorkspacePage; drop the top-level workspace-settings route
│   ├── views/
│   │   ├── WorkspacePage.vue         # EDIT: add { name:'settings', label:'Settings' } to the tabs array
│   │   ├── WorkspaceSettings.vue     # REWRITE: read-only el-descriptions blocks + Edit buttons →
│   │   │                             #          FormDialog modals; keep executors table+modal as-is
│   │   └── WorkspaceList.vue         # EDIT: Settings action pushes the nested `settings` tab route
│   └── components/
│       ├── FormDialog.vue            # EDIT: fix reopen-race (destroy-on-close lifecycle) — FR-013
│       ├── ConnectionForm/
│       │   └── ConnectionForm.vue    # NEW: reconnect/re-verify form body (submit()/saving) seeded from bot_email
│       ├── ConfigForm/
│       │   └── ConfigForm.vue        # NEW: branch_prefix/scope_jql/repositories form body seeded from persisted values
│       └── (optional) settings blocks # read-only el-descriptions may live inline in WorkspaceSettings.vue
└── test/
    ├── mount.ts / handlers.ts        # REUSED/EXTEND: workspace detail handler returns the 3 new fields
    └── workspace-settings.spec.ts    # EDIT/EXTEND: read-only blocks, both Edit round-trips,
                                      #             deep-link → settings tab, FormDialog reopen-race regression

packages/contracts/
└── src/
    ├── dashboard.schema.ts           # EDIT: WorkspaceResponseSchema += bot_email, branch_prefix, scope_jql (nullable)
    └── dashboard.schema.spec.ts      # EDIT: assert the 3 fields; assert api_token never in the shape

apps/backend/
└── src/dashboard/
    ├── workspaces.controller.ts      # EDIT: toResponse() maps bot_email (decoded email only),
    │                                  #        branch_prefix, scope_jql from settings/credentials
    └── (test)                        # EDIT: response-mapping test — 3 fields present, api_token absent
```

**Structure Decision**: Web application within the pnpm monorepo. The primary surface is
`apps/web` (Vue 3 + Vue Router + Element Plus), following the existing component-folder +
scoped-SCSS + `defineExpose({ submit, saving })` conventions. The only non-frontend change is
the single additive `WorkspaceResponse` extension spanning `packages/contracts` (schema) and
`apps/backend` (response mapper) — no worker, no migration, no other controller.

## Complexity Tracking

> Not required — Constitution Check passed with no violations. The lone API change is the
> pre-sanctioned additive extension (FR-014), not a deviation.
