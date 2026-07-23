# Feature Specification: Agent role instruction templates from a git repository

**Feature Branch**: `030-agent-role-templates`

**Created**: 2026-07-23

**Status**: Draft

**Input**: User description: "Agent instruction templates from a git repository (feature 030). Operators want curated, reusable per-role instruction templates (agent.md files) that live in a git repository, so teams sound consistently strong across boards while each instruction stays project-specific. Source resolution: workspace override ?? global setting ?? built-in default set. Templates are used in reference mode (brigadir adapts, never copies verbatim). Includes executor choice by approximate model hint, sealed token support for private repos, and management surfaces (dashboard + admin-MCP)."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Team generation grounded in built-in role templates (Priority: P1)

An operator triggers team generation ("generate agents") for a workspace. The orchestrator agent, while studying the project, sees a catalog of available role templates (developer, QA, reviewer, planner) with one-line descriptions. It retrieves the full text of the roles it deems relevant, adapts each to the concrete project it just studied (real gate commands, per-repo rules, conventions), and delivers a team whose instructions are grounded in the curated templates instead of being invented from scratch. Each template also carries an approximate model hint, which the orchestrator maps to the closest available executor profile when assigning executors.

**Why this priority**: This is the core value — consistent, high-quality role instructions across all boards — and it works end-to-end with zero external dependencies (no network, no secrets). Everything else (git sources, management UI) builds on this flow.

**Independent Test**: Trigger a team-generation run on a workspace with no external template source configured. Verify the run's timeline shows the catalog was listed and role bodies were fetched, and that the delivered team's instructions demonstrably derive from the built-in templates (role structure, completion contract, escalation rules) while carrying project-specific detail.

**Acceptance Scenarios**:

1. **Given** a workspace with no template source configured anywhere, **When** a team-generation run executes, **Then** the orchestrator is presented with the built-in template catalog (at least developer, QA, reviewer, planner) and can retrieve each template's full body on demand.
2. **Given** the orchestrator has retrieved a role template, **When** it delivers the team, **Then** the created agents' instructions are adaptations of the template (project-specific commands and rules filled in), not verbatim copies and not unrelated free-form text.
3. **Given** a role template carries an approximate model hint (e.g. "opus", "deepseek"), **When** the orchestrator assigns executors, **Then** each agent references an existing enabled executor profile by its exact name, chosen as the closest match to the hint, and any substitution (no close match available) is noted in the run's final summary.
4. **Given** a role template's hint matches nothing available, **When** the orchestrator assigns executors, **Then** team delivery still succeeds with the closest available profile — the run never blocks on a hint.

---

### User Story 2 - Curated templates from an operator-provided git repository (Priority: P2)

An operator points the platform (globally) or a single workspace (override) at a git repository containing role template files. From the next team-generation run on, the orchestrator's catalog comes from that repository instead of the built-in set. A workspace-level source takes precedence over the global one; removing the override falls back to the global source, and removing both falls back to the built-in set. Private repositories are supported via an access token that the operator submits once and the platform stores sealed; the token is never displayed again and never reaches the agent.

**Why this priority**: This is the reason the feature exists — operators curate their own role library in git (review, versioning, sharing across installations) — but it is only valuable once the P1 catalog/consumption flow works.

**Independent Test**: Configure the global template source to a real repository (e.g. the team's agents repo), run team generation, and verify the catalog now lists that repository's roles. Break the URL and verify the run still completes using built-in templates with a visible diagnostic.

**Acceptance Scenarios**:

1. **Given** a global template source pointing at a reachable repository with valid role files, **When** a team-generation run executes, **Then** the catalog contains exactly that repository's roles and the run consumes their bodies.
2. **Given** both a global source and a workspace-level override, **When** a run executes in that workspace, **Then** the override's roles are used; **and When** the override is removed, **Then** the next run uses the global source again.
3. **Given** a private repository and a stored access token, **When** a run executes, **Then** templates are fetched successfully and the token never appears in any run log, timeline event, agent-visible text, or API response.
4. **Given** a configured source that is unreachable, empty, or malformed, **When** a run executes, **Then** the run proceeds with the built-in templates and the degradation is visible in the run's diagnostics — team generation is never blocked by the template source.
5. **Given** an operator submits a source location that is not an allowed repository address (e.g. a local file path), **When** the configuration is saved, **Then** it is rejected with a clear validation error.

---

### User Story 3 - Managing template sources from the dashboard and admin tooling (Priority: P3)

An operator manages template sources without touching the database: a global section in the platform settings (repository address, optional branch/tag, optional folder, access token) and a per-workspace override block in workspace settings with the same fields, plus clear indications of which source is currently effective ("this workspace uses: override / global / built-in"). Tokens are write-only: the UI shows only whether one is stored, with actions to replace or clear it. The same configuration is possible through the admin automation channel used to create workspaces.

**Why this priority**: Pure convenience layer over P2 — the capability already works via API before this lands, so it is valuable but last.

**Independent Test**: Through the dashboard alone, set a global source, override it on one workspace, verify the effective-source indicator on both, replace and clear a token, and reset the workspace back to the global source.

**Acceptance Scenarios**:

1. **Given** the global settings section, **When** the operator saves a repository address (with optional branch and folder), **Then** subsequent team-generation runs across all workspaces without overrides use it, and the saved values (except the token) are visible on return.
2. **Given** a workspace settings page, **When** the operator sets an override, **Then** the page indicates the override is effective for this workspace; **and When** the operator resets it, **Then** the page indicates the global (or built-in) source is effective.
3. **Given** a stored token, **When** the operator views the settings, **Then** only the fact that a token exists is shown (never its value), with replace and clear actions behaving as expected on the next run.
4. **Given** the admin automation channel, **When** a workspace is created with a template source attached, **Then** that workspace's runs use it, and any token involved comes from the operator's own environment — never from the automated client's message content.

---

### Edge Cases

- **Template file with no metadata header**: the file is still usable — its role name derives from the file name and its catalog description is empty.
- **Duplicate role slugs** (same file name in the configured folder): the source is treated as malformed for that slug; one deterministic winner is used and the collision is noted in diagnostics.
- **Oversized template body or oversized catalog**: bodies and catalog text are truncated at documented caps with a visible truncation marker, never silently dropped; a source exceeding the file-count cap is truncated deterministically (documented order) with a diagnostic.
- **Source repository changes between runs**: each run observes the repository's state at run start (fresh fetch); no caching staleness beyond a single run is acceptable when the source is reachable.
- **Pinned branch/tag does not exist**: treated as an unreachable source — fall back to the next source in the chain with a diagnostic.
- **Token stored but source removed**: the stored token is inert; configuring a new source does not silently reuse a token the operator believes deleted — clearing the source offers to clear the token.
- **Concurrent runs in different workspaces with different sources**: each run resolves its own workspace's effective source independently; no cross-workspace leakage of catalogs or tokens.
- **Agent asks for a slug that does not exist**: the retrieval fails with a clear "unknown role" error listing available slugs; the run continues.

## Requirements *(mandatory)*

### Functional Requirements

**Template catalog & format**

- **FR-001**: The system MUST maintain a catalog of role templates, where each template has a unique slug, a human-readable role label, an optional one-line description, an optional approximate model/executor hint, an optional trigger-status hint, and a body (the role prompt text).
- **FR-002**: The system MUST ship a built-in default template set covering at least the roles developer, QA, reviewer, and planner, in the same file layout and format as external repositories, so built-in and external sources are interchangeable.
- **FR-003**: Template files MUST be readable with or without a metadata header; absent metadata, the role label falls back to the slug and other metadata fields are empty.

**Source resolution**

- **FR-004**: The system MUST resolve the effective template source per workspace in strict precedence order: workspace-level override, then global platform setting, then built-in defaults.
- **FR-005**: A template source MUST be describable by a repository address, an optional branch/tag/revision pin, and an optional folder within the repository; only repository address forms over approved remote protocols are accepted (local file-system sources are rejected at validation time).
- **FR-006**: The effective source for each team-generation run MUST be resolved at run start and reflect the repository's then-current state for the pinned revision (or default branch when unpinned).

**Delivery to the team-generation run**

- **FR-007**: The team-generation run MUST be able to list the catalog (slugs, role labels, descriptions, hints, source identification) and retrieve any single template's full body on demand; retrieval of an unknown slug fails with an error naming the available slugs.
- **FR-008**: The team-generation context MUST include a bounded catalog summary (which templates exist and where they came from) so the orchestrator knows the library exists without receiving all bodies up front.
- **FR-009**: The orchestrator's team-generation guidance MUST direct it to consult the catalog, retrieve relevant roles, adapt each template to the studied project (concrete commands, per-repo rules), skip irrelevant roles, and never deliver a verbatim, un-adapted copy.
- **FR-010**: The orchestrator's team-generation guidance MUST direct it to treat the model hint as approximate: map it to the closest enabled executor profile (by capability/provider match and the role's needs), always return an exact existing profile name, note substitutions in the final summary, and never block on a missing match.
- **FR-011**: Delivered team members' instructions MUST continue to flow through the existing team-delivery validation and persistence path unchanged; this feature adds inputs to the generation step only and does not alter how stored instructions are used at run time.

**Secrets & access**

- **FR-012**: The system MUST support an optional access token per source (workspace-level and global) for private repositories, stored sealed at rest using the platform's existing secret-sealing mechanism.
- **FR-013**: Token write semantics MUST be tri-state: absent means keep the current token, empty means clear it, a value means replace it; read surfaces MUST expose only whether a token is stored, never its value.
- **FR-014**: The token MUST never appear in process argument lists, in the agent's environment or visible context, in run logs or timeline events, or in any API response.

**Failure posture & bounds**

- **FR-015**: A configured source that is unreachable, malformed, empty, or over its caps MUST NOT block team generation: the system falls back to the next source in the precedence chain (ultimately built-ins) and records a diagnostic visible on the run.
- **FR-016**: The system MUST enforce documented caps on template file count, individual body size, and source-fetch time; cap violations degrade deterministically (documented truncation order, visible markers) rather than failing the run.

**Management surfaces**

- **FR-017**: Operators MUST be able to view and edit the global template source (address, pin, folder, token per FR-013) in the platform's general settings, and the workspace override in each workspace's settings, including resetting an override back to the global source.
- **FR-018**: Each workspace's settings MUST indicate which source is currently effective for it (override, global, or built-in).
- **FR-019**: The admin automation channel MUST support attaching a template source when creating a workspace and setting/clearing a source afterwards; any token supplied via this channel MUST originate from the operator's own configuration, never from the automated client's message arguments.
- **FR-020**: The platform's data-schema documentation MUST be updated in the same change as any storage-shape change, per the project's schema-governance rule.

### Key Entities

- **Role template**: A curated role prompt — slug (identity within a source), role label, description, approximate model hint, trigger-status hint, body. Exists in three interchangeable source forms (built-in, global repo, workspace repo).
- **Template source**: A pointer to where templates come from — repository address, optional revision pin, optional folder, optional sealed token. Exists at two configuration levels (global, per-workspace) plus the implicit built-in level.
- **Effective source resolution**: The per-workspace, per-run outcome of the precedence chain, including any fallback that occurred and its diagnostic.
- **Catalog**: The run-facing projection of the effective source — the list of template summaries plus source identification, bounded for inclusion in the run context.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With no configuration at all, a team-generation run on a fresh workspace produces a team whose every instruction traces to a built-in role template (structure and invariants recognizably present), with zero network access to external template sources.
- **SC-002**: An operator can point the platform at a template repository and see it take effect on the very next team-generation run, without restarting anything.
- **SC-003**: 100% of team-generation runs complete even when the configured template source is broken (unreachable, malformed, wrong pin), with the degradation visible in run diagnostics.
- **SC-004**: In every generated team, 100% of agents reference an existing enabled executor profile by exact name, regardless of what the templates' model hints say.
- **SC-005**: A stored access token is never observable after submission: not in any API response, run log, timeline entry, or agent-visible text, across all runs and management operations.
- **SC-006**: An operator can fully manage sources (set global, override one workspace, verify the effective source, replace and clear a token, reset to global) through the dashboard alone in under five minutes without documentation.
- **SC-007**: Templates are consumed as references, not copies: generated instructions contain project-specific content (real commands/paths from the studied project) beyond the template text in every delivered team.

## Assumptions

- The transport decision is fixed: the platform fetches template repositories server-side and the team-generation agent consumes templates lazily through its existing tool channel — the agent never clones the template repository itself and never holds repository credentials.
- Reference (adapt) mode is the only consumption mode in this feature; verbatim template pinning is explicitly out of scope (listed under non-goals by the requester).
- Template file layout follows the agreed convention: one file per role in a `roles/` folder (or the configured folder), file name = slug, optional metadata header + prompt body; a real reference repository following this convention already exists for acceptance testing (`git@github.com:siberiadev/agents.git`).
- Existing platform mechanisms are reused rather than re-invented: the established secret-sealing envelope for tokens, the established repository-caching/fetch pattern for cloning, the existing run-scoped tool channel for delivery, and the existing team-delivery validation path for persistence.
- The stored role instruction remains the run-time source of truth for worker agents; template changes affect future team generation only, never already-created agents.
- Templates arriving from an operator-configured repository are trusted at the operator's level (the operator controls the URL); the platform does not attempt content moderation of template bodies beyond size/format caps.
- Built-in default template content will mirror the reference repository's four roles at feature completion; keeping the two sets in sync afterwards is an operational concern, not a system guarantee.

## Non-Goals

- Verbatim template mode (pinning an agent's instruction to exact template text with no adaptation).
- Any change to how existing agents' stored instructions are used at run time.
- A template editing UI — the git repository is the editor.
- Automatic synchronization or migration of already-generated agent instructions when templates change.
