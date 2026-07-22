# Feature Specification: First-class deepseek_api executor type (DeepSeek backend) reusing the Claude CLI harness

**Feature Branch**: `028-deepseek-executor`

**Created**: 2026-07-22

**Status**: Draft

**Input**: User description: "Implement executor type `deepseek_api` as the third provider preset over the existing Claude CLI harness — an exact analogue of feature 025 (kimi/Moonshot), pointing the shared harness at DeepSeek's official Anthropic-compatible endpoint, with its own run queue, immutable run attribution, implicit api_key-only auth, no user-facing base-URL field, and a real-provider smoke validation whose primary hypothesis is that the callback channel (client-side stdio MCP) works against DeepSeek."

## Inherited Decisions (from feature 025, applied unchanged)

- **No profile seeding**: operators create deepseek_api profiles manually via the form/API; a keyless seed would contradict the key-required invariant and need a special-case path for a profile that cannot run.
- **Indicative-cost caveat surfaced in both UI and docs**: token pricing is computed against Anthropic's price list, so cost figures on deepseek_api runs are indicative only, marked as such wherever displayed.
- **Type-based attribution over mutable config**: the provider is a first-class executor type, so historical runs can never be silently re-attributed by profile edits.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Runs execute on DeepSeek models, configured entirely from the dashboard (Priority: P1)

The team wants pipeline agents to run on DeepSeek models (`deepseek-v4-pro`, `deepseek-v4-flash`) as a third backend alongside Anthropic and Moonshot. An operator opens the dashboard, creates an executor profile of the new type "deepseek_api", fills in a name, a model (native DeepSeek id, e.g. `deepseek-v4-flash`), the DeepSeek API key (write-only secret), the parallel-run limit, and the familiar harness knobs (CLI path, callback channel toggle, keep-failed-worktrees, max turns). There is deliberately **no base-URL field anywhere** — the DeepSeek Anthropic-compatible endpoint is a fixed property of the type itself. An agent is pointed at this profile exactly the way agents reference any executor profile today, and its runs execute end-to-end against DeepSeek: same worktree preparation, same prior-work branch continuation, same callback channel and report enforcement, same failure handling.

**Why this priority**: This is the entire reason the feature exists — a third model provider for pipeline agents with zero new harness machinery. Everything else in this spec protects or supports this flow.

**Independent Test**: Create a deepseek_api profile via the dashboard/API only, attach an agent to it, trigger a run; the run must be attributed to the deepseek_api type, travel through the deepseek_api run queue, spawn the agent against the DeepSeek endpoint with the profile's key, and complete with a schema-valid report.

**Acceptance Scenarios**:

1. **Given** an operator with a valid DeepSeek API key, **When** they create an executor profile of type "deepseek_api" with name, model, key, and harness knobs via the dashboard or API, **Then** the profile is saved with the key stored write-only (never echoed back; presence signaled by a boolean) and appears in the executor list as type "deepseek_api".
2. **Given** an agent referencing a deepseek_api profile, **When** a run is triggered for it, **Then** the run is recorded with executor type "deepseek_api", enqueued on the deepseek_api-specific run queue, and the spawned agent process talks to the DeepSeek Anthropic-compatible endpoint using the profile's decrypted key.
3. **Given** a deepseek_api run in flight, **When** it progresses through the pipeline, **Then** worktree preparation, prior-work branch continuation, ticket scoping, the callback channel with report enforcement, output-stream parsing, rate-limit handling, process-group termination, and budget checks all behave identically to a Claude CLI run — the harness is shared, only the provider endpoint and key differ.
4. **Given** a deepseek_api profile, **When** the operator inspects or edits it in the dashboard, **Then** no base-URL field is shown or accepted anywhere — the endpoint is not operator-configurable.

---

### User Story 2 - Existing executor types are completely unaffected (Priority: P1)

Profiles of the existing types (mock, Claude CLI, kimi) — and every run already executed or currently in flight — must behave byte-identically after this feature ships. The Claude CLI type receives no endpoint override of any kind; the kimi type keeps its Moonshot endpoint; authentication modes, environment construction, and queues remain exactly as they are today.

**Why this priority**: A regression in a currently-working executor would take down live pipelines — strictly worse than not shipping the feature. This is a hard invariant, co-equal with Story 1.

**Independent Test**: Run the full existing unit and integration suites without modification; they must pass unchanged. Spawn a Claude CLI run and a kimi run and capture the exact child environments; they must be identical to the pre-feature environments.

**Acceptance Scenarios**:

1. **Given** a pre-existing Claude CLI profile in any auth mode, **When** a run starts after this feature ships, **Then** the spawned child environment is byte-identical to before — no endpoint-override variable is injected for the Claude CLI type.
2. **Given** a pre-existing kimi profile, **When** a run starts after this feature ships, **Then** its child environment carries the Moonshot endpoint exactly as before — never the DeepSeek endpoint.
3. **Given** the existing unit and integration suites (including environment snapshots), **When** they run against the changed codebase, **Then** they pass without any modification to the tests themselves.
4. **Given** run history recorded before the feature, **When** it is queried or displayed, **Then** nothing about it is re-attributed or altered.

---

### User Story 3 - Real-provider smoke validation proves the callback channel works against DeepSeek (Priority: P1)

Before the feature is considered done, one real run is executed against the live DeepSeek endpoint through a freshly created deepseek_api profile. The primary hypothesis under test: the platform's callback channel — a client-side capability of the agent CLI process, not a server-side provider feature — works when the model behind the CLI is DeepSeek. (DeepSeek's public documentation lists "MCP" as unsupported, but that refers to their server-side API connector; the CLI-side channel is expected to be unaffected.) The smoke run must produce evidence: callback events visible on the run timeline, tool use (files read/written in the worktree), a terminal status reached through the normal path (not fail-closed), and either populated usage/cost figures or an explicit documented finding that DeepSeek does not return them.

**Why this priority**: This hypothesis is the go/no-go for the feature's chosen shape. If the callback channel does not work against DeepSeek, the feature decision itself changes — the failure must be described, not silently worked around.

**Independent Test**: Execute one minimal real run through a deepseek_api profile with the callback channel enabled; inspect the run timeline for callback events, worktree file operations, terminal status, and usage/cost fields.

**Acceptance Scenarios**:

1. **Given** a deepseek_api profile with the callback channel enabled and a valid key, **When** a minimal real run executes, **Then** the run reaches a terminal status via the normal path (not the fail-closed path) and the timeline shows callback-channel events originating from the agent.
2. **Given** the same smoke run, **When** its timeline and diagnostics are inspected, **Then** tool use is evidenced (files read/written in the worktree) and the API key appears nowhere (masked by the environment scrubber).
3. **Given** the same smoke run, **When** usage/cost fields are inspected, **Then** they are either populated, or their absence is explicitly recorded in the feature documentation as a known provider limitation.
4. **Given** the callback channel does NOT function against DeepSeek, **When** the smoke run fails this way, **Then** the work stops with a written description of the symptoms — no silent workaround is applied.

---

### User Story 4 - Security floor holds: host environment can never leak into deepseek_api runs (Priority: P2)

The platform's standing guarantee is that a spawned agent process receives only an explicitly allowlisted environment. Adding the deepseek_api type must not weaken this: the provider endpoint and API key handed to a deepseek_api run come exclusively from the fixed in-code endpoint constant and the profile's encrypted secret — never from the worker's own shell. A host-level endpoint-override variable must remain off the allowlist permanently, so a polluted worker shell can never redirect any run to an unintended endpoint, and the deepseek_api injection can never bleed into other executor types.

**Why this priority**: Constitution Principle V (Secret Isolation) is non-negotiable; an endpoint or key leak is a security regression that outweighs the feature's value.

**Independent Test**: Spawn deepseek_api, kimi, and Claude CLI runs from a worker shell polluted with provider endpoint/key variables and capture the exact child environments; assert host values are absent everywhere, the deepseek_api child contains exactly the fixed DeepSeek endpoint plus the profile's key, and the other types' children are unchanged.

**Acceptance Scenarios**:

1. **Given** a worker shell exporting its own provider endpoint and API-key variables, **When** a deepseek_api run starts, **Then** the child environment contains the fixed DeepSeek endpoint and the profile's key only — none of the host's values pass through.
2. **Given** the same polluted shell, **When** a Claude CLI or kimi run starts, **Then** its child environment contains no DeepSeek-related values and behaves exactly as before the feature.
3. **Given** a deepseek_api profile, **When** it is saved, listed, or returned by the API, **Then** the stored API key is never echoed back (write-only; presence signaled by a boolean), matching the existing key handling.

---

### User Story 5 - Provider attribution on runs is immutable and analytics-friendly (Priority: P3)

Each run permanently records which executor type produced it. Because "deepseek_api" is a first-class type — not a mutable setting inside a profile — editing or repurposing a profile later can never silently re-attribute historical runs, and answering "which runs went through DeepSeek?" is a single equality filter on the run record.

**Why this priority**: Same rationale as feature 025 Story 3 — trustworthy run history and cross-provider comparisons. Lower priority here only because the mechanism already exists and is inherited, not built.

**Independent Test**: Execute runs on a deepseek_api profile, then edit the profile (rename, change model); verify historical runs still report type "deepseek_api" and can be selected by a single type filter.

**Acceptance Scenarios**:

1. **Given** completed runs executed via a deepseek_api profile, **When** the profile is subsequently edited, **Then** the historical runs' recorded executor type remains "deepseek_api" unchanged.
2. **Given** a mixed run history (mock, Claude CLI, kimi, deepseek_api), **When** runs are filtered by executor type "deepseek_api", **Then** exactly the DeepSeek-backed runs are returned, with no auxiliary lookups required.

---

### User Story 6 - The dashboard form guides the operator per type (Priority: P3)

An operator creating or editing an executor profile sees "deepseek_api" in the type selector. Choosing it shows the model field, the API key field, the parallel-run limit, and the shared harness knobs — and nothing else: no URL field, no authentication-mode selector, no cloud-provider fields. The model field carries a hint naming the native DeepSeek model ids and two caveats: cost figures are indicative (priced against Anthropic's list), and unrecognized model names are silently routed by the provider to its cheapest model. Saving a new deepseek_api profile without an API key is rejected with a clear message.

**Why this priority**: Without form support the feature is still API-configurable (Story 1), but the form prevents the realistic misconfigurations: expecting an auth-mode choice that doesn't apply, creating an unusable keyless profile, and typo'ing a model name without realizing the provider silently substitutes a different model.

**Independent Test**: Open the executor form, select type "deepseek_api", verify the visible field set (and the absence of URL/auth-mode/cloud fields) and the model hint; attempt to save without a key and verify rejection; save a valid profile and verify it round-trips.

**Acceptance Scenarios**:

1. **Given** the executor form, **When** the operator selects type "deepseek_api", **Then** the form shows model, API key, parallel-run limit, and the shared harness knobs — and does not show a URL field, an auth-mode selector, or any cloud-provider fields.
2. **Given** type "deepseek_api" selected, **When** the operator reads the model field hint, **Then** it names the native DeepSeek model ids and states both the indicative-cost caveat and the silent-substitution behavior for unrecognized names.
3. **Given** type "deepseek_api" selected and no API key entered, **When** the operator saves a new profile, **Then** the save is rejected with a clear validation message that a key is required.
4. **Given** an existing deepseek_api profile, **When** the operator updates it without touching the key field, **Then** the stored key is retained; an update that would leave the profile keyless is rejected.

---

### Edge Cases

- Deepseek_api profile configuration arriving with fields foreign to the type (an auth-mode value, cloud-region/profile fields, a CA-bundle path, or any base-URL field) → rejected at validation; the deepseek_api configuration branch is strict.
- Creating a deepseek_api profile with no API key, or updating one in a way that would clear its only key → rejected (a keyless deepseek_api profile can never run; there is no subscription or cloud-credential fallback for DeepSeek).
- The DeepSeek key stored in the profile is invalid or revoked → the run fails at the provider with diagnostics captured through the normal failed-run path; the platform does not pre-validate keys against DeepSeek at save time.
- A model name DeepSeek does not recognize → **unlike Moonshot, DeepSeek does not fail: it silently routes unrecognized names (and maps claude-style aliases) to its cheapest model.** The platform does not maintain a DeepSeek model catalog and does not block save; the risk is mitigated by the form hint (Story 6) and the smoke validation verifying that native ids pass through and actually serve the run. Note the consequence: the per-model concurrency cap keys on the configured model string, so a silently-substituted run is capped under the name the operator configured, not the model that actually served it — documented behavior, not corrected this iteration.
- DeepSeek-side rate limiting → handled by the same rate-limit handling path the shared harness already implements; behavior identical to the Claude CLI type.
- Cost figures on deepseek_api runs → the harness prices tokens against Anthropic's price list, so reported cost is indicative only; marked in the dashboard (same convention as kimi) and recorded in docs. If DeepSeek omits usage data entirely, the absence is documented as a known limitation (Story 3).
- The callback channel proves non-functional against DeepSeek during smoke validation → hard stop with a written symptom description; the feature decision is revisited (Story 3, scenario 4).
- Concurrency limit (`max_parallel_runs`) lowered on a deepseek_api profile while runs are queued → the per-profile concurrency gate re-applies the new limit live, same as the existing executor-gate behavior.
- Two profiles of type deepseek_api with different models/keys → each is an independent profile with its own key, limit, and gate; runs attribute to the same type "deepseek_api".
- Host shell exports an endpoint-override variable → it is stripped for every executor type, always; the variable must never be added to the environment allowlist.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The platform MUST support a new first-class executor type named "deepseek_api", selectable when creating executor profiles, alongside the existing mock, Claude CLI, and kimi types. The reserved type name "deepseek_api" MUST be kept as-is (it already exists as a declared-but-unimplemented slot in the type vocabulary).
- **FR-002**: A deepseek_api profile MUST carry: a name, a model identifier (native DeepSeek id, e.g. `deepseek-v4-pro` or `deepseek-v4-flash`), a DeepSeek API key (write-only secret, encrypted at rest), a parallel-run limit, and the shared harness knobs (CLI path, callback-channel toggle, keep-failed-worktrees, max turns). It MUST NOT carry: a base/endpoint URL, an authentication-mode choice, or any cloud-provider fields — such fields MUST be rejected at validation (strict configuration branch).
- **FR-003**: The DeepSeek Anthropic-compatible endpoint URL MUST be a fixed constant in code, mapped from the type — never operator-configurable, never stored per profile, never exposed as a form or API field.
- **FR-004**: Authentication for deepseek_api is implicitly key-only. Creating a deepseek_api profile without an API key, or updating one such that it would end up keyless, MUST be rejected by validation. Subscription-login and cloud-credential auth modes MUST NOT be available for deepseek_api.
- **FR-005**: Runs created for agents referencing a deepseek_api profile MUST record executor type "deepseek_api" on the run itself (denormalized, immutable) and MUST be enqueued on a dedicated deepseek_api run queue, separate from the Claude CLI and kimi queues.
- **FR-006**: Editing a deepseek_api (or any) profile MUST NOT re-attribute historical runs; filtering run history by executor type MUST select DeepSeek-backed runs with a single equality condition on the run record.
- **FR-007**: At spawn time, the child environment for a deepseek_api run MUST be built by the existing strict allowlist pass first; only after that pass MUST the platform inject the fixed DeepSeek endpoint (as the CLI's endpoint-override variable) and the profile's decrypted API key — both sourced exclusively from the in-code constant and the profile row, never from the worker's own process environment.
- **FR-008**: The endpoint-override variable MUST remain permanently off the environment allowlist: a host-level value MUST never pass into any run of any executor type, and the deepseek_api injection MUST never leak outside the deepseek_api child process. Host provider-key variables MUST remain stripped in all modes, unchanged.
- **FR-009**: Apart from the endpoint and key injection, a deepseek_api run MUST reuse the shared Claude CLI harness behavior identically: worktree preparation, prior-work branch continuation, ticket scoping, instruction-wrapper compilation, the callback channel with report enforcement (including the stop-hook), output-stream parsing, rate-limit handling, process-group termination, and budget checks. All existing run-finalization guards (Constitution IV / CLAUDE.md rule 7) apply unchanged through the shared processing logic.
- **FR-010**: Existing executor types MUST remain byte-identical in behavior: the Claude CLI type never receives an endpoint override, the kimi type keeps exactly its Moonshot endpoint, configuration contracts are unchanged, and existing unit and integration suites MUST pass without modification.
- **FR-011**: The deepseek_api run queue MUST enforce the per-profile concurrency gate with live re-application of a changed parallel-run limit, matching the existing executor-gate behavior.
- **FR-012**: API responses for deepseek_api profiles MUST never echo the stored key; key presence MUST be signaled by the existing boolean convention. Create and update contracts MUST enforce the key-required rule (FR-004) and the strict field set (FR-002).
- **FR-013**: The dashboard executor form MUST offer "deepseek_api" in the type selector and, when selected, show exactly the deepseek_api field set (model, API key, parallel-run limit, harness knobs) with no URL field and no auth-mode selector. The model field MUST carry a hint naming the native DeepSeek model ids, the indicative-cost caveat, and the silent-substitution behavior for unrecognized model names.
- **FR-014**: Reported cost for deepseek_api runs MUST be surfaced as indicative in the dashboard (same convention as kimi runs) and documented as such: token pricing is computed against Anthropic's price list and does not reflect DeepSeek pricing. No recalculation is performed this iteration.
- **FR-015**: The feature MUST require no database schema change: the executor type is stored as text and configuration as a flexible document, following the precedent of the kimi addition which shipped with zero DDL.
- **FR-016**: The rules that apply uniformly to "provider presets over the shared CLI harness" (currently Claude CLI + kimi, now + deepseek_api) and to "implicitly key-only preset types" (currently kimi, now + deepseek_api) MUST each be expressed in exactly one place, so that adding a fourth provider preset later requires extending a single definition rather than touching multiple parallel conditionals. Validation behavior for existing types MUST NOT change as a result of this consolidation.
- **FR-017**: Before the feature is complete, one real run MUST be executed against the live DeepSeek endpoint (smoke validation, Story 3) with the callback channel enabled, and its evidence recorded: callback events on the timeline, tool use in the worktree, terminal status via the normal path, model-id pass-through confirmed from usage/response data, usage/cost presence or documented absence, and confirmation that the API key appears nowhere in the timeline or diagnostics. If native model ids are silently remapped by the provider, the actual naming convention MUST be documented in the feature's contract documentation and reflected in the form's model hint. If the callback channel fails, work MUST stop with a written symptom description.
- **FR-018**: Documentation MUST be updated in the same iteration: the architecture document's executor-type table gains a deepseek_api row (implemented; transport: Claude CLI harness against DeepSeek's Anthropic-compatible endpoint, including the cost caveat and any smoke-validation findings), and the progress journal gains the iteration entry.
- **FR-019**: Tests MUST ship in the same iteration (Constitution VI): configuration accept/reject matrices for the deepseek_api branch (rejects auth mode, rejects missing key on create, rejects cloud fields and base-URL), endpoint-injection behavior per type (DeepSeek endpoint for deepseek_api, Moonshot for kimi, none for Claude CLI, host value never leaks), registration/resolution of the new executor instance, the keyless-profile loud-failure guard, queue materialization for the new type, dashboard form behavior, and end-to-end deepseek_api runs through the deepseek_api queue against real infrastructure asserting the child environment and identical success/rate-limit/crash behavior to the Claude CLI type, mirroring the four kimi integration suites (run, gate, security, profile CRUD).

### Key Entities

- **Executor profile (type "deepseek_api")**: An operator-managed configuration record identifying the DeepSeek backend — name, native-id model, write-only encrypted API key, parallel-run limit, shared harness knobs. Strictly excludes endpoint URL, auth mode, and cloud fields. Referenced by agents exactly like any other executor profile.
- **Run**: The unit of pipeline execution; permanently records the executor type ("deepseek_api") that produced it, independent of later profile edits. Carries indicative (not authoritative) cost for deepseek_api runs.
- **Deepseek_api run queue**: A dedicated queue for deepseek_api runs, provisioned from the type registry, with the per-profile concurrency gate and live limit re-application.
- **Provider preset**: The internal pairing of an executor type with its fixed endpoint (none for Claude CLI, Moonshot for kimi, DeepSeek for deepseek_api); an implementation-internal notion with no operator-facing surface. The subset of presets that are implicitly key-only (kimi, deepseek_api) shares one definition (FR-016).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can create a working deepseek_api executor profile using the dashboard alone (no code changes, no shell configuration on the worker) and a triggered run completes end-to-end with a schema-valid report against DeepSeek.
- **SC-002**: 100% of pre-existing unit and integration tests (Claude CLI and kimi) pass with zero modifications, and captured Claude CLI and kimi child environments are byte-identical to the pre-feature baseline.
- **SC-003**: With a worker shell deliberately polluted with provider endpoint and key variables, 0 host-sourced values appear in any spawned child environment (deepseek_api, kimi, or Claude CLI) across the test matrix.
- **SC-004**: The real-provider smoke run reaches a terminal status via the normal path with callback-channel events visible on the timeline and file operations evidenced in the worktree — or, if the callback channel fails, a written symptom description exists and no workaround was applied.
- **SC-005**: The smoke run's usage/response data confirms the configured native model id actually served the run — or the observed naming convention is documented and the form hint corrected.
- **SC-006**: The API key from the smoke profile appears in exactly zero places outside the encrypted secret store: not in the run timeline, diagnostics, logs, code, tests, or documentation.
- **SC-007**: Run history filtered by executor type "deepseek_api" returns exactly the DeepSeek-backed runs with a single filter, and re-running the query after profile edits returns the same historical set.
- **SC-008**: Creating a deepseek_api profile without a key, or with foreign fields (auth mode, cloud fields, URL), is rejected with a clear validation error in 100% of the contract-test matrix cases.
- **SC-009**: The standard failure paths (provider rate limit, process crash, success with report) on deepseek_api runs produce the same run statuses and diagnostics as the equivalent Claude CLI scenarios in the integration suite.

## Assumptions

- DeepSeek's official Anthropic-compatible endpoint remains stable at its published URL and compatible with the Claude Code CLI's endpoint-override mechanism; tool use and streaming are supported per DeepSeek's documentation. The output-stream format is unchanged because the CLI binary is unchanged (existing stream fixtures remain valid).
- The DeepSeek API key is a bearer secret compatible with the CLI's standard key variable; no additional DeepSeek-specific headers or auth handshake are required.
- The callback channel is a client-side capability of the CLI process and is expected to work regardless of the model provider behind the CLI; DeepSeek's "MCP unsupported" documentation note refers to their server-side API connector, not client-side channels. This is a hypothesis, not a certainty — it is exactly what the mandatory smoke validation (Story 3) tests, and its failure is a stop condition, not a workaround trigger.
- DeepSeek maps claude-style model aliases and silently substitutes its cheapest model for unrecognized names; the platform's mitigation is the form hint plus smoke verification of native-id pass-through, not save-time validation.
- Operators obtain DeepSeek API keys out of band; the platform does not manage DeepSeek accounts or validate keys at save time.
- The existing encrypted-secret storage, write-only key semantics, and key-presence boolean are reused as-is for the DeepSeek key.
- Queue provisioning derives from the executor-type registry, so registering the new type is sufficient for the deepseek_api queue to exist; no separate infrastructure work is needed.
- No default deepseek_api profile is seeded (inherited decision from 025): operators create profiles manually via the form/API.
- The implementation shape is decided and inherited from feature 025 (parameterized shared executor, additional registered instance, near-copy queue processor, registry-only resolution); this spec constrains behavior, not internals.

## Out of Scope

- Seeding a default deepseek_api executor profile.
- A direct-API executor implementation for DeepSeek (e.g. against its native OpenAI-compatible API); this feature deliberately reuses the CLI harness via the Anthropic-compatible endpoint.
- Cost recalculation against DeepSeek pricing; per-provider price tables.
- Save-time model-name validation or a maintained DeepSeek model catalog.
- Any user-facing "custom base URL" field, for any executor type (deliberately not exposed).
- Correcting the per-model concurrency cap to key on the actually-served model when the provider silently substitutes (documented as-is this iteration).
- Other Anthropic-compatible providers beyond DeepSeek (the preset mechanism keeps them cheap later, but only deepseek_api ships now).
