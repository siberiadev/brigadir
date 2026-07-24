# Feature Specification: Environment variables for agent runs

**Feature Branch**: `031-agent-env-variables`

**Created**: 2026-07-23

**Status**: Draft

**Input**: User description: "Operators need to supply environment variables to agent runs so agents can start the services they are working on, run them against real backing dependencies, and test them (e.g. DATABASE_URL, REDIS_URL, PORT, NODE_ENV, test-integration keys). Layered model decided in discussion: repository-level env is the primary home, workspace-level env is the shared default underneath it, and per-agent env is a rare targeted override. Merge precedence at run start: workspace → repository → agent, with platform-reserved keys always winning and never overridable. Storage is hybrid: non-secret values are stored and displayed openly; secret values are sealed (write-only, masked in every read surface). UI: workspace creation flow keeps its simple repository list; after creation, repositories are managed only in a dedicated Repositories block in workspace settings — a list of cards, each opened for editing in a dialog where repository fields and its env table live together; workspace-level defaults get their own small block; agent override lives in a collapsed advanced section of the agent form. Admin-MCP gets parity so a team can be assembled with env from outside the UI."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Repository and workspace env reaches the agent run (Priority: P1)

An operator configures environment variables for a repository (and optionally workspace-wide defaults shared by all repositories). The next agent run that mounts that repository starts with those variables present in its environment, so the agent can launch the service, connect it to its backing dependencies, and run its test suite without asking a human for connection strings or ports.

**Why this priority**: This is the entire point of the feature — without injection into the run, nothing else matters. Repository scope plus workspace defaults covers the dominant use case (env describes the codebase/service, not the agent persona) and is independently shippable.

**Independent Test**: Configure a variable on a repository and a different variable at workspace level, trigger a run for an agent that mounts the repository, and verify inside the run (e.g. the agent echoes the variables or a service starts on the configured port) that both values were present. Verify a run started before the change never sees it.

**Acceptance Scenarios**:

1. **Given** a repository with `PORT=3100` and workspace defaults with `NODE_ENV=test`, **When** an agent run mounting that repository starts, **Then** the agent's processes observe both `PORT=3100` and `NODE_ENV=test`.
2. **Given** a workspace default `NODE_ENV=test` and the same key on the repository set to `NODE_ENV=e2e`, **When** a run mounting that repository starts, **Then** the run observes `NODE_ENV=e2e` (repository overrides workspace).
3. **Given** an operator edits a variable while a run is in progress, **When** the running agent inspects its environment, **Then** it still sees the values fixed at its start; the edited value applies only to runs started afterwards.
4. **Given** a run that mounts two repositories whose env sets the same key, **When** the run starts, **Then** the value from the repository mounted later in the run's configured repository order wins, deterministically.
5. **Given** a workspace with no env configured anywhere, **When** runs execute, **Then** behavior is byte-for-byte identical to today (no new variables appear).

---

### User Story 2 - Secret values are write-only and never resurface (Priority: P2)

An operator adds a secret variable (e.g. `DATABASE_URL` with credentials inside) by marking it as secret when saving. From that moment the value is delivered to agent runs but can never be read back: every management surface shows only the key name and a masked placeholder, and the value never appears in run timelines, reports, logs, or Jira.

**Why this priority**: Realistic service env almost always contains credentials. Without write-only secret handling the feature would either block those cases or leak credentials into readable surfaces; but plain (non-secret) values alone (US1) already deliver value, so this is the second increment.

**Independent Test**: Save a secret variable, confirm the management API/UI returns only the key name and a secret marker (never the value), run an agent that uses it successfully, then inspect the run timeline, report, and Jira comments to confirm the raw value appears nowhere.

**Acceptance Scenarios**:

1. **Given** an operator saves a variable marked secret, **When** any read surface (settings screen, management API response, admin tooling) returns the configuration, **Then** only the key name and a "secret" indicator are returned — never the value.
2. **Given** a stored secret variable, **When** an agent run starts, **Then** the value is present in the run's environment and the agent can use it (e.g. connect to the database).
3. **Given** a stored secret value, **When** run events, tool-call records, reports, or Jira comments produced by the run are persisted, **Then** the raw secret value has been scrubbed from all of them.
4. **Given** an existing secret, **When** the operator wants to change it, **Then** they re-enter a new value (replace) or delete the row; there is no "reveal" affordance anywhere.
5. **Given** a variable saved as non-secret, **When** viewed in settings, **Then** its value is shown openly and is editable in place.

---

### User Story 3 - Repositories become editable cards in workspace settings (Priority: P2)

After a workspace is created, the operator manages its repositories in a dedicated Repositories block on the workspace settings screen: a list of cards (name, git URL, default branch, "Default" marker, and a short env summary such as "3 vars, 1 secret"). Editing a card opens a dialog holding the repository's fields together with its env table. Workspace-level env defaults live in their own small block above the cards. The workspace creation flow is unchanged (simple repository rows, no env); the workspace edit form no longer contains repository rows — the cards are the single post-creation home for repositories.

**Why this priority**: This is the management surface that makes US1/US2 usable day-to-day and removes the "two homes for one list" hazard, but the underlying capability (US1) can be exercised without it.

**Independent Test**: Create a workspace with two repositories via the creation flow, open workspace settings, verify the Repositories block lists both as cards, edit one card to add env vars and change its branch, verify persistence, and verify the workspace edit dialog no longer offers repository editing.

**Acceptance Scenarios**:

1. **Given** a workspace with configured repositories, **When** the operator opens workspace settings, **Then** a Repositories block lists one card per repository showing name, git URL, default branch, a "Default" marker on the default repository, and an env summary (count of variables and secrets).
2. **Given** a repository card, **When** the operator opens its edit dialog, **Then** they can change the repository fields and add/edit/delete env rows (key, value, secret flag) in one place, and can delete the repository or add a new one from the block.
3. **Given** the workspace edit dialog after this feature, **When** the operator opens it, **Then** it contains no repository rows; the creation flow still offers the simple repository list without env.
4. **Given** an operator enters a key reserved by the platform, **When** they attempt to save, **Then** the save is rejected with a clear message naming the reserved key, both inline in the dialog and by the backend.
5. **Given** an operator enters a malformed key (spaces, leading digit, `=` inside), **When** they attempt to save, **Then** validation rejects it with a clear message.

---

### User Story 4 - Per-agent env override (Priority: P3)

An operator opens a specific agent's form and, in a collapsed advanced section, sets env overrides for that agent only (e.g. the QA agent runs with `NODE_ENV=e2e` while everyone else uses `test`). Values set here override workspace and repository values for that agent's runs, and the override is visibly marked so it never becomes a silent surprise.

**Why this priority**: A rare targeted need; the layered model must support it, but most teams will never touch it.

**Independent Test**: Set an override on one agent for a key also defined at repository level, run that agent and one other agent against the same repository, and verify only the overriding agent's run sees the override value.

**Acceptance Scenarios**:

1. **Given** `NODE_ENV=test` at workspace level and an agent override `NODE_ENV=e2e`, **When** that agent runs, **Then** its run observes `NODE_ENV=e2e`; runs of other agents observe `test`.
2. **Given** an agent override on a key defined at a lower layer, **When** the agent form displays it, **Then** the row is marked as overriding the lower layer.
3. **Given** no overrides on an agent, **When** the operator opens the agent form, **Then** the advanced env section is collapsed and empty — zero added noise for the common case.

---

### User Story 5 - Admin-MCP parity (Priority: P3)

A human operator working with the admin tooling from outside the dashboard can supply env variables when assembling a team: repository env at workspace creation, and env management for existing workspaces/repositories/agents afterwards. Secret values follow the established pattern for sealed admin-supplied credentials: they are provided from the operator's environment and never travel through the model.

**Why this priority**: Keeps the "assemble a team for a board" flow complete without switching to the UI, but the UI path (US3) fully covers the capability.

**Independent Test**: Using admin tooling only, create a workspace with a repository carrying env, then add a secret env value to it, then verify via the read surface that the key is listed (masked) and a subsequent run observes both values.

**Acceptance Scenarios**:

1. **Given** the admin tooling, **When** creating a workspace, **Then** each repository entry may carry env rows (key, value, secret flag) that are persisted identically to UI-created ones.
2. **Given** an existing workspace, **When** the operator uses the admin tooling to set or delete env at workspace, repository, or agent scope, **Then** the change is persisted and visible (masked where secret) in all read surfaces.
3. **Given** a secret value supplied via admin tooling, **When** the tool call is inspected (model transcript, logs), **Then** the secret value itself never passed through the model's context — it is resolved from the operator's environment by the tooling.

---

### Edge Cases

- **Reserved keys**: platform-reserved keys (those the platform itself sets for auth, provider routing, callback delivery, and process bootstrap — e.g. the agent-vendor API key/base URL, `PATH`, `HOME`, SSH agent socket) are rejected at save time at every entry surface; even if legacy data contains one, injection order guarantees the platform value wins at run start.
- **Key collisions across layers**: resolved strictly by precedence (workspace → repository → agent, platform last); no warnings needed beyond the agent-form override marker.
- **Same key from two mounted repositories**: later repository in the run's mount order wins (deterministic; documented).
- **Runs without a mounted repository** (orchestrator triage and other no-repo runs): receive no operator env at all — the injection applies only to repo-mounted runs, matching how default tool permissions already behave.
- **Repository renamed**: env stays attached to the repository entry through a rename (it is part of the same entry, not keyed externally).
- **Repository deleted**: its env (including sealed secrets) is deleted with it; workspace defaults are unaffected.
- **Empty value**: allowed (`KEY=` sets an empty string — some tooling distinguishes empty from unset).
- **In-flight runs**: never affected by edits; env is fixed at run start, same as tool permissions.
- **Value size**: individual values are capped (8 KB) and the merged set is capped (64 KB total) to keep spawn environments sane; oversized saves are rejected with a clear message.
- **Encryption key unavailable / sealed blob corrupt**: runs that would need a secret fail fast with a diagnosable error before the agent starts, rather than starting with silently missing variables.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST support operator-defined environment variables at three scopes: workspace (defaults for all repositories), repository (primary home), and agent (targeted override).
- **FR-002**: At run start, the system MUST compose the run's environment by merging scopes in precedence order workspace → mounted repositories (in mount order, later wins) → agent, applied on top of the platform's baseline environment; platform-managed values (auth, provider routing, callback, process bootstrap) MUST be applied after operator env and MUST NOT be overridable by it.
- **FR-003**: Operator env MUST be injected only into repo-mounted runs; no-repo runs (e.g. orchestrator triage) receive none of it.
- **FR-004**: The merged env MUST be fixed at run start; configuration edits MUST NOT affect in-flight runs.
- **FR-005**: Each variable MUST carry a secret flag chosen at save time. Non-secret values are stored and displayed openly. Secret values MUST be write-only: persisted sealed (encrypted at rest with the platform's established credential envelope), never returned by any read surface, shown only as key name plus secret indicator, changeable only by replacement or deletion.
- **FR-006**: Every read surface (settings UI, management API, admin tooling responses) MUST mask secret values; there MUST be no reveal affordance.
- **FR-007**: Secret values MUST be registered with the output scrubber for the run so they cannot appear in persisted run events, tool-call records, reports, or Jira writes.
- **FR-008**: Raw operator env values (secret or not) MUST NOT be persisted into run timelines or logs; run detail MAY display the list of injected key names (with secret markers) for diagnosability.
- **FR-009**: Keys MUST be validated at every entry surface: POSIX-style names (letter or underscore, then letters/digits/underscores), and platform-reserved keys MUST be rejected with a message naming the key. Per-value and per-run-total size caps MUST be enforced at save time.
- **FR-010**: Workspace settings MUST gain a Repositories block: a card per repository (name, git URL, default branch, default marker, env summary), with per-card edit dialogs containing repository fields and the env table, plus add/delete repository actions. A separate small block MUST hold workspace-level env defaults.
- **FR-011**: The workspace creation flow keeps its current simple repository list (no env); the workspace edit dialog MUST no longer contain repository editing — the settings Repositories block is the single post-creation home.
- **FR-012**: The agent form MUST gain a collapsed advanced section for per-agent env; rows overriding a lower layer MUST be visibly marked.
- **FR-013**: Admin tooling MUST reach parity: repository env accepted at workspace creation, and set/delete operations for env at all three scopes on existing entities. Secret values supplied via admin tooling MUST be resolved from the operator's environment by the tooling itself and MUST NOT pass through the model's context.
- **FR-014**: With no env configured, run behavior MUST be unchanged from today (backward compatibility; existing workspaces need no migration action).
- **FR-015**: All merge, precedence, reserved-key, fixation, and scrubbing behavior MUST ship with automated tests in the same change, including a test proving the platform's sanitized-environment floor is not widened by this feature.

### Key Entities

- **Environment variable entry**: key (validated name), value, secret flag; belongs to exactly one scope instance.
- **Workspace env defaults**: the set of entries scoped to a workspace as a whole; applies to every repo-mounted run of that workspace.
- **Repository env**: the set of entries attached to one repository entry of a workspace; applies to runs mounting that repository; lives and dies with the repository entry.
- **Agent env override**: the set of entries attached to one agent; applies only to that agent's runs; highest operator precedence.
- **Sealed secret store**: the encrypted-at-rest holder of all secret values of a workspace (workspace, repository, and agent scopes), write-only through every API.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can take a service that needs three environment variables (one secret) from "not configured" to "an agent run starts the service and its test suite passes" using only the settings screen, in under five minutes, without editing any host files or restarting the platform.
- **SC-002**: 100% of runs started after a configuration change observe the new values; 0% of runs started before it do.
- **SC-003**: Raw secret values appear in zero read surfaces and zero persisted run artifacts (timelines, reports, Jira comments) across a full run lifecycle that actively uses the secret.
- **SC-004**: 100% of attempts to save a platform-reserved or malformed key are rejected with a message that names the offending key, at both the UI and the API boundary.
- **SC-005**: Workspaces with no env configured show zero behavioral difference in their runs after the feature ships.

## Assumptions

- Env values run with the same trust level as the run itself: the platform runs in a trusted-team posture (no sandboxes), so a configured value (e.g. a database URL) is usable by the agent with host-level reach. Operators are expected to point env at test/staging resources by convention; this is documented, not enforced.
- Only repo-mounted runs receive operator env (mirrors how default tool permissions apply only to repo-mounted runs). Workspace-setup runs are repo-mounted and therefore receive it.
- Multi-repository collision resolution "later mount wins" is acceptable because mount order is operator-controlled and deterministic.
- Secret values are sealed with the platform's existing credential envelope and key; no new key-management mechanism is introduced. The constitution's "secrets never in the agent process environment" principle is understood to govern *platform* secrets (run tokens, vendor API keys, git credentials) — operator-supplied service env is *intended for* the agent process by definition, is scoped to what the operator explicitly chose to hand over, and is scrubbed from all outputs (FR-007). The constitution amendment note should record this narrowing, as was done for the feature-015 repo-access narrowing.
- The run-detail "injected key names" list (FR-008) is a MAY for the first release; it can ship in a follow-up without weakening the core guarantees.
- Renaming a repository preserves its env because env is part of the repository entry itself.
