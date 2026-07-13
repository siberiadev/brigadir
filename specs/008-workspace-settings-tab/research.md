# Phase 0 Research: Workspace Settings Tab

All Technical Context unknowns resolved below. No `NEEDS CLARIFICATION` remain; the only
open item is a deliberate user-participation checkpoint on the exact read-only block
composition (spec Assumptions), which does not block design.

## R1 — Settings as a nested tab + retiring the standalone page

**Decision**: Move `settings` from a top-level sibling route to a **nested child** of the
`/workspaces/:id` → `WorkspacePage` route, alongside `agents` and `runs`. Add
`{ name: 'settings', label: 'Settings' }` (third, after Runs) to `WorkspacePage.vue`'s `tabs`
array. Delete the top-level `workspace-settings` route; the path `/workspaces/:id/settings`
now resolves to the nested child, keeping the deep-link valid (FR-010). The list's Settings
action (`WorkspaceList.openSettings`) pushes `{ name: 'settings', params: { id } }` instead of
`workspace-settings`.

**Rationale**: Feature 007 already established the URL as the single source of truth for the
active tab and reused `agents`/`runs` verbatim as nested children. Adding `settings` as a
third child makes the tab strip drive it with zero new navigation pattern (spec Assumption 1),
and the shared `WorkspaceTabs` `active` computed derives it from `route.name` automatically.

**Route-ordering note**: 007 kept `settings` top-level *specifically* so its static segment
out-ranked the nested `:catchAll(.*)*` unknown-tab redirect. Moving `settings` into the
children list means the nested `settings` child MUST be declared **before** the
`:catchAll(.*)*` redirect child so it is matched first (Vue Router matches nested children in
declaration order for same-depth static-vs-wildcard). This is guarded by an explicit
deep-link resolution test (US3) and an unknown-tab fallback test (Edge Case).

**Alternatives considered**:
- *Keep the top-level route and render `WorkspacePage` from it with the tab pre-selected* —
  rejected: two routes rendering the same tab body invites drift and a second source of truth
  for "which tab is active"; a single nested child is simpler and matches 007.
- *A route redirect `/settings` → `/…/settings`* — unnecessary indirection; the nested child
  already owns the path.

## R2 — Read-only presentation with `el-descriptions`

**Decision**: Render each read-only block with Element Plus `el-descriptions` +
`el-descriptions-item` (label/value grid), NOT `el-form` with `disabled` inputs. The Jira
connection block is one `el-descriptions` (site, project, board + type, bot email, token
expiry, credential status via the existing `CredentialBadge`); the configuration block is an
`el-descriptions` (branch prefix, scope filter) plus a repositories list/table with the first
(default) repo marked by an `el-tag`. Nullable values render an explicit em-dash / "not set" /
"no repositories" placeholder (FR-015, edge cases), never a blank row.

**Rationale**: SC-001 requires the operator to encounter *no editable field* in the read-only
view; `el-descriptions` is the idiomatic Element Plus read-only presentation and structurally
cannot be edited. The default-repo marker and placeholder states are pure presentation over
data already in the workspace response (`repositories`, `credential_status`, `expires_at`).

**Alternatives considered**: disabled `el-form` inputs (rejected — still look like a form,
violate the spec's "explicitly NOT forms with disabled fields"); a hand-rolled `<dl>`
(rejected — reinvents `el-descriptions`, loses theming/responsive behavior).

## R3 — Reusing the existing forms inside modals

**Decision**: Extract the two inline forms currently in `WorkspaceSettings.vue` into
dialog-agnostic body components following the shipped `ExecutorForm` pattern
(`defineExpose({ submit, saving })`, emits `@saved`):
- `ConnectionForm/ConnectionForm.vue` — the reconnect/re-verify form (bot email, new API
  token, expiry), wrapping `useRotateConnection`; seeds `jira_email` from the new `bot_email`
  response field.
- `ConfigForm/ConfigForm.vue` — branch prefix, advanced scope JQL, repositories editor,
  wrapping `useUpdateSettings`; seeds `branch_prefix`/`scope_jql`/`repositories` from the
  persisted response values (R4), not hard-coded `feat`/`""`.

Each is hosted in a `FormDialog` whose footer wires `formRef.submit()` / `formRef.saving`, and
whose default slot mounts the form (destroyed on close per R5). On `@saved` the parent closes
the modal and shows an `ElMessage`; the vue-query `onSuccess` invalidation already wired in
`useWorkspaces` refreshes the read-only blocks (FR-007). The executor form + its modal stay
exactly as they are today (FR-009).

**Rationale**: The spec mandates relocating, not rewriting, existing form logic (Assumption 2).
`ExecutorForm` already proves the `submit()`/`saving` + footer-in-dialog seam works with
`append-to-body`; mirroring it keeps three edit modals behaviorally identical and testable.

**Alternatives considered**: keeping the forms inline and toggling read-only↔edit in place
(rejected — the spec requires modals and a read-first view); one mega-form component (rejected
— the two edit surfaces map to two different endpoints and two Edit buttons).

## R4 — Additive `WorkspaceResponse` extension (bot_email, branch_prefix, scope_jql)

**Decision**: Extend `WorkspaceResponseSchema` (`packages/contracts`) with three nullable
fields — `bot_email: string | null`, `branch_prefix: string | null`, `scope_jql: string | null`
— and map them in `workspaces.controller.ts` `toResponse()`:
- `branch_prefix` / `scope_jql`: from the already-loaded `getWorkspaceSettings(...)` blob
  (`settings.branch_prefix ?? null`, `settings.scope_jql ?? null`).
- `bot_email`: `decodeJiraCredentials(row.jiraCredentials).email` — the existing decode seam
  from `@brigadir/jira`; **only `.email` is read**, `api_token` is discarded and never placed
  on the response.

The Edit modals seed their inputs from these fields.

**Rationale**: This is the exact, one-and-only additive extension sanctioned by the checkpoint
amendment (FR-014) and recorded in the spec Assumptions. It fixes the pre-existing footgun
(re-saving overwriting a customized prefix with `feat`) called out in the current
`WorkspaceSettings.vue` code comment. Nullable typing keeps it non-breaking: existing consumers
ignore unknown/nullable additions, and workspaces created before `branch_prefix`/`scope_jql`
were ever persisted return `null` and render the placeholder state.

**Constitution V compliance**: surfacing only the decoded email keeps the token structurally
absent from every serialized response; a contract test asserts `api_token` is not a key of the
response shape.

**Alternatives considered**:
- *Hide these fields and seed edits from defaults* (the pre-amendment behavior) — rejected by
  the checkpoint precisely because it silently overwrites customized values.
- *A separate `GET /…/settings` detail endpoint* — rejected: violates "one additive extension,
  no new endpoint"; the list/detail response already carries repositories/credential_status,
  so extending it is the minimal change.

## R5 — FormDialog reopen-race root cause & fix

**Symptom** (reproduced live 2026-07-13): open an Edit modal, close it, immediately reopen a
modal *before the close transition finishes* → the dialog renders with only its title and
footer, the body slot empty.

**Root cause**: `el-dialog` with `append-to-body` lazily renders and then **retains** its
teleported content in the DOM across close; the body forms are additionally guarded by
`v-if="showX"` bound to the same `modelValue`. When a second open races the first close's
`el-overlay`/transition teardown, the still-running leave transition unmounts the slotted body
while the new open reuses the retained dialog frame — leaving the frame (title/footer) but no
body.

**Decision**: Add `destroy-on-close` to the shared `el-dialog` in `FormDialog.vue` so the body
is fully unmounted on close and freshly mounted on each open, removing the retained-frame race.
Drive body mount/unmount off the dialog lifecycle rather than a redundant `v-if` tied to the
same flag (keep `:key` on the form for identity between create/edit). Preserve all existing
dismissal rules: `:close-on-click-modal="false"`, close only via X / ESC / footer buttons.

**Rationale**: `destroy-on-close` is Element Plus's built-in mechanism for exactly this class
of "stale/empty dialog content on reopen" bug; it guarantees FR-013's "full content on every
open, including within the close-animation window" without hand-managing transition timing. The
fix is in the shared wrapper, so all three edit modals (connection, config, executor) and the
create-workspace modal inherit it.

**Verification**: a regression test opens a modal, closes it, and reopens within the
close-animation window, asserting the body form fields are present (SC-004, zero empty-shell
occurrences).

**Alternatives considered**:
- *`:key` the whole `el-dialog` per-open to force a remount* — rejected: heavier (remounts the
  overlay/transition too), and can fight the leave transition mid-flight.
- *`nextTick`/timeout gating reopen until the transition ends* — rejected: timing-dependent,
  fragile, and blocks the user; `destroy-on-close` is declarative and deterministic.
