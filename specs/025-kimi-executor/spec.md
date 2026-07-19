# Feature Specification: First-class kimi executor type (Moonshot AI backend) reusing the Claude CLI harness

**Feature Branch**: `025-kimi-executor`

**Created**: 2026-07-19

**Status**: Draft

**Input**: User description: "First-class kimi executor type (Moonshot AI backend) reusing the Claude CLI harness — a new executor type `kimi` whose implementation is the existing Claude CLI harness parameterized by a provider preset (Moonshot's Anthropic-compatible endpoint + profile-stored API key), with its own run queue, immutable run attribution, api_key-only auth, and no user-facing base-URL field."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Runs execute on Moonshot Kimi models, configured entirely from the dashboard (Priority: P1)

The team wants pipeline agents to run on Moonshot AI's Kimi models (flagship `kimi-k3`, also `kimi-k2.7` variants) as an alternative backend to Anthropic. An operator opens the dashboard, creates an executor profile of the new type "kimi", fills in a name, a model (e.g. `kimi-k3`), the Moonshot API key (write-only secret), the parallel-run limit, and the familiar harness knobs (CLI path, callback channel toggle, keep-failed-worktrees, max turns). There is deliberately **no base-URL field anywhere** — the Moonshot endpoint is a fixed property of the type itself. An agent is pointed at this profile exactly the way agents reference any executor profile today, and its runs execute end-to-end against Moonshot: same worktree preparation, same prior-work branch continuation, same callback channel and report enforcement, same failure handling.

**Why this priority**: This is the entire reason the feature exists — a second model provider for pipeline agents with zero new harness machinery. Everything else in this spec protects or supports this flow.

**Independent Test**: Create a kimi profile via the dashboard/API only, attach an agent to it, trigger a run; the run must be attributed to the kimi type, travel through the kimi run queue, spawn the agent against the Moonshot endpoint with the profile's key, and complete with a schema-valid report.

**Acceptance Scenarios**:

1. **Given** an operator with a valid Moonshot API key, **When** they create an executor profile of type "kimi" with name, model, key, and harness knobs via the dashboard or API, **Then** the profile is saved with the key stored write-only (never echoed back; presence signaled by a boolean) and appears in the executor list as type "kimi".
2. **Given** an agent referencing a kimi profile, **When** a run is triggered for it, **Then** the run is recorded with executor type "kimi", enqueued on the kimi-specific run queue, and the spawned agent process talks to the Moonshot Anthropic-compatible endpoint using the profile's decrypted key.
3. **Given** a kimi run in flight, **When** it progresses through the pipeline, **Then** worktree preparation, prior-work branch continuation, ticket scoping, the callback channel with report enforcement, output-stream parsing, rate-limit handling, process-group termination, and budget checks all behave identically to a Claude CLI run — the harness is shared, only the provider endpoint and key differ.
4. **Given** a kimi profile, **When** the operator inspects or edits it in the dashboard, **Then** no base-URL field is shown or accepted anywhere — the endpoint is not operator-configurable.

---

### User Story 2 - Existing Claude CLI profiles and runs are completely unaffected (Priority: P1)

Profiles of the existing Claude CLI type — and every run already executed or currently in flight — must behave byte-identically after this feature ships. The Claude CLI type receives no endpoint override of any kind; its authentication modes, its environment construction, and its queue remain exactly as they are today.

**Why this priority**: A regression in the currently-working executor would take down live pipelines — strictly worse than not shipping the feature. This is a hard invariant, co-equal with Story 1.

**Independent Test**: Run the full existing Claude CLI unit and integration suites without modification; they must pass unchanged. Spawn a Claude CLI run and capture the exact child environment; it must be identical to the pre-feature environment (in particular, no endpoint-override variable present).

**Acceptance Scenarios**:

1. **Given** a pre-existing Claude CLI profile in any auth mode, **When** a run starts after this feature ships, **Then** the spawned child environment is byte-identical to before — no endpoint-override variable is injected for the Claude CLI type.
2. **Given** the existing Claude CLI test suites (unit and integration, including environment snapshots), **When** they run against the changed codebase, **Then** they pass without any modification to the tests themselves.
3. **Given** run history recorded before the feature, **When** it is queried or displayed, **Then** nothing about it is re-attributed or altered.

---

### User Story 3 - Provider attribution on runs is immutable and analytics-friendly (Priority: P2)

Each run permanently records which executor type produced it. Because "kimi" is a first-class type — not a mutable setting inside a Claude CLI profile — editing or repurposing a profile later can never silently re-attribute historical runs, and answering "which runs went through Moonshot?" is a single equality filter on the run record, no joins or config digging.

**Why this priority**: This is the decisive reason the type-based design was chosen over a provider field in mutable profile config. If attribution were mutable, run history and cost/behavior comparisons between providers would be untrustworthy.

**Independent Test**: Execute runs on a kimi profile, then edit the profile (rename, change model); verify historical runs still report type "kimi" and can be selected by a single type filter.

**Acceptance Scenarios**:

1. **Given** completed runs executed via a kimi profile, **When** the profile is subsequently edited, **Then** the historical runs' recorded executor type remains "kimi" unchanged.
2. **Given** a mixed run history (mock, Claude CLI, kimi), **When** an operator or query filters runs by executor type "kimi", **Then** exactly the Moonshot-backed runs are returned, with no auxiliary lookups required.

---

### User Story 4 - Security floor holds: host environment can never leak into kimi runs (Priority: P2)

The platform's standing guarantee is that a spawned agent process receives only an explicitly allowlisted environment. Adding the kimi type must not weaken this: the provider endpoint and API key handed to a kimi run come exclusively from the fixed in-code endpoint constant and the profile's encrypted secret — never from the worker's own shell. A host-level endpoint-override variable must remain off the allowlist permanently, so a polluted worker shell can never redirect any run (kimi or Claude CLI) to an unintended endpoint, and the kimi injection can never bleed into other executor types.

**Why this priority**: Constitution Principle V (Secret Isolation) is non-negotiable; an endpoint or key leak is a security regression that outweighs the feature's value.

**Independent Test**: Spawn kimi and Claude CLI runs from a worker shell polluted with provider endpoint/key variables (Anthropic-style and OpenAI-style) and capture the exact child environments; assert host values are absent everywhere, the kimi child contains exactly the fixed Moonshot endpoint plus the profile's key, and the Claude CLI child contains no endpoint override at all.

**Acceptance Scenarios**:

1. **Given** a worker shell exporting its own provider endpoint and API-key variables, **When** a kimi run starts, **Then** the child environment contains the fixed Moonshot endpoint and the profile's key only — none of the host's values pass through.
2. **Given** the same polluted shell, **When** a Claude CLI run starts, **Then** its child environment contains no endpoint-override variable and no kimi-related values.
3. **Given** a kimi profile, **When** it is saved, listed, or returned by the API, **Then** the stored API key is never echoed back (write-only; presence signaled by a boolean), matching the existing key handling.

---

### User Story 5 - The dashboard form guides the operator per type (Priority: P3)

An operator creating or editing an executor profile sees "kimi" in the type selector. Choosing it shows the model field, the API key field, the parallel-run limit, and the shared harness knobs — and nothing else: no URL field, no authentication-mode selector, no cloud-provider fields. Saving a new kimi profile without an API key is rejected with a clear message.

**Why this priority**: Without form support the feature is still API-configurable (Story 1), but the form prevents the two realistic misconfigurations: expecting an auth-mode choice that doesn't apply, and creating an unusable keyless profile.

**Independent Test**: Open the executor form, select type "kimi", verify the visible field set (and the absence of URL/auth-mode/cloud fields); attempt to save without a key and verify rejection; save a valid profile and verify it round-trips.

**Acceptance Scenarios**:

1. **Given** the executor form, **When** the operator selects type "kimi", **Then** the form shows model, API key, parallel-run limit, and the shared harness knobs — and does not show a URL field, an auth-mode selector, or any cloud-provider fields.
2. **Given** type "kimi" selected and no API key entered, **When** the operator saves a new profile, **Then** the save is rejected with a clear validation message that a key is required.
3. **Given** an existing kimi profile, **When** the operator updates it without touching the key field, **Then** the stored key is retained; an update that would leave the profile keyless is rejected.

---

### Edge Cases

- Kimi profile configuration arriving with fields foreign to the type (an auth-mode value, cloud-region/profile fields, a CA-bundle path, or any base-URL field) → rejected at validation; the kimi configuration branch is strict.
- Creating a kimi profile with no API key, or updating one in a way that would clear its only key → rejected (a keyless kimi profile can never run; there is no subscription or cloud-credential fallback for Moonshot).
- The Moonshot key stored in the profile is invalid or revoked → the run fails at the provider with diagnostics captured through the normal failed-run path; the platform does not pre-validate keys against Moonshot at save time.
- A model name Moonshot does not recognize → fails at the provider at run time; the platform does not maintain a Moonshot model catalog and does not block save on model format.
- Moonshot-side rate limiting → handled by the same rate-limit handling path the shared harness already implements; behavior identical to the Claude CLI type.
- Cost figures on kimi runs → the harness prices tokens against Anthropic's price list, so reported cost for kimi runs is not trustworthy as an absolute value; it is surfaced as indicative and documented as such. Recalculation against Moonshot pricing is out of scope.
- Concurrency limit (`max_parallel_runs`) lowered on a kimi profile while runs are queued → the per-profile concurrency gate re-applies the new limit live, same as the existing executor gate behavior.
- Two profiles of type kimi with different models/keys → each is an independent profile with its own key, limit, and gate; runs attribute to the same type "kimi".
- Host shell exports an endpoint-override variable → it is stripped for every executor type, always; the variable must never be added to the environment allowlist.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The platform MUST support a new first-class executor type named "kimi", selectable when creating executor profiles, alongside the existing mock and Claude CLI types. The name identifies the provider (Moonshot Kimi), deliberately not the underlying harness, so the implementation transport can be swapped later without changing the type name, run history, or analytics.
- **FR-002**: A kimi profile MUST carry: a name, a model identifier (e.g. `kimi-k3`), a Moonshot API key (write-only secret, encrypted at rest), a parallel-run limit, and the shared harness knobs (CLI path, callback-channel toggle, keep-failed-worktrees, max turns). It MUST NOT carry: a base/endpoint URL, an authentication-mode choice, or any cloud-provider fields — such fields MUST be rejected at validation (strict configuration branch).
- **FR-003**: The Moonshot Anthropic-compatible endpoint URL MUST be a fixed constant in code, mapped from the type — never operator-configurable, never stored per profile, never exposed as a form or API field.
- **FR-004**: Authentication for kimi is implicitly key-only. Creating a kimi profile without an API key, or updating one such that it would end up keyless, MUST be rejected by validation (analogous to the existing "explicit api_key mode requires a key on create" rule). Subscription-login and cloud-credential auth modes MUST NOT be available for kimi.
- **FR-005**: Runs created for agents referencing a kimi profile MUST record executor type "kimi" on the run itself (denormalized, immutable) and MUST be enqueued on a dedicated kimi run queue, separate from the Claude CLI queue.
- **FR-006**: Editing a kimi (or any) profile MUST NOT re-attribute historical runs; filtering run history by executor type MUST select Moonshot-backed runs with a single equality condition on the run record.
- **FR-007**: At spawn time, the child environment for a kimi run MUST be built by the existing strict allowlist pass first; only after that pass MUST the platform inject the fixed Moonshot endpoint (as the CLI's endpoint-override variable) and the profile's decrypted API key — both sourced exclusively from the in-code constant and the profile row, never from the worker's own process environment. This mirrors the existing api_key injection precedent.
- **FR-008**: The endpoint-override variable MUST remain permanently off the environment allowlist: a host-level value MUST never pass into any run of any executor type, and the kimi injection MUST never leak outside the kimi child process. Host provider-key variables (Anthropic-style, OpenAI-style) MUST remain stripped in all modes, unchanged.
- **FR-009**: Apart from the endpoint and key injection, a kimi run MUST reuse the shared Claude CLI harness behavior identically: worktree preparation, prior-work branch continuation, ticket scoping, instruction-wrapper compilation, the callback channel with report enforcement (including the stop-hook), output-stream parsing, rate-limit handling, process-group termination, and budget checks. All existing run-finalization guards (Constitution IV / CLAUDE.md rule 7) apply unchanged through the shared processing logic.
- **FR-010**: The Claude CLI executor type MUST remain byte-identical in behavior: no endpoint override is ever applied to it, its configuration contract is unchanged, and the existing Claude CLI unit and integration suites MUST pass without modification.
- **FR-011**: The kimi run queue MUST enforce the per-profile concurrency gate with live re-application of a changed parallel-run limit, matching the existing executor-gate behavior.
- **FR-012**: API responses for kimi profiles MUST never echo the stored key; key presence MUST be signaled by the existing boolean convention. Create and update contracts MUST enforce the key-required rule (FR-004) and the strict field set (FR-002).
- **FR-013**: The dashboard executor form MUST offer "kimi" in the type selector and, when selected, show exactly the kimi field set (model, API key, parallel-run limit, harness knobs) with no URL field and no auth-mode selector.
- **FR-014**: Reported cost for kimi runs MUST be surfaced as indicative (documented caveat): token pricing is computed against Anthropic's price list and does not reflect Moonshot pricing. No recalculation is performed this iteration.
- **FR-015**: The feature MUST require no database schema change: the executor type is stored as text and configuration as a flexible document, following the precedent of the previous auth-mode addition which shipped with zero DDL.
- **FR-016**: Documentation MUST be updated in the same iteration: the architecture document's executor-type table gains a kimi row (implemented; transport: Claude CLI harness against Moonshot's Anthropic-compatible endpoint, including the cost caveat), and the progress journal gains the iteration entry.
- **FR-017**: Tests MUST ship in the same iteration (Constitution VI): configuration accept/reject matrices for the kimi branch (rejects auth mode, rejects missing key on create, rejects cloud fields), endpoint-injection behavior per type (present for kimi, absent for Claude CLI, host value never leaks), registration/resolution of both executor instances, and an end-to-end kimi run through the kimi queue against real infrastructure asserting the child environment (endpoint + profile key present, host pollution absent) and identical success/rate-limit/crash behavior to the Claude CLI type, reusing the existing stream fixtures.

### Key Entities

- **Executor profile (type "kimi")**: An operator-managed configuration record identifying the Moonshot backend — name, model, write-only encrypted API key, parallel-run limit, shared harness knobs. Strictly excludes endpoint URL, auth mode, and cloud fields. Referenced by agents exactly like any other executor profile.
- **Run**: The unit of pipeline execution; permanently records the executor type ("kimi") that produced it, independent of later profile edits. Carries indicative (not authoritative) cost for kimi runs.
- **Kimi run queue**: A dedicated queue for kimi runs, provisioned from the type registry, with the per-profile concurrency gate and live limit re-application.
- **Provider preset**: The internal pairing of an executor type with its fixed endpoint (none for Claude CLI, the Moonshot constant for kimi); an implementation-internal notion with no operator-facing surface.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can create a working kimi executor profile using the dashboard alone (no code changes, no shell configuration on the worker) and a triggered run completes end-to-end with a schema-valid report against Moonshot.
- **SC-002**: 100% of pre-existing Claude CLI unit and integration tests pass with zero modifications, and a captured Claude CLI child environment is byte-identical to the pre-feature baseline.
- **SC-003**: With a worker shell deliberately polluted with provider endpoint and key variables, 0 host-sourced values appear in any spawned child environment (kimi or Claude CLI) across the test matrix.
- **SC-004**: Run history filtered by executor type "kimi" returns exactly the Moonshot-backed runs with a single filter, and re-running the query after profile edits returns the same historical set.
- **SC-005**: The standard failure paths (provider rate limit, process crash, success with report) on kimi runs produce the same run statuses and diagnostics as the equivalent Claude CLI scenarios in the integration suite.
- **SC-006**: Creating a kimi profile without a key, or with foreign fields (auth mode, cloud fields, URL), is rejected with a clear validation error in 100% of the contract-test matrix cases.

## Assumptions

- Moonshot's Anthropic-compatible endpoint remains stable at its published URL and compatible with the Claude Code CLI's endpoint-override mechanism; the output-stream format is unchanged because the binary is unchanged (existing stream fixtures remain valid).
- The Moonshot API key is a bearer secret compatible with the CLI's standard key variable; no additional Moonshot-specific headers or auth handshake are required.
- Operators obtain Moonshot API keys out of band; the platform does not manage Moonshot accounts or validate keys at save time.
- The existing encrypted-secret storage, write-only key semantics, and key-presence boolean are reused as-is for the kimi key.
- Queue provisioning derives from the executor-type registry, so registering the new type is sufficient for the kimi queue to exist; no separate infrastructure work is needed.
- A seeded default kimi profile (disabled until a key is entered) is optional; full create/update support via API and form is the required minimum.
- The implementation shape is decided (parameterized shared executor, second registered instance, near-copy/shared-base queue processor) and recorded in the feature input for the planning phase; this spec constrains behavior, not internals.

## Out of Scope

- Adopting Moonshot's native kimi-cli binary as the transport (possible future change under the same "kimi" type name — explicitly designed for).
- OpenAI-compatible API loop or direct-API executor implementations (anthropic_api, deepseek_api, etc.).
- Cost recalculation against Moonshot pricing; per-provider price tables.
- Any user-facing "custom base URL" field, for any executor type (deliberately not exposed).
- DeepSeek or other Anthropic-compatible providers (the internal preset mechanism makes them cheap later, but only kimi ships now).
