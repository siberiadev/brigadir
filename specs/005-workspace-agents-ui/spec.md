# Feature Specification: Workspace & Agents UI

**Feature Branch**: `005-workspace-agents-ui`

**Created**: 2026-07-12

**Status**: Draft

**Input**: User description: "Feature 005: workspace & agents UI — the first web dashboard: a workspace creation wizard and agent CRUD, making the database the primary source of configuration."

## Overview

This is the first web dashboard for BRIGADIR (iteration 5). Until now, workspaces, executors, and agents have been defined in `agents.yaml` and seeded into the database on boot. This feature gives the team a UI to **create and manage workspaces and agents directly**, and flips the source of truth so the **database — not the yaml file — is authoritative** for orchestration configuration.

Two operator-facing capabilities ship together: a **workspace creation wizard** (name → live-verified Jira connection + board binding → repositories → done) and **agent CRUD** (the full agent field set, with board-status-bound selects and a save-time linter). Both sit behind the single shared bearer token (internal tool, no user accounts). Because the wizard now accepts **real Jira API tokens** from team members, Jira credentials must be **encrypted at rest** with expiry tracking — the constitution's Principle V at-rest requirement becomes due this iteration.

The Runs tab, ticket card, and human-task queue remain iteration 6; their routes may exist as placeholders only.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Create a workspace with a verified Jira connection (Priority: P1)

A team member opens the dashboard, starts the workspace wizard, names the workspace, enters the Jira site URL + their email + an API token, and clicks **Verify**. The system live-validates the token and reads the target board, showing them the resolved bot identity, project, and board type before anything is saved. They add one or more repositories (the first is the default), finish the wizard, and the workspace is persisted with the credentials encrypted.

**Why this priority**: A workspace is the root object — no agent, poller pass, or run can exist without one. A verified-before-persist wizard is the minimum viable slice that delivers standalone value: the team can onboard a real Jira project through the UI instead of hand-editing yaml.

**Independent Test**: With a mock Jira backend, drive the wizard end to end — verify surfaces the bot name/project/board type from a valid token, a bad token/board is rejected inline with a human-readable reason, and on finish a workspace row exists with encrypted credentials, board id/type, and repositories. No agents required.

**Acceptance Scenarios**:

1. **Given** a valid Jira site URL, email, token, and an accessible board id, **When** the user clicks Verify, **Then** the system displays the resolved bot display name, project key, and board type (kanban/scrum) and enables advancing to the next step.
2. **Given** a board URL pasted instead of a numeric id, **When** the user clicks Verify, **Then** the system extracts the board id from the URL and verifies it the same way.
3. **Given** an invalid or expired token, **When** the user clicks Verify, **Then** the system shows a path-qualified, human-readable error inline on the token field and does not advance.
4. **Given** a token that is valid but cannot access the requested board, **When** the user clicks Verify, **Then** the system reports the board-access failure distinctly from a token failure.
5. **Given** all steps completed, **When** the user finishes the wizard, **Then** a workspace is persisted with an encrypted credentials blob, `expires_at`, board id + type, project key, and an ordered repositories list whose first entry is the default.
6. **Given** creation is attempted, **When** the backend persists the workspace, **Then** Jira credentials and board are re-validated server-side (not trusting the client's Verify result) before any row is written.

---

### User Story 2 - Create and manage agents for a workspace (Priority: P2)

Inside a workspace the team member opens the Agents list and clicks **+** to add an agent. The form collects the full agent field set. All status fields (trigger, running, success, failure) are selects populated from the board's flat list of statuses. On save, a mini-linter runs: it confirms the chosen statuses exist on the board, forbids a duplicate `trigger_status` among enabled agents (unless their `trigger_jql` differs), and warns about status cycles. The member can trigger a **test run by ticket key** to sanity-check the prompt. Edits take effect without restarting the backend or worker.

**Why this priority**: Agents are what make a workspace do work, but they depend on a workspace existing (US1). Given a workspace, agent CRUD is independently valuable and testable — it is the second half of the "configure the team through the UI" goal.

**Independent Test**: Against a seeded workspace with a known board-status set (mock Jira), create/edit/delete agents through the API and form; assert the linter matrix (missing status → error, duplicate trigger among enabled agents → error unless trigger_jql differs, cycle → warning), that status fields bind by id + name, and that a newly created agent is picked up by the pipeline on the next trigger without a restart.

**Acceptance Scenarios**:

1. **Given** a workspace with a verified board, **When** the agent form opens, **Then** every status field offers the board's flat status list (no columns) and each selection stores both status id and name.
2. **Given** a `status_success` that names a status not present on the board, **When** the user saves, **Then** the save is rejected with a path-qualified error identifying the offending field and value.
3. **Given** an enabled agent already triggers on status "Ready for Dev" with no `trigger_jql`, **When** the user saves a second enabled agent with the same `trigger_status` and no distinguishing `trigger_jql`, **Then** the save is rejected as a duplicate trigger.
4. **Given** the same collision but the second agent has a distinct `trigger_jql`, **When** the user saves, **Then** the save is allowed.
5. **Given** agent A's `status_success` triggers agent B whose `status_success` returns the ticket to A's `trigger_status`, **When** the user saves, **Then** the system surfaces a non-blocking status-cycle warning while still allowing the save.
6. **Given** a saved agent, **When** the user clicks "test run by ticket key" with a valid key, **Then** a run is triggered for that agent against that ticket.
7. **Given** an agent is created or edited, **When** the next poller/trigger pass runs, **Then** it uses the new configuration with no backend or worker restart.
8. **Given** an agent that has completed runs, **When** the user deletes it, **Then** it is soft-deleted (disabled), preserving run history; an agent with no runs may be hard-deleted.
9. **Given** the client-side form, **When** the user edits fields, **Then** the same linter rules are mirrored client-side for immediate feedback, and the server remains the authority on save.

---

### User Story 3 - Database is the primary source of configuration; the existing yaml still works (Priority: P2)

The operator who already runs BRIGADIR from `agents.yaml` upgrades to this release. On boot, their existing workspace/executors/agents are imported into the database once. From then on, the database is authoritative: edits made in the UI are never overwritten by the yaml on subsequent boots, and the yaml functions only as an optional one-time import/template. Run queues continue to exist for every supported executor type regardless of what the yaml declares.

**Why this priority**: This is the architectural pivot of the iteration and it must not regress a live operator. It is P2 rather than P1 only because it is invisible to a fresh install (empty DB behaves identically); for the existing operator it is critical and must be verified.

**Independent Test**: Integration boot with (a) empty DB + yaml present → rows imported; (b) DB rows present + yaml present, DB values differing from yaml → DB values survive the boot unchanged; (c) DB rows present + yaml absent → boot succeeds and queues for all supported executor types exist. Assert the run queue set is derived from the executor-type registry, not from the yaml contents.

**Acceptance Scenarios**:

1. **Given** an empty configuration in the database and an `agents.yaml` present, **When** the backend boots, **Then** the yaml's workspace, executors, and agents are inserted once.
2. **Given** configuration rows already exist in the database and differ from `agents.yaml`, **When** the backend boots, **Then** the database rows are left unchanged (DB wins — the yaml never overwrites or re-seeds an existing row).
3. **Given** `agents.yaml` is absent or removed, **When** the backend boots, **Then** boot succeeds using the database configuration.
4. **Given** any supported executor type in the registry (e.g. mock, claude_cli), **When** the app provisions queues, **Then** a run queue exists for each supported type independent of whether the yaml or any DB agent currently references it.
5. **Given** a workspace or agent created purely through the UI (no yaml entry), **When** the backend reboots, **Then** that configuration persists and is used.

---

### User Story 4 - Manage workspace settings and rotate the Jira token (Priority: P3)

From a workspace's Settings screen, the team member reconnects or rotates the Jira token (re-verified the same way as the wizard), sees an expiry badge that warns at 30 and 7 days before the token expires, edits the advanced `scope_jql`, sets the default `branch_prefix` inherited by agents, and manages the repositories list. If the schema already supports it as a one-field flip, they can pause the workspace (disable the poller while retaining history).

**Why this priority**: Necessary for real operation over time (tokens expire, scope changes) but not required to prove the create-and-configure flow. Ships after the core wizard and agent CRUD.

**Independent Test**: With a persisted workspace, rotate the token (mock Jira re-verify), assert the new encrypted blob and `expires_at` replace the old; assert the badge state transitions at the 30-day and 7-day thresholds from a controllable clock; edit scope_jql/branch_prefix/repositories and confirm persistence.

**Acceptance Scenarios**:

1. **Given** a workspace whose token expires in 25 days, **When** the settings screen loads, **Then** the expiry badge shows the 30-day warning state.
2. **Given** a workspace whose token expires in 5 days, **When** the settings screen loads, **Then** the badge shows the more urgent 7-day warning state.
3. **Given** a new token entered in settings, **When** the user rotates, **Then** the system re-verifies it live and replaces the stored encrypted credentials and `expires_at`.
4. **Given** edits to `scope_jql`, `branch_prefix`, or the repositories list, **When** the user saves, **Then** the changes persist and take effect on the next poller/trigger pass without a restart.
5. **Given** the workspace pause control (only if it is a genuine one-field flip on the existing `enabled` column), **When** the user pauses the workspace, **Then** the poller stops triggering for it while run history is retained.

---

### User Story 5 - Jira credentials are encrypted at rest with expiry tracking (Priority: P2)

Because the wizard now stores real team tokens, Jira credentials are never persisted in plaintext. They are encrypted before storage and decrypted only when the system needs to call Jira. The token's expiry is recorded so the UI can warn ahead of time. An operator upgrading from a plaintext blob has it migrated to the encrypted form.

**Why this priority**: A constitutional requirement (Principle V) that becomes due the moment real tokens enter through the UI. It is a cross-cutting guarantee behind US1/US4 and is verified independently.

**Independent Test**: Assert a persisted workspace's stored credentials are not readable as plaintext; assert the system can still authenticate to (mock) Jira by decrypting them; assert an existing plaintext/legacy blob is migrated to the encrypted form on upgrade; assert `expires_at` is captured at store time.

**Acceptance Scenarios**:

1. **Given** a workspace is created or its token rotated, **When** the credentials are persisted, **Then** the stored bytes are encrypted (not human-readable plaintext) and `expires_at` is recorded.
2. **Given** encrypted credentials in storage, **When** the system needs to call Jira, **Then** it decrypts them transparently and the call succeeds.
3. **Given** a pre-existing legacy plaintext credentials blob, **When** the system upgrades, **Then** the blob is migrated to the encrypted representation without losing the ability to authenticate.
4. **Given** the encryption key is not configured, **When** the system must read or write credentials, **Then** it fails fast with a clear error rather than silently storing or reading plaintext.

---

### Edge Cases

- **Board URL variants**: a pasted board URL with query params or a rapid-board path still yields the correct board id, or a clear "could not extract a board id" error.
- **Scrum board with no active sprint**: verification still succeeds (board type is reported); the operator is informed that scope will be empty until a sprint is active (poller idles) — this is expected, not an error.
- **Statuses source unavailable**: if the board's statuses cannot be fetched when the agent form opens, the form surfaces the failure and blocks status-field editing rather than showing an empty/stale list.
- **Stale status selection**: an agent references a status that was later removed from the board — the linter flags it on the next save; existing runs are unaffected.
- **Duplicate trigger across enabled vs disabled agents**: a disabled agent sharing a trigger_status does not count as a collision; enabling it later re-triggers the linter.
- **Concurrent edits**: two team members editing the same agent/workspace — last write wins with no corruption; no cross-user locking this iteration (single shared token, small trusted team).
- **Verify succeeds but persist fails** (e.g. board became inaccessible between Verify and Save): server-side re-validation catches it and the workspace is not created.
- **Token near/at expiry at store time**: an `expires_at` in the past or within a warning window is accepted but badged immediately.
- **yaml drift after import**: editing `agents.yaml` after the one-time import has no effect on already-imported rows; the file is not a live config channel anymore.

## Requirements *(mandatory)*

### Functional Requirements

#### Access & shell

- **FR-001**: The dashboard MUST be a web application reachable behind the single shared bearer token; there are no user accounts, roles, or RBAC this iteration.
- **FR-002**: The dashboard MUST provide these screens: workspace list, workspace creation wizard, workspace settings, agents list, and agent form. The Runs tab and human-queue MAY exist only as placeholder routes.
- **FR-003**: All dashboard API calls MUST require the shared bearer token; unauthenticated calls MUST be rejected.

#### Workspace wizard & creation

- **FR-004**: The wizard MUST collect, across steps: (1) workspace name; (2) Jira site URL, email, API token (with a visible hint to create the token at id.atlassian.com), the token's **expiry date** (user-entered — Jira does not expose token expiry via API; defaulted to 1 year from today, the Atlassian maximum, with the hint to copy the date shown at token creation), and a board reference accepted as either a board id or a board URL; (3) a repositories list of `{name, git URL, default_branch}` where the first entry is the default; (4) a completion step.
- **FR-005**: The wizard MUST provide a **Verify** action that live-validates the credentials against Jira (identity check) and reads the referenced board, then displays the resolved bot display name, project key, and board type (kanban/scrum) before persisting anything.
- **FR-006**: When a board URL is provided, the system MUST extract the board id from it; if no id can be extracted, it MUST report a clear error.
- **FR-007**: The backend workspace-create operation MUST re-validate credentials and board access server-side before persisting; validation failures MUST return path-qualified, human-readable errors that the wizard surfaces inline.
- **FR-008**: On successful creation, the workspace MUST persist: name, Jira site URL, project key, board id, board type, encrypted credentials, credential `expires_at`, and the ordered repositories list (first = default).

#### Agent CRUD

- **FR-009**: The agent form MUST support the full field set: name, instruction, executor + model, `trigger_status`, `status_running` (optional but recommended by default), `status_success`, `status_failure`, `timeout_minutes`, `max_budget_usd`, `max_attempts`, `trigger_jql` (advanced), repository selection (empty = workspace default), and behavior fields (`branch_prefix` — empty inherits workspace default, `allowed_tools`, `required_checks`), plus a use-callback-channel toggle.
- **FR-010**: All status fields MUST be selects populated from a **flat** list of the board's statuses (no columns), and each selection MUST bind by both status id and status name.
- **FR-011**: The system MUST expose a statuses source that returns the board's flat status list for a workspace, and it MUST cache these to avoid excessive Jira calls while staying reasonably fresh.
- **FR-012**: On save, the system MUST run a mini-linter as **server-side** validation that: (a) rejects any status field naming a status absent from the board; (b) rejects a `trigger_status` duplicated among **enabled** agents unless their `trigger_jql` differs; (c) emits a non-blocking warning when a status cycle is detected (agent A's success status triggers agent B whose success status returns to A's trigger). The UI MUST mirror these rules client-side for immediate feedback; the server remains authoritative.
- **FR-013**: Linter and validation errors MUST be path-qualified and human-readable so the form can attach each to its field.
- **FR-014**: The agent form MUST offer a **test run by ticket key** action that triggers a manual run of that agent against the given ticket.
- **FR-015**: Deleting an agent that has completed runs MUST soft-delete it (disable, retaining history); an agent with no runs MAY be hard-deleted.

#### Source-of-truth flip

- **FR-016**: The database MUST become the primary source of truth for workspace, executor, and agent configuration.
- **FR-017**: On boot, if configuration rows are **absent**, the system MAY import the `agents.yaml` contents once; if a corresponding row already **exists**, the system MUST NOT overwrite or re-seed it from the yaml (DB wins). The yaml is an optional one-time import/template, never a live re-seeding channel.
- **FR-018**: Run queues MUST be provisioned for the fixed set of supported executor types drawn from the executor-type registry (e.g. mock, claude_cli, and future registered types), **not** derived from the yaml contents or from currently-configured agents.
- **FR-019**: An operator's existing `agents.yaml` MUST keep working via the one-time import so the upgrade requires no manual reconfiguration.

#### Credentials at rest

- **FR-020**: Jira credentials MUST be encrypted at rest (AES-256-GCM) using a key sourced from the environment; plaintext credentials MUST never be persisted.
- **FR-021**: The system MUST record credential `expires_at` at store time (source: the user-entered expiry date from FR-004/FR-024 — Jira does not expose token expiry programmatically) and surface an expiry badge with distinct warning states at 30 days and 7 days before expiry.
- **FR-022**: A pre-existing legacy plaintext credentials blob MUST be migrated to the encrypted representation on upgrade without losing the ability to authenticate.
- **FR-023**: If the encryption key is not configured, credential read/write MUST fail fast with a clear error rather than silently falling back to plaintext.

#### Settings & lifecycle

- **FR-024**: Workspace settings MUST allow token reconnect/rotation (re-verified live, replacing the stored encrypted credentials and `expires_at`), editing the advanced `scope_jql`, setting the default `branch_prefix`, and managing the repositories list.
- **FR-025**: The system MAY offer a workspace pause control **only if** it is a genuine one-field flip on the existing `enabled` column; when paused, the poller MUST stop triggering for that workspace while run history is retained.

#### Hot-reload

- **FR-026**: Creating or editing a workspace or agent MUST take effect without restarting the backend or worker: the poller and trigger paths MUST read current database state on each pass. This behavior MUST be verified and asserted, not assumed.

### Key Entities *(include if data involved)*

- **Workspace**: a connection to one Jira project/board. Attributes: name, Jira site URL, project key, board id, board type (kanban/scrum), encrypted Jira credentials, credential expiry, settings (repositories ordered with first = default, scope_jql, default branch_prefix, poller high-water mark, active sprint id), enabled flag.
- **Executor**: a way of running an agent (type + model/config + concurrency). Bound to a workspace. Its `type` determines which run queue a run lands on.
- **Agent**: a configured digital worker in a workspace. Attributes: name, instruction, executor reference, trigger_status (+ optional trigger_jql), status_running/success/failure (each bound by board status id + name), repository selection, behavior (branch_prefix, allowed_tools, required_checks, callback-channel toggle), timeout, budget, max attempts, enabled flag.
- **Board status**: a status on the bound Jira board, identified by id + name; the flat set feeds the agent form's selects and the linter's existence checks.
- **Jira credentials**: the email + API token used to authenticate as the bot; stored encrypted with an associated expiry.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A team member can create a fully working workspace (verified Jira connection, bound board, at least one repository) through the wizard in under 5 minutes without editing any file.
- **SC-002**: 100% of workspaces created through the UI persist with encrypted (non-plaintext) credentials and a recorded expiry.
- **SC-003**: A team member can add a valid agent to a workspace through the form in under 2 minutes, with status fields populated entirely from the board.
- **SC-004**: The mini-linter blocks 100% of the defined invalid cases (missing status, duplicate trigger among enabled agents without distinguishing JQL) and warns on 100% of detectable status cycles, both client-side and server-side.
- **SC-005**: An operator upgrading from an existing `agents.yaml` reaches a running system with zero manual reconfiguration, and subsequent boots never overwrite UI edits.
- **SC-006**: A newly created or edited agent/workspace is picked up on the next poller/trigger pass with no backend or worker restart (verified by test).
- **SC-007**: Run queues exist for every supported executor type on boot regardless of yaml/agent contents (verified by test).
- **SC-008**: The expiry badge shows the correct warning state at the 30-day and 7-day thresholds in 100% of tested clock positions.
- **SC-009**: Every wizard/form validation failure is presented inline against the offending field with a human-readable message (no raw stack traces or unqualified errors).

## Assumptions

- **Numbering & framing**: this is iteration 5 per `docs/plan-internal.md`; the schema in `docs/architecture.md` §3 already holds every column needed (workspaces, executors, agents) — no schema redesign, only the credentials-encryption and DB-authority behavior become due.
- **UI stack** (decision #4): the new frontend app is Vue 3 + Vite + Element Plus + Pinia + TanStack Query, and there is deliberately **no kanban board** — Jira remains the only board (decision 2026-07-11).
- **Flat statuses** (decision 2026-07-11): the statuses source returns a flat list, not board columns; agents bind statuses by id + name.
- **Scope binding** (decision #5): board type governs scope (kanban = whole board, scrum = active sprint); the wizard reports the type, but scope behavior itself is existing pipeline behavior, not new work here.
- **yaml import trigger**: the one-time import is an insert-if-absent on boot keyed on the existing natural keys (workspace name, `UNIQUE(workspace_id, name)` on executors/agents); once a row exists, the importer never updates it. This realizes "DB wins" without a separate manual import step. (The current seeder's `onConflictDoUpdate` becomes insert-if-absent.)
- **Encryption key**: a single AES-256-GCM key is provided via an environment variable; key rotation tooling is out of scope this iteration (fail-fast if the key is missing).
- **Token expiry is user-supplied**: Atlassian does not expose an API token's expiry via any API, so `expires_at` is whatever the user enters (wizard and rotation both collect it, defaulting to +1 year). The badge is therefore advisory, only as accurate as the entered date.
- **Executor/model options**: only `claude_cli` (and the `mock` executor for tests) are selectable this iteration; the executor-type registry is the source for both the model options and the provisioned queue set.
- **Test-run semantics**: "test run by ticket key" reuses the existing manual-run path against the given ticket; it does not bypass idempotency or the three-level dedup.
- **Concurrent editing**: last-write-wins with no locking, acceptable for a single-token trusted team.
- **Runs/human-queue** UI, SSE, and stats are iteration 6 and out of scope; their routes are placeholders only.

## Out of Scope

- Runs tab, ticket card, human-task queue UI, SSE live updates, and stats widgets (iteration 6).
- Users, RBAC, SSO, multi-tenant, and OAuth 3LO.
- Encryption-key rotation tooling and secret-broker/KMS integration (a single env-sourced key suffices this iteration).
- A workspace pause toggle beyond a one-field `enabled` flip; anything requiring new schema or poller work is deferred.
- Full browser end-to-end tests; component-level tests plus the operator's manual click-through are the UI acceptance gate this iteration.
- Any change to the Jira scope/poller semantics, agent execution, or callback protocol (features 002–004 own those).

## Testing Constraints

- Backend API is covered by the existing testcontainers integration pattern, including the mini-linter matrix and the DB-vs-yaml boot semantics (empty-DB import, DB-wins on existing rows, yaml-absent boot, queue provisioning from the registry).
- Wizard Jira validation (Verify, board read, error paths) is tested against the mock Jira backend.
- Frontend has component-level tests for the wizard flow and agent-form validation with the API faked; no full browser e2e this iteration.
- Credentials-at-rest is tested for: non-plaintext storage, transparent decrypt-and-authenticate, legacy-blob migration, and fail-fast on missing key.
