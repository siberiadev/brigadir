# Tasks: Workspace Settings Tab

**Input**: Design documents from `/specs/008-workspace-settings-tab/`

**Prerequisites**: plan.md ✓, spec.md ✓, research.md ✓, data-model.md ✓, contracts/ ✓

**Tests**: INCLUDED. This is a UI-first iteration (exempt from the pipeline-logic test
mandate) but the spec explicitly requires msw component coverage (SC-006) and the lone
additive response field is a **contract boundary** → gets a contract + response-mapping test
per constitution Principle VI (fields present, `api_token` never serialized — Principle V).

**Organization**: Tasks grouped by user story. All four stories are P1/P2 and ship in one PR,
but each phase is a self-contained, independently testable increment.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on incomplete tasks)
- **[Story]**: US1 / US2 / US3 / US4 (maps to spec.md user stories)
- Every task names its exact file path

## Path Conventions

Web app in the pnpm monorepo:
- Frontend: `apps/web/src/…`, tests `apps/web/test/…`
- Contracts: `packages/contracts/src/…`
- Backend: `apps/backend/src/dashboard/…`
- Credential decode seam: `@brigadir/jira` (`libs/jira/src/credentials.codec.ts`)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the working surface; no new dependencies (Vue 3.5 / Router 4.5 / Element
Plus 2.9 / vue-query 5 / Zod already present).

- [X] T001 Confirm branch `008-workspace-settings-tab` is checked out and establish a green
  baseline: run `pnpm --filter @brigadir/web test`, `pnpm --filter @brigadir/contracts test`,
  `pnpm --filter @brigadir/backend test` and note current pass state (no code change).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The single additive `WorkspaceResponse` extension (FR-014) that US1's read-only
blocks display and US2's edit modals seed from, plus the msw fixture that carries the new
fields into every frontend test.

**⚠️ CRITICAL**: US1 and US2 render/seed from `bot_email` / `branch_prefix` / `scope_jql`;
they cannot be correctly implemented or tested until these fields exist end-to-end.

- [X] T002 [P] Extend `WorkspaceResponseSchema` in `packages/contracts/src/dashboard.schema.ts`:
  add `bot_email: z.string().nullable()`, `branch_prefix: z.string().nullable()`,
  `scope_jql: z.string().nullable()` (keep `.strict()`; `WorkspaceRotateRequest` /
  `WorkspaceSettingsRequest` / `WorkspaceCreateRequest` UNCHANGED).
- [X] T003 Map the three fields in `apps/backend/src/dashboard/workspaces.controller.ts`
  `toResponse()`: `branch_prefix: settings.branch_prefix ?? null`,
  `scope_jql: settings.scope_jql ?? null`, and `bot_email` from
  `decodeJiraCredentials(row.jiraCredentials).email ?? null` (import `decodeJiraCredentials`
  from `@brigadir/jira`; read ONLY `.email` — `api_token` is discarded, never serialized).
  **Decode is fail-safe (checkpoint addition)**: `decodeJiraCredentials` THROWS on an
  unrecognized/corrupt blob (seen live in 005 with placeholder credentials) — wrap it in
  try/catch and return `bot_email: null` on failure so one bad row can never 500 the
  workspaces list/detail. Depends on T002.
- [X] T004 [P] Contract test in `packages/contracts/src/dashboard.schema.spec.ts`: a valid
  response parses with `bot_email` / `branch_prefix` / `scope_jql`; assert the shape has NO
  `api_token` / `jira_api_token` key; assert `null` is accepted for all three (legacy rows).
- [X] T005 [P] Backend response-mapping test for `workspaces.controller` `toResponse` (alongside
  the existing dashboard controller tests in `apps/backend/src/dashboard/`): given a workspace
  with persisted `branch_prefix`/`scope_jql` and encoded credentials → returns those values +
  decoded `bot_email`, and the serialized object has no `api_token`; a workspace whose settings
  blob lacks `branch_prefix`/`scope_jql` → those fields are `null` (no throw, no default); a
  workspace whose credentials blob is NOT decodable (placeholder/corrupt bytes) → `bot_email`
  is `null` and the endpoint still returns 200 (checkpoint addition — decode is fail-safe).
  Depends on T003.
- [X] T006 Extend the workspace fixture in `apps/web/test/handlers.ts` (and `mount.ts` seed if
  applicable) so the workspaces list/detail handler returns `bot_email`, `branch_prefix`,
  `scope_jql`, and include a null-valued variant for the FR-015 placeholder assertions.
  Depends on T002.

**Checkpoint**: The additive contract is live, tested, and surfaced through msw — US1/US2 can
now render and seed from real fields.

---

## Phase 3: User Story 1 - Read-only Settings tab (Priority: P1) 🎯 MVP

**Goal**: A third **Settings** tab (after Agents | Runs) renders the workspace's Jira
connection, configuration, and executors as read-only `el-descriptions` blocks — no editable
fields in the read-only view; the default repository is visibly marked.

**Independent Test**: Open a workspace → select Settings → the Jira connection, configuration,
and executors sections render the workspace's actual values as read-only blocks (no inputs),
default repo tagged; null board/expiry/bot_email/repos render placeholders.

### Tests for User Story 1

- [X] T007 [P] [US1] In `apps/web/test/workspace-settings.spec.ts`, assert US1: Settings is the
  3rd tab; the Jira block (`settings-jira-block`) and config block (`settings-config-block`)
  render as read-only `el-descriptions` with NO editable `input`/`el-input` in the read-only
  view; `config-repo-default-tag` present on the first repo; `settings-executors-block` shows
  the executors table (`executors-table`). Assert FR-015 placeholders using the null-valued
  fixture (Board "Not configured", Token expiry "No expiry", bot email em-dash, repos "No
  repositories configured" with no phantom default tag).

### Implementation for User Story 1

- [X] T008 [US1] Register the nested `settings` child in `apps/web/src/router/index.ts` under
  `/workspaces/:id`, declared **before** the `:catchAll(.*)*` redirect child:
  `{ path: 'settings', name: 'settings', component: () => import('../views/WorkspaceSettings.vue'), props: true }`
  (the retire of the old top-level route happens in US3/T016).
- [X] T009 [US1] Add `{ name: 'settings', label: 'Settings' }` (third) to the `tabs` array in
  `apps/web/src/views/WorkspacePage.vue`.
- [X] T010 [US1] Rewrite the read-only surface of `apps/web/src/views/WorkspaceSettings.vue`:
  replace the inline Jira `el-form` with a read-only Jira `el-descriptions`
  (`data-test="settings-jira-block"`: `jira-site`, `jira-project`, `jira-board`,
  `jira-bot-email`, `jira-token-expiry`, `credential-status` via existing `CredentialBadge`),
  and the inline config `el-form` with a read-only config `el-descriptions`
  (`data-test="settings-config-block"`: `config-branch-prefix`, `config-scope-jql`,
  `config-repo-<i>` rows, `config-repo-default-tag` on the first repo). Apply FR-015
  placeholders for every nullable value. Keep the executors section
  (`data-test="settings-executors-block"`) — table + New/Edit/Delete + `ExecutorForm` in its
  `FormDialog` — verbatim (FR-009). (Edit buttons/modals for Jira & config are added in US2.)
  Depends on T006 (fields), T008/T009 (route+tab).

**Checkpoint**: Settings tab renders as a legible read-only view; executors admin intact.

---

## Phase 4: User Story 2 - Edit connection & configuration via modals (Priority: P1)

**Goal**: Each read-only block carries an **Edit** button that opens the corresponding form in
a `FormDialog`; submit persists via existing endpoints, closes the modal, and the block
reflects the saved values; cancel leaves data unchanged. Edit inputs seed from persisted values.

**Independent Test**: On Settings, Edit the Jira block → reconnect form appears seeded from
`bot_email`; submit → modal closes + block updated. Edit the config block → branch/scope/repos
form seeded from persisted values; submit → block (incl. repo list + default marker) updated;
cancel → unchanged.

### Tests for User Story 2

- [X] T011 [P] [US2] Extend `apps/web/test/workspace-settings.spec.ts` for US2: clicking
  `edit-jira-connection` opens the connection modal with `rotate-email` seeded from `bot_email`;
  submitting via `reconnect-button` closes the modal and the Jira block reflects the change.
  Clicking `edit-config` opens the config modal seeded with the persisted `branch-prefix` /
  `scope-jql` / repositories (NOT `feat`/empty); submitting `save-settings` closes it and the
  config block (incl. repo rows + default tag) updates; cancelling/closing sends no request and
  leaves data unchanged (FR-008).

### Implementation for User Story 2

- [X] T012 [P] [US2] Create `apps/web/src/components/ConnectionForm/ConnectionForm.vue`: extract
  the reconnect/re-verify body from the old `WorkspaceSettings.vue` (email `rotate-email`, new
  token `rotate-token`, expiry `rotate-expiry`, inline `rotate-error`). Props
  `{ workspaceId: string, botEmail: string | null }`; seed `jira_email` from `botEmail`; wrap
  `useRotateConnection`; `defineExpose({ submit, saving })`; emit `saved` on success; retain the
  re-verify-failure behavior (surface error, keep working connection). Mirror `ExecutorForm`.
- [X] T013 [P] [US2] Create `apps/web/src/components/ConfigForm/ConfigForm.vue`: extract the
  branch-prefix / advanced scope-jql / repositories editor (`branch-prefix`, `toggle-advanced`,
  `scope-jql`, `repo-row-<i>` + name/url/branch/remove, `add-repo`). Props
  `{ workspaceId: string, branchPrefix: string | null, scopeJql: string | null, repositories }`;
  seed all inputs from props (empty prefix when null — NOT `feat`); wrap `useUpdateSettings`;
  `defineExpose({ submit, saving })`; emit `saved`. Mirror `ExecutorForm`.
- [X] T014 [US2] Wire the Edit modals into `apps/web/src/views/WorkspaceSettings.vue`: add
  `edit-jira-connection` and `edit-config` buttons on the read-only blocks, each opening a
  `FormDialog` hosting `ConnectionForm` / `ConfigForm` (seeded from the cached
  `WorkspaceResponse`: `botEmail`, `branchPrefix`, `scopeJql`, `repositories`). On `saved`:
  close the dialog + `ElMessage` success (vue-query invalidation in `useWorkspaces` refreshes
  the blocks — FR-007). Depends on T010, T012, T013.

**Checkpoint**: US1 + US2 both work — read-only view with functioning Edit round-trips.

---

## Phase 5: User Story 3 - Settings deep-link resolves to the tab (Priority: P1)

**Goal**: `/workspaces/:id/settings` and the list's Settings action land on the workspace page
with the Settings tab active; the standalone page is retired; unknown tab still → agents.

**Independent Test**: Visit `/workspaces/:id/settings` directly and via the list Settings
action → route `settings` active, tab content shown, no standalone page; `/workspaces/:id/xyz`
→ agents.

### Tests for User Story 3

- [X] T015 [P] [US3] Add router assertions (in `apps/web/test/workspace-settings.spec.ts` or a
  routing spec) using a real memory-history router built from the app routes: direct visit to
  `/workspaces/:id/settings` resolves route name `settings` with the Settings tab active and the
  read-only content rendered; the `WorkspaceList` Settings action navigates to route `settings`;
  no `workspace-settings` route remains; `/workspaces/:id/<unknown>` still redirects to `agents`
  (catchAll ordering intact).

### Implementation for User Story 3

- [X] T016 [US3] In `apps/web/src/router/index.ts` remove the top-level
  `{ name: 'workspace-settings', path: '/workspaces/:id/settings' }` route (retire the
  standalone page) and update the stale comments; verify the nested `settings` child (T008)
  precedes `:catchAll(.*)*` so the deep-link resolves to the tab.
- [X] T017 [US3] Repoint the Settings action in `apps/web/src/views/WorkspaceList.vue` to push
  `{ name: 'settings', params: { id } }` (was `workspace-settings`).

**Checkpoint**: Deep-links and the list action land on the Settings tab; no standalone page.

---

## Phase 6: User Story 4 - Reopening an edit modal always shows content (Priority: P2)

**Goal**: The shared `FormDialog` reliably renders full content (title, body, footer) on every
open, including when opened while a prior modal's close transition is still running (FR-013).

**Independent Test**: Open an Edit modal, close it, reopen within the close-animation window →
the second modal renders its form body, not an empty title+footer shell.

### Tests for User Story 4

- [X] T018 [P] [US4] Regression test (in `apps/web/test/workspace-settings.spec.ts`): open an
  Edit modal, close it, and reopen an Edit modal within the close-animation window; assert the
  reopened modal's form body fields are present (zero empty-shell — SC-004).

### Implementation for User Story 4

- [X] T019 [US4] Add `destroy-on-close` to the `el-dialog` in
  `apps/web/src/components/FormDialog.vue` so the slotted body fully unmounts on close and
  re-mounts fresh on each open; preserve all dismissal rules (`:close-on-click-modal="false"`,
  close only via X / ESC / footer). Benefits all three edit modals + the create-workspace modal.

**Checkpoint**: All four stories complete; the shared dialog is race-free.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T020 [P] Run the full gate suite: `pnpm typecheck && pnpm lint && pnpm test`, plus
  `pnpm --filter @brigadir/web test`, `pnpm --filter @brigadir/contracts test`,
  `pnpm --filter @brigadir/backend test` — all green.
- [X] T021 [P] Execute the `quickstart.md` manual validation pass (read-only tab, both Edit
  round-trips, deep-link + back/forward, reopen race, nullable degradation).
- [X] T022 Append the iteration-8 entry to `docs/progress.md` (Settings tab, additive
  `WorkspaceResponse` fields, FormDialog reopen-race fix) per the journal cadence.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: after Setup — BLOCKS US1 and US2 (they render/seed the additive
  fields). Does not block US3 (routing) or US4 (dialog).
- **US1 (Phase 3)**: after Foundational.
- **US2 (Phase 4)**: after US1 (edits the same `WorkspaceSettings.vue` read-only blocks).
- **US3 (Phase 5)**: needs the nested `settings` child from T008 (US1); otherwise independent —
  can be built in parallel with US2.
- **US4 (Phase 6)**: fully independent (only `FormDialog.vue` + its test) — can start anytime
  after Setup.
- **Polish (Phase 7)**: after all desired stories complete.

### Within Each Story

- Tests may be written first (they will fail until the implementation tasks land).
- Form-body extraction (T012/T013) before wiring them into the tab (T014).
- Register route child (T008) before the deep-link retire (T016).

### Parallel Opportunities

- Foundational: T002 ‖ T004 (schema + its test); T003 then T005; T006 ‖ T004.
- US2 form bodies: T012 ‖ T013 (different folders), before T014.
- US4 (T018/T019) can run in parallel with US1/US2/US3 — disjoint files.
- Polish: T020 ‖ T021.

---

## Parallel Example: Foundational + independent US4

```bash
# Contract schema and its test are different concerns on adjacent files:
Task: "T002 Extend WorkspaceResponseSchema in packages/contracts/src/dashboard.schema.ts"
Task: "T004 Contract test in packages/contracts/src/dashboard.schema.spec.ts"

# US4 is disjoint from the settings-tab work — start it immediately:
Task: "T019 Add destroy-on-close to apps/web/src/components/FormDialog.vue"
Task: "T018 Reopen-race regression test in apps/web/test/workspace-settings.spec.ts"
```

---

## Implementation Strategy

### MVP First (US1)

1. Phase 1 Setup → Phase 2 Foundational (additive contract live + msw fixture).
2. Phase 3 US1 → **STOP and VALIDATE**: read-only Settings tab renders workspace data with the
   default repo marked and null placeholders; executors admin intact.
3. Demo the read-first Settings tab.

### Incremental Delivery

1. Foundational → additive fields end-to-end.
2. US1 → read-only tab (MVP).
3. US2 → Edit modals round-trip.
4. US3 → deep-link + retire standalone page.
5. US4 → dialog reopen-race fix (can land any time; smallest, orthogonal).

---

## Notes

- [P] = different files, no dependency on incomplete tasks.
- No DB migration, no run/callback pipeline change, no new endpoint (SC-005). The only backend
  change is the additive `toResponse` mapping (T003) + its contract/mapping tests.
- Credentials NEVER serialized: `bot_email` surfaces only the decoded `.email`; T004/T005 assert
  `api_token` absence (Principle V).
- Commit after each task or logical group; stop at any checkpoint to validate a story.
