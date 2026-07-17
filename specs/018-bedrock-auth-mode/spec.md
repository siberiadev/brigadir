# Feature Specification: Bedrock authentication mode for Claude CLI executor profiles

**Feature Branch**: `018-bedrock-auth-mode`

**Created**: 2026-07-17

**Status**: Draft

**Input**: User description: "Add a "bedrock" authentication mode to claude_cli executor profiles, so a run can drive a corporate Claude CLI that authenticates through AWS Bedrock — on any team member's machine, configured per profile, with zero host-shell coupling."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Runs succeed on a Bedrock-only machine, configured entirely from the dashboard (Priority: P1)

A team member's corporate machine reaches Claude exclusively through AWS Bedrock: there is no first-party subscription login and no direct Anthropic API key. Today every run on such a machine dies at CLI startup ("Not logged in") and the run fails with "no schema-valid structured_output" (observed live: run 2fd7aefb). The operator opens the dashboard, edits (or creates) a Claude CLI executor profile, selects the "bedrock" authentication mode, fills in the AWS region, optionally their named AWS profile and the path to the corporate CA bundle — and runs on that profile now authenticate through Bedrock and complete normally. No shell exports for the worker, no code changes, no allowlist edits.

**Why this priority**: This is the entire reason the feature exists — an affected machine currently cannot run any pipeline at all. Everything else in this spec supports or protects this flow.

**Independent Test**: On a worker host with valid AWS credentials on disk and no Anthropic subscription login, configure a bedrock-mode profile via the dashboard only and trigger a run; the run must reach the agent loop and complete with a valid report.

**Acceptance Scenarios**:

1. **Given** a worker host whose only Claude access is AWS Bedrock (AWS credentials configured in the host user's home directory, no `~/.claude` OAuth login), **When** the operator sets a Claude CLI profile to auth mode "bedrock" with a region and triggers a run, **Then** the spawned CLI authenticates through Bedrock and the run completes with a schema-valid report instead of failing at login.
2. **Given** a bedrock-mode profile with an AWS profile name filled in, **When** a run starts, **Then** the spawned CLI resolves AWS credentials under that named profile; **and given** the field is left empty, **Then** the CLI falls back to the AWS default credential resolution on the worker host.
3. **Given** a bedrock-mode profile with a CA bundle path filled in (corporate TLS interception), **When** a run starts, **Then** the spawned CLI trusts that bundle for outbound TLS; **and given** the field is empty, **Then** no extra trust configuration is applied.
4. **Given** a second team member cloning the repo on a different machine with a different AWS profile name and a different CA bundle path, **When** they create their own executor profile in the dashboard with their values, **Then** runs work on their machine with zero code or shell changes (portability requirement).

---

### User Story 2 - Existing profiles keep working exactly as before (Priority: P2)

Executor profiles created before this feature have no authentication-mode field. After the upgrade, every existing profile must behave identically without anyone touching it: a profile with a stored API key keeps injecting that key; a profile without one keeps using the host subscription login.

**Why this priority**: A compatibility break would take down currently-working pipelines — worse than not shipping the feature.

**Independent Test**: Take profile rows persisted before the change (with and without a stored key), run them without editing, and verify the spawned CLI receives exactly the same environment as before the feature.

**Acceptance Scenarios**:

1. **Given** a pre-existing profile with a stored encrypted API key and no auth-mode field, **When** a run starts, **Then** it behaves as auth mode "api_key": the decrypted key is injected and the run bills against that key, exactly as today.
2. **Given** a pre-existing profile without a stored key and no auth-mode field, **When** a run starts, **Then** it behaves as auth mode "host_subscription": nothing is injected and the CLI reads the host user's subscription login, exactly as today.
3. **Given** any pre-existing profile, **When** the operator opens it in the dashboard form after the upgrade, **Then** the form shows the effective auth mode per the defaulting rule above and saving without changes does not alter run behavior.

---

### User Story 3 - Security floor holds: host shell variables still cannot leak into runs (Priority: P2)

The platform's standing guarantee is that the spawned agent process receives only an explicitly allowlisted environment — host secrets (cloud credentials, API keys, tokens) are stripped by construction. Adding bedrock mode must not weaken this: everything injected for bedrock comes from the profile stored in the database, never from the worker's shell, and AWS access keys / secret keys / session tokens are never stored in the platform nor placed in the child environment in any mode.

**Why this priority**: Constitution Principle V (Secret Isolation) is non-negotiable; a leak here is a security regression that outweighs the feature's value.

**Independent Test**: Spawn runs in each auth mode from a worker shell polluted with AWS and Anthropic variables and capture the exact child environment; assert the host values are absent and only the profile-derived values are present.

**Acceptance Scenarios**:

1. **Given** a worker shell exporting its own AWS region/profile/credential variables and Anthropic variables, **When** a bedrock-mode run starts, **Then** the child environment contains only the profile-derived Bedrock settings — none of the host's values pass through, including host AWS credential variables.
2. **Given** the same polluted shell, **When** a host_subscription-mode or api_key-mode run starts, **Then** the child environment contains no Bedrock or AWS settings at all (host_subscription additionally contains no injected key).
3. **Given** any bedrock-mode profile, **When** its configuration is saved, listed, or returned by the API, **Then** no AWS access key, secret key, or session token appears anywhere — the profile holds only region, optional profile name, and optional CA bundle path, none of which are credential material.

---

### User Story 4 - The dashboard form guides the operator per auth mode (Priority: P3)

An operator editing a Claude CLI profile sees an authentication-mode selector. The form shows only the fields relevant to the selected mode: the API key field only for "api_key", the region / AWS profile / CA bundle fields only for "bedrock", and neither for "host_subscription". In bedrock mode the form also hints that the profile's model must be a full Bedrock model or inference-profile identifier (e.g. "eu.anthropic.claude-opus-4-8"), because bare aliases like "opus" are not resolvable in this mode.

**Why this priority**: Without form guidance the feature still works (P1 is API-configurable), but misconfiguration — especially a bare model alias — produces confusing run failures instead of an up-front hint.

**Independent Test**: Open the executor form, switch between the three auth modes, and verify the visible field set and the bedrock model hint; save each variant and verify validation.

**Acceptance Scenarios**:

1. **Given** the executor form for a Claude CLI profile, **When** the operator switches the auth mode selector between the three modes, **Then** only the mode's own fields are visible: key field for "api_key"; region (required), AWS profile (optional), CA bundle path (optional) for "bedrock"; no extra fields for "host_subscription".
2. **Given** bedrock mode selected, **When** the operator views the model field, **Then** a hint explains that a full Bedrock model/inference-profile id is required and bare aliases will not resolve.
3. **Given** bedrock mode with the region left empty, **When** the operator saves, **Then** the save is rejected with a clear validation message (region is required for bedrock).
4. **Given** a saved profile, **When** it is returned by the API, **Then** the stored API key is never echoed back (existing write-only behavior is unchanged in every mode).

---

### Edge Cases

- Bedrock mode selected but the AWS profile name does not exist in the worker host's AWS configuration → the CLI fails to obtain credentials at run time; the run must fail with diagnostics captured (normal failed-run path), not hang.
- CA bundle path points to a file that does not exist on the worker host → the platform does not pre-validate worker filesystem paths at save time; the failure surfaces as a failed run with diagnostics.
- Bedrock mode with a bare model alias (e.g. "opus") → the run fails at the provider; the form hint (Story 4) is the mitigation — the platform does not block save on model format, since valid Bedrock id formats vary by region/vendor and may evolve.
- A profile in "api_key" mode with no key stored and none provided in the same save → the save is rejected: explicit api_key mode requires a key.
- Switching a profile's auth mode away from "api_key" → the stored encrypted key is retained (inert — never injected outside api_key mode) so the operator can switch back without re-entering it; the existing explicit clear operation still removes it.
- A saved configuration carrying fields foreign to its selected auth mode (e.g. host_subscription with a region) → rejected by validation, consistent with the contract's existing strictness per branch.
- Host shell exports AWS session credentials (access key / secret / session token) → they are stripped in every mode, including bedrock; bedrock mode relies solely on the worker host's on-disk AWS configuration reachable via the home directory.
- Expired or unrefreshed AWS credentials on the worker host (e.g. stale SSO session) → run fails with diagnostics; refreshing credentials is a host concern, out of the platform's scope, and must be covered in the setup documentation.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The Claude CLI executor profile configuration MUST support an authentication-mode choice among exactly three modes: "host_subscription", "api_key", and "bedrock". The mode is part of the existing Claude CLI profile type — this feature MUST NOT introduce a sibling executor type.
- **FR-002**: Backward-compatibility defaulting rule: a stored profile without an auth mode MUST behave as "api_key" when it has a stored encrypted API key and as "host_subscription" otherwise. Existing stored configurations MUST remain valid without rewriting (additive fields only), and the defaulting rule MUST be documented.
- **FR-003**: Bedrock mode MUST carry: AWS region (required), AWS profile name (optional; absent means the worker host's default AWS credential resolution), CA bundle path (optional; for corporate TLS interception). Fields foreign to the selected mode MUST be rejected at validation.
- **FR-004**: When a bedrock-mode run starts, the platform MUST explicitly provide to the spawned CLI — sourced from the stored profile, never from the worker's shell — the Bedrock activation flag, the AWS region, the AWS profile name (only if set), and the CA bundle trust path (only if set).
- **FR-005**: The environment allowlist floor MUST remain unchanged: in every auth mode, host shell variables outside the existing allowlist (including all host AWS and Anthropic variables) MUST remain stripped from the child environment by construction.
- **FR-006**: AWS credential material (access keys, secret keys, session tokens) MUST NOT be stored in profiles, appear in any API request/response, or be placed in the child environment. Credential resolution happens on the worker host via its home-directory AWS configuration, which is reachable through the already-allowlisted home path (same posture as subscription login).
- **FR-007**: "api_key" mode MUST preserve the existing stored-key behavior unchanged: write-only key, encrypted at rest, injected only at run time, never echoed in responses, presence signaled by the existing boolean. Explicit "api_key" mode MUST reject a save that leaves the profile with no key (none stored and none provided).
- **FR-008**: "host_subscription" mode MUST inject nothing: the CLI authenticates via the host user's subscription login exactly as today.
- **FR-009**: Switching auth mode away from "api_key" MUST retain the stored encrypted key (inert — never injected outside api_key mode); the existing explicit clear operation remains the way to remove it.
- **FR-010**: The dashboard executor form MUST present an auth-mode selector and show only the selected mode's fields (key field for api_key; region/profile/bundle for bedrock; none for host_subscription), with the shared typed contract remaining the single source of truth driving both backend validation and the form's field set (no duplicated field definitions).
- **FR-011**: In bedrock mode the form MUST hint that the profile's model must be a full Bedrock model/inference-profile identifier (with an example), because bare aliases are not resolvable in this mode. The platform MUST NOT hard-block save on model format.
- **FR-012**: A bedrock-mode run that cannot authenticate at the provider (bad region, unknown AWS profile, missing CA bundle file, expired host credentials, unresolvable model) MUST end as a failed run with diagnostics through the existing failure path — never hang and never fall back to another auth mode.
- **FR-013**: Automated tests MUST ship in the same change (Constitution Principle VI): unit-level verification of the exact child environment constructed per auth mode (bedrock values present and correct; host AWS/Anthropic variables absent — extending the existing allowlist-floor proof, test T085 lineage), and an integration test using the existing substitutable fake CLI harness asserting the exact environment a bedrock-mode run receives end-to-end.
- **FR-014**: Documentation MUST ship in the same change: the local setup guide gains a "Bedrock / corporate Claude" section (prerequisites: host AWS profile, CA bundle, model-id guidance, credential-refresh note), and the executor-configuration contract documentation is updated alongside the schema change per constitution gates.

### Key Entities

- **Executor profile (Claude CLI type)**: an existing named runner profile; gains an authentication-mode attribute with three values and, for bedrock mode, three typed settings (region — required; AWS profile name — optional; CA bundle path — optional). The stored API key remains a write-only secret attribute now associated with the "api_key" mode.
- **Authentication mode**: the per-profile choice of how the spawned CLI authenticates — host subscription login (nothing injected), stored API key (platform-held secret injected), or AWS Bedrock (profile-declared non-secret settings injected; credentials resolved on the worker host).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On a machine whose only Claude access is AWS Bedrock, a pipeline run completes successfully end-to-end with the executor profile configured exclusively through the dashboard — zero code changes, zero shell exports, zero allowlist edits.
- **SC-002**: 100% of executor profiles that existed before the feature produce byte-identical child environments for their runs without being edited.
- **SC-003**: For each of the three auth modes, an automated test proves the exact environment the spawned CLI receives — including the absence of every host-shell AWS and Anthropic variable planted by the test.
- **SC-004**: No AWS access key, secret key, or session token can be found in stored profile data, any API response, or any spawned child environment, in any mode (verified by test and by review of the stored shape).
- **SC-005**: A team member on a fresh clone, following only the new documentation section, gets their first successful bedrock-mode run using their own AWS profile and CA bundle within 15 minutes, without touching code or worker shell configuration.

## Assumptions

- The worker host's Claude CLI version supports Bedrock activation via its documented environment settings, and the host user's home directory contains a working AWS configuration (named profile or default chain; SSO sessions refreshed by the human) — same trust posture as the existing subscription-login mode.
- The defaulting rule for legacy rows (FR-002) is computed wherever the profile is read/executed; no data migration or rewrite of stored configurations is required.
- The three bedrock settings (region, AWS profile name, CA bundle path) are not secret material and may appear in normal API responses, unlike the API key.
- The CA bundle path and AWS profile name refer to the worker host's filesystem/configuration; the platform does not validate their existence at save time (the dashboard host cannot inspect the worker's disk), and misconfiguration surfaces as a failed run with diagnostics.
- Model-identifier correctness in bedrock mode is the operator's responsibility, supported by the form hint; the platform does not validate provider-side model formats.
- Runs and their reports continue through the existing completion contract unchanged — this feature only changes how the spawned CLI authenticates, not the run lifecycle.

## Out of Scope

- A direct Anthropic API (non-CLI) executor type — rejected: it re-implements the agent loop and does not simplify Bedrock auth.
- Storing AWS credentials (access keys, secrets, session tokens) in the platform, in any form.
- Passing host shell environment variables through to runs (allowlist extension) — superseded by per-profile injection.
- Managing or refreshing the worker host's AWS credentials (e.g. SSO login) — a host concern covered only by documentation.
