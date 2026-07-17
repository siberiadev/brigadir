# Feature Specification: Configurable Default Brigadir Agent + Repo-Mounted Setup Runs

**Feature Branch**: `claude/brigadir-agent-repo-setup-63b0c9`

**Created**: 2026-07-17

**Status**: Draft

**Input**: User description: "Configurable default brigadir agent template in platform settings (new 'Brigadir agent' section holding an editable template that seeds every NEW workspace's orchestrator) + repo-mounted setup runs (workspace-setup runs get a 'fat' environment — default repo mounted, strong model, larger turn budget — while triage runs stay cheap and repo-less)."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Edit the default brigadir template once, get correctly configured orchestrators in every new workspace (Priority: P1)

An operator who prefers a specific orchestrator configuration (a different executor profile, tighter budget limits, an adjusted routing instruction, a custom persona name) opens Settings → Brigadir agent, edits the template, and saves. Every workspace created afterwards is seeded with an orchestrator matching the template exactly — no per-workspace manual reconfiguration. Workspaces that already exist are untouched.

**Why this priority**: This is the core pain today — after every workspace creation the operator has to open the seeded brigadir and manually re-apply the same edits (model/executor, behavior, limits). The template removes that repeated work and is also the storage foundation the setup-run environment (User Story 2) composes with.

**Independent Test**: Edit the template (e.g., change `max_budget_usd` and the routing instruction), create a new workspace, and verify the seeded orchestrator carries the edited values; verify a pre-existing workspace's orchestrator is unchanged.

**Acceptance Scenarios**:

1. **Given** the template has never been edited, **When** the operator opens Settings → Brigadir agent, **Then** every field shows the built-in default values (name "brigadir", role "teamlead", the built-in orchestrator executor profile, both built-in instruction texts, default limits, enabled).
2. **Given** the operator edits template fields (limits, instruction, executor profile) and saves, **When** a new workspace is created (wizard, config-file seeding, or startup backfill), **Then** the seeded orchestrator's fields equal the saved template values.
3. **Given** a workspace existed before the template was edited, **When** the template is saved, **Then** that workspace's orchestrator agent is not modified in any way (SC-006 semantics of feature 010).
4. **Given** the operator enters an out-of-bounds value (e.g., a negative budget, zero max attempts) or references a non-existent executor profile, **When** they save, **Then** the save is rejected with a field-level validation error and nothing is persisted.
5. **Given** the template references an executor profile that has since been deleted or disabled, **When** a new workspace is created, **Then** workspace creation still succeeds: the orchestrator is seeded on the built-in orchestrator profile (recreated if absent) and a warning is surfaced to the operator.

---

### User Story 2 - Setup runs recon the actual repository and generate project-specific teams (Priority: P2)

An operator connects a repository to a workspace and clicks "Generate agents". The setup run now executes in a "fat" environment: the workspace's default repository is mounted (with git and shell access), a more capable model is used, and the turn budget is large enough for repository recon. Brigadir actually reads AGENTS.md / README / CLAUDE.md / the spec-kit constitution and the real gate commands, and the generated team's instructions are grounded in project specifics instead of generic role descriptions. Triage runs (failed-run routing) are unaffected: still cheap, still repo-less, still without git credentials.

**Why this priority**: The recon branch of the setup protocol already exists but is dormant because setup runs today ride the cheap no-repository triage environment — so generated teams are weak and generic. This story activates the dormant capability; it depends on the template (User Story 1) as the natural home for the setup execution profile.

**Independent Test**: In a workspace with a connected default repository, trigger "Generate agents" and verify the run executes with the repository mounted and on the setup execution profile; verify the generated agents' instructions contain repository-specific facts (real commands, real conventions). Separately trigger a triage run and verify it still runs repo-less on the cheap profile.

**Acceptance Scenarios**:

1. **Given** a workspace with a connected default repository, **When** a setup run (trigger source `workspace-setup`) starts, **Then** the run's environment is resolved from the template's setup execution profile: the default repository is mounted with git and shell access, a more capable model is used, and the turn budget is larger than the triage budget.
2. **Given** a setup run with the repository mounted, **When** the run completes (any outcome), **Then** its working copy and any `.repos/<name>` clones inside it are cleaned up exactly like a regular run's workspace, and no push to any remote has occurred.
3. **Given** the same workspace, **When** a triage run (failed worker run or human answer) starts, **Then** it executes exactly as before this feature: cheap profile, no repository, no git credentials.
4. **Given** a workspace with NO default repository configured, **When** a setup run starts, **Then** it proceeds without a mounted repository (the existing best-effort, bounded recon wording of the setup protocol already covers this) and the run completes normally.
5. **Given** the template's setup execution profile references an executor profile that was deleted or disabled, **When** a setup run starts, **Then** the run falls back to the built-in setup profile (recreated if absent) and a warning is recorded on the run.

---

### User Story 3 - Both brigadir instruction texts live in the new section, with reset-to-default, and survive the move (Priority: P3)

An operator who previously edited the routing and/or agent-creation instruction in Settings → General finds both texts — with their current (possibly edited) values — in Settings → Brigadir agent after the upgrade. Each text keeps its individual "Reset to default" button, and the whole template gains a "Reset all to defaults" action. Settings → General now contains only the Theme control.

**Why this priority**: This is a relocation plus polish of behavior shipped in iteration 20; it carries no new capability on its own but is required for the settings surface to stay coherent (one home for everything brigadir).

**Independent Test**: Edit an instruction in the current General section (pre-upgrade state simulated by a stored value), upgrade, open Settings → Brigadir agent and verify the edited text is shown; verify per-field reset restores the built-in text; verify "Reset all" restores every template field; verify General shows only Theme.

**Acceptance Scenarios**:

1. **Given** a stored (operator-edited) routing instruction and agent-creation instruction, **When** the operator opens Settings → Brigadir agent after this feature ships, **Then** both fields show the stored values (no data loss from the move).
2. **Given** the Brigadir agent section is open, **When** the operator clicks "Reset to default" on one instruction field, **Then** only that field reverts to the built-in text (unsaved until the operator saves).
3. **Given** the Brigadir agent section is open, **When** the operator invokes "Reset all to defaults" and confirms, **Then** every template field reverts to built-in defaults (unsaved until the operator saves).
4. **Given** this feature has shipped, **When** the operator opens Settings → General, **Then** only the Theme control is present; the two instruction textareas are gone.
5. **Given** the agent-creation instruction is edited and saved in the new section, **When** the next setup run starts in ANY workspace, **Then** that run uses the new text (live-read semantics preserved from iteration 20).

---

### Edge Cases

- **Template executor deleted/disabled at workspace-creation time**: creation must not fail — fall back to the built-in orchestrator profile (insert-if-absent) and surface a warning (see US1 scenario 5, FR-010).
- **Setup executor deleted/disabled at run start**: run must not fail on resolution — fall back to the built-in setup profile (insert-if-absent) and record a warning on the run (FR-018).
- **Corrupt or schema-invalid stored template** (e.g., hand-edited in the database): the system behaves as if the template were unset — built-in defaults apply everywhere, a warning is logged, and the settings UI shows defaults; the next successful save overwrites the corrupt value (FR-011).
- **Workspace with no default repository**: setup run proceeds repo-less; the setup protocol's existing "best-effort, bounded recon" wording covers the degraded mode; no error (FR-017).
- **Clone slowness/failures during recon**: recon is bounded and best-effort per the existing protocol text; the setup run's default timeout must be generous enough to accommodate cloning connected repositories (FR-019).
- **Setup run and pushing**: a setup run never pushes — no system push path, local-only working branch, read-only protocol instruction (FR-015).
- **Ticketless repository-mounted run**: setup runs have no ticket; today a repository working copy is branch-named after the ticket, so the system must support preparing a repository working copy for a ticketless run (FR-020). It must not reuse the "config error" path that currently rejects ticketless repo runs.
- **Concurrent template saves**: last write wins (key-value upsert semantics, consistent with the existing general-settings behavior); no locking is required for this internal tool.
- **Template `enabled=false`**: new workspaces are seeded with a disabled orchestrator; the existing semantics of a disabled agent apply unchanged (no new behavior).
- **Reset semantics vs. running system**: resetting/saving the template never touches existing workspaces' agents; only future workspace creation (copy-at-creation fields) and future setup runs (live-read fields) observe the change.

## Requirements *(mandatory)*

### Functional Requirements

**Block 1 — Brigadir agent template in platform settings**

- **FR-001**: Platform Settings MUST gain a third sub-section "Brigadir agent" alongside General and Executors, holding the editable template of the default orchestrator agent.
- **FR-002**: The template MUST expose these editable fields, pre-filled with the current built-in defaults: persona name (default "brigadir"), role (default "teamlead"), triage executor profile (referenced by profile name; default the built-in orchestrator profile), routing instruction (the template's `instruction`), behavior (including workspace mode; default "no repository"), timeout minutes, max budget (USD), max attempts, and enabled (default on). "Exposed as a template field" constrains the editing surface, not the storage layout — how values are stored is a design decision, provided previously stored values survive (FR-005).
- **FR-003**: Agent-form fields that make no sense for the orchestrator MUST NOT appear in the template: trigger status and trigger JQL (the orchestrator is never poll-triggered), and the running/success/failure status mappings (a completed orchestrator run takes no generic transition; the stored values remain the inert "—" placeholder and are not operator-editable).
- **FR-004**: The agent-creation (workspace setup) instruction MUST also live in the Brigadir agent section, preserving its live-read lifecycle: an edit affects the very next setup run in every workspace.
- **FR-005**: Settings → General MUST retain only the Theme control. The two instruction texts move out; the general-settings read/write contract is updated accordingly, and all its consumers and tests are updated in the same change. Previously stored instruction values MUST survive the move (the operator sees their edited texts in the new section; no data migration may lose them).
- **FR-006**: Reset-to-default MUST be available (a) per instruction field — both texts keep their individual reset restoring the built-in default — and (b) for the whole template via a single confirmed "Reset all to defaults" action restoring every field. Resets take effect only on save.
- **FR-007**: The template MUST be stored as a single versioned JSON document in the existing global key-value settings store, with its schema defined in the shared contracts package. No new tables or schema changes to the database (architecture §3 remains as-is).
- **FR-008**: Saving the template MUST validate: referenced executor profiles exist and are enabled; numeric limits are within the same bounds enforced by the regular agent form; persona name and role are non-empty. Invalid saves are rejected with field-level errors and persist nothing.
- **FR-009**: Creating a NEW workspace (wizard, configuration-file seeding, startup backfill) MUST seed the orchestrator agent from the current template values (copy-at-creation). Existing workspaces are never modified by template edits. Seeding remains insert-if-absent and race-safe as today.
- **FR-010**: If the template's triage executor profile is deleted or disabled at workspace-creation time, workspace creation MUST still succeed: the orchestrator is seeded on the built-in orchestrator profile (recreated if absent), and a warning is surfaced to the operator (creation response and log).
- **FR-011**: If the stored template value is corrupt or fails schema validation on read, the system MUST behave as if the template were unset (built-in defaults apply), log a warning, and let the next successful save overwrite the bad value. Reads never fail because of a bad stored template.

**Block 2 — Repo-mounted setup runs (fat setup, thin triage)**

- **FR-012**: The template MUST carry two execution profiles: **triage** (executor profile + behavior; copied into the seeded agent at workspace creation) and **setup** (executor profile + behavior; read live by setup runs). This is the chosen mechanism (option (a) of the feature description): it composes with Block 1's template and keeps the run-environment decision declarative rather than hard-coded per trigger source.
- **FR-013**: Runs with trigger source `workspace-setup` MUST resolve their execution environment from the template's setup profile, read live at run start: a more capable model, a larger turn budget than triage, and a repository-mounted workspace with git and shell access.
- **FR-014**: A setup run in a workspace with a default repository MUST get that repository mounted as its working directory; additional connected repositories are cloned by the agent into `.repos/<name>` inside the run's working copy per the existing protocol. Cleanup of the working copy (including `.repos/` clones) MUST be identical to regular runs.
- **FR-015**: Setup-run repository access MUST be read-only in effect: the system never commits to a remote, pushes, or opens PRs from a setup run; the setup run's working branch stays local to the runner; the setup protocol instructs read-only recon; and no push capability is granted beyond the credential posture every repository-carrying run already shares. (The shared git channel cannot technically distinguish fetch from push — enforcement is behavioral and uniform with worker runs; the plan records this honestly.)
- **FR-016**: Triage runs MUST be unaffected: they keep the cheap executor profile, no repository, and no git credentials. The "orchestrator has no repository and no git credentials" principle (feature 010 FR-018, Constitution V) is hereby narrowed to **triage runs**; the implementation plan's Constitution Check MUST record this narrowing and its justification explicitly.
- **FR-017**: A setup run in a workspace with NO default repository MUST proceed without a mounted repository and complete normally; the setup protocol's existing best-effort/bounded recon wording covers the degraded mode (the protocol text itself needs no change).
- **FR-018**: If the setup profile's executor is deleted or disabled at run start, the run MUST fall back to the built-in setup profile (recreated if absent) and record a warning on the run rather than failing.
- **FR-019**: Built-in defaults for the setup profile MUST exist in the shared contracts defaults (alongside the existing instruction defaults): a more capable model tier than triage, a substantially larger turn budget, and a run timeout generous enough to accommodate cloning connected repositories. Exact model identifiers and numbers are an implementation-plan decision.
- **FR-020**: The system MUST support preparing a repository-mounted working copy for a **ticketless** run (setup runs have no ticket). The existing rejection of ticketless repository runs as a configuration error MUST NOT apply to setup runs.

**Cross-cutting**

- **FR-021**: All new pipeline-path logic (template-based seeding, template read/write endpoint, setup-run environment resolution and fallback) MUST ship with automated tests in the same change: unit tests plus integration tests against real infrastructure for seeding and settings persistence, and web tests for the new settings section and both reset behaviors (Constitution VI).

### Key Entities

- **Brigadir agent template**: a single global, versioned document describing how every new workspace's orchestrator is seeded — identity (persona name, role), routing instruction, triage execution profile, setup execution profile, limits (timeout, budget, attempts), and enabled flag. Stored in the global settings store; schema owned by the shared contracts package.
- **Triage execution profile** (within the template): executor profile reference (by name) + behavior for routing/triage runs. Copy-at-creation lifecycle: baked into the seeded agent; later template edits affect only future workspaces.
- **Setup execution profile** (within the template): executor profile reference (by name) + behavior for workspace-setup runs. Live-read lifecycle: resolved at every setup-run start; edits affect the next setup run in every workspace.
- **Agent-creation (workspace setup) instruction**: existing global text, relocated into the Brigadir agent section; live-read lifecycle unchanged.
- **Built-in setup executor profile**: a seeded, insert-if-absent executor profile for setup runs (capable model, large turn budget, repository-mounted), sibling of the existing built-in orchestrator (triage) profile; serves as the fallback target for FR-018.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After editing the template, an operator creating a new workspace needs **zero** manual edits to the seeded orchestrator to match their intended configuration (today: every field they care about must be re-edited per workspace).
- **SC-002**: Template edits and resets modify **zero** agents in workspaces that existed before the edit (verified by comparing orchestrator rows before/after a template save).
- **SC-003**: In a workspace with a connected repository, a "Generate agents" run demonstrably performs repository recon: the generated agents' instructions contain repository-specific facts (actual gate commands, actual conventions) rather than only generic role text, and the run's report/summary references files it read from the repository.
- **SC-004**: Triage-run cost and environment are unchanged: 100% of triage runs continue to execute without a repository and without git credentials, on the cheap profile.
- **SC-005**: Zero setup runs push to any remote repository (the system has no push path for setup runs, and the setup run's working branch never leaves the runner).
- **SC-006**: After upgrading, 100% of previously stored (operator-edited) instruction texts are visible and editable in the new Brigadir agent section — no data loss from the settings move.
- **SC-007**: A deleted or disabled referenced executor profile never fails a workspace creation or a setup run: in both cases the operation completes on the built-in fallback profile and a warning is visible to the operator.

## Assumptions

- **Internal tool, atomic contract change**: BRIGADIR is a single-deployment internal tool; changing the general-settings read/write contract (removing the two instruction fields) together with its web consumers and tests in the same release is acceptable. No external API consumers exist.
- **Stored-value continuity over key migration**: the existing stored values for the two instruction texts are preserved by continuing to honor their existing storage keys (or migrating them into the template document on first read/save) — the spec requires only the outcome (FR-005: no visible data loss); the mechanism is a plan decision.
- **Two lifecycles are intentional**: copy-at-creation for identity/triage/limits (mirrors feature 010 SC-006) vs. live-read for the setup instruction and setup execution profile (mirrors iteration 20's live-read setup instruction). The asymmetry follows what each value is for: seeded agent rows vs. per-run environment.
- **Exact model identifiers, turn budgets, and timeout numbers** for the built-in setup profile are implementation-plan decisions; the spec constrains only their relationships (setup ≥ more capable and longer than triage; timeout accommodates clones).
- **The setup protocol text needs no change**: its recon branch already says "IF this run has repository access" and "best-effort and bounded" — this feature activates that branch rather than rewording it.
- **Enabled-flag semantics unchanged**: the template's `enabled` maps to the seeded agent's existing `enabled` field; how a disabled orchestrator behaves (triage/setup triggering) is not changed by this feature.
- **Constitution impact is confined to narrowing**: Constitution V (secret isolation) continues to hold — setup runs receive read-only repository access without push credentials, and run secrets stay out of the agent's reach exactly as for regular worker runs. The feature-010 principle "orchestrator has no repository" is narrowed to triage runs; the plan's Constitution Check must record this honestly (FR-016).
- **UI conventions apply as-is**: the new settings sub-section follows the existing settings navigation, theming (brand palette via CSS variables), and component conventions; no pagination is involved (single-document form).
