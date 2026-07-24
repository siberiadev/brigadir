# Phase 0 Research: Environment variables for agent runs

All decisions below were resolved against the live codebase (file:line references verified 2026-07-24). No NEEDS CLARIFICATION markers remained in the spec; research focused on integration mechanics.

## D1. Where user env is composed and injected

**Decision**: Compose the merged user env inside `ClaudeCliExecutor.loadRunConfig()` (`libs/executors/src/claude-cli/claude-cli.executor.ts:632-831`) and inject it in `runProcess()` as a new `applyUserEnv(env, userEnv)` step placed AFTER `buildChildEnv(process.env)` (line 404) and BEFORE `applyAuthEnv` (line 409) / `applyProviderEnv` (line 413).

**Rationale**:
- `loadRunConfig` is the only place that already resolves the run's mounted repositories (`resolveRepositories()` :875-901, `pickWorkspaceRepositories()` :108-142), reads `agents.behavior` (:653) and workspace settings — everything the merge needs is in scope there. Composing in worker processors would duplicate repo resolution or split it across layers.
- Injection order makes platform values structurally unoverridable: user env goes in first among post-allowlist steps, then `applyAuthEnv`/`applyProviderEnv` overwrite any colliding key. This is defense-in-depth layer 2; layer 1 is the reserved-key denylist at every write surface, layer 3 is a reserved-key filter inside `applyUserEnv` itself.
- `ALLOWLIST_KEYS` (`env-allowlist.ts:20-59`) is explicitly NOT extended — its doc-comment declares it a floor; the existing security test pattern (T085) is extended to prove user env cannot smuggle host values.

**Alternatives considered**:
- *Populate the vestigial `RunContext.env`* (`agent-executor.interface.ts:32`, currently `env: {}` in both processors — `claude-cli-run.processor.ts:666`, `run.processor.ts:250`). Rejected: processors don't know the mounted-repo set (repo resolution is executor-internal), so the repo layer of the merge can't be composed there without duplicating resolution logic. `RunContext.env` stays as-is; `docs/architecture.md` §4 gets a clarifying note.
- *Extend `ALLOWLIST_KEYS` with user keys*. Rejected outright: the allowlist is a floor by design (Constitution V); dynamic extension would turn a static security guarantee into config-dependent behavior.

## D2. Storage model for env values

**Decision**: Non-secret env: plain jsonb, colocated with the entity it configures — `workspaces.settings.env` (workspace defaults), `workspaces.settings.repositories[].env` (per-repo), `agents.behavior.env` (per-agent). Secret env: ONE new nullable column `workspaces.env_secrets bytea` (migration `drizzle/0010_env_variables.sql`), a sealed JSON document `{ workspace?: Record<key,value>, repos?: Record<repoId, Record<key,value>>, agents?: Record<agentId, Record<key,value>> }` using the existing envelope (`sealSecret`/`openSecret`, `libs/jira/src/secret-box.ts`, key `BRIGADIR_CREDENTIALS_KEY`), with a dedicated codec `libs/executors/src/env-secrets.ts` mirroring `executor-secrets.ts`.

**Rationale**:
- Repositories are not a table (array in `workspaces.settings`, `getRepositories()` in `libs/database/src/workspace-settings.ts:143-148`), so per-repo secret columns are impossible; one blob per workspace = one crypto envelope, one decrypt per run start, logical granularity down to repo/agent inside the JSON.
- Colocating non-secret env with its entity (repo entry, behavior blob) makes rename/delete lifecycle automatic for the plaintext part and keeps UI reads trivial (no join).
- Same envelope/key as `jira_credentials`, `executors.secrets`, `agent_instructions_token` — no new key management (spec assumption).
- JSON-document blob (not raw values) matches the `executor-secrets.ts` precedent: shape extends without envelope version bumps.

**Alternatives considered**:
- *Sealed blob per repo entry inside jsonb (base64)*. Rejected: N crypto envelopes with independent corruption/rotation surfaces; settings PUT would rewrite sealed material through generic jsonb paths, violating the write-only discipline (generic settings reads would have to round-trip ciphertext).
- *New `env_vars` table*. Rejected: repositories have no FK-able identity; a table keyed by (workspace_id, scope, ref) duplicates what jsonb + one blob achieve, and §3 schema-change review overhead isn't justified for an internal-tool scale (tens of vars).

## D3. Repository identity (secrets keying + rename survival)

**Decision**: Add an optional stable `id` (uuid) to `WorkspaceRepositorySchema` (`packages/contracts/src/jira.types.ts:112-119` — schema is `.strict()`, extended explicitly). Backfill lazily: a normalization pass in `workspace-settings.ts` assigns ids to entries missing them on first settings write (and `getRepositories()` tolerates absence). `env_secrets.repos` is keyed by this id.

**Rationale**: Spec requires env to survive a repository rename. Plaintext env survives automatically (same array entry), but the sealed blob is keyed externally — keying by mutable `name` would orphan secrets on rename or force fragile server-side rekey inference on a whole-array PUT (rename indistinguishable from delete+add). A stable id makes rename trivially safe and gives the new per-card edit dialog a proper handle.

**Alternatives considered**: *Key by repo name + rekey on rename*. Rejected: the existing settings surface replaces the whole array (`WorkspaceSettingsRequestSchema`), so rename detection is heuristic; a wrong guess silently detaches secrets — exactly the class of quiet failure the constitution's fail-loud posture forbids.

## D4. Merge precedence & scope gating

**Decision**: Effective user env = `workspace.env` ⊕ mounted repos' `env` in mount order (later wins) ⊕ `agent.env`; then the executor's platform steps (`applyAuthEnv`, `applyProviderEnv`) overwrite on top. Composition applies ONLY to repo-mounted runs: triage (`workspace_mode: 'none'`) and no-repo-degraded setup runs get zero user env — gated at the same point where `DEFAULT_REPO_RUN_ALLOWED_TOOLS` already applies only post-repo-resolve (`docs/architecture.md:405` / ST3-768 precedent). Fixed at spawn, like allowed-tools argv.

**Rationale**: Matches the spec's decided layering and mirrors an existing, operator-understood rule ("defaults apply only to repo-mounted runs"), so the mental model stays uniform.

## D5. Reserved keys & validation

**Decision**: Single source of truth `RESERVED_ENV_KEYS` + `ENV_KEY_REGEX` (`/^[A-Za-z_][A-Za-z0-9_]*$/`) + caps (8 KB/value, 64 KB merged) in a new dep-light `packages/contracts/src/env.schema.ts` (exported like `pagination.constants.ts` for direct web import). Reserved set: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `AWS_REGION`, `AWS_PROFILE`, `NODE_EXTRA_CA_CERTS`, `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `SSH_AUTH_SOCK`, plus prefix rules `ANTHROPIC_*`, `AWS_*`, `CLAUDE_*`, `FAKE_CLAUDE_*`, `BRIGADIR_*`. Enforced: (1) zod refinement in every write schema (dashboard + admin-MCP), (2) inline UI validation reusing the same constants, (3) defensive filter inside `applyUserEnv` (drops + logs, covers legacy/hand-edited data).

**Rationale**: One constant, three enforcement points — same pattern as `API_KEY_ONLY_EXECUTOR_TYPES` (FR-016 of feature 028: extend by constant, not by scattered ifs). Prefix rules future-proof against new platform injections (`FAKE_CLAUDE_*` protects the test harness channel; `BRIGADIR_*` reserves the platform namespace).

## D6. Secret scrubbing per run

**Decision**: Add `makeScrub(extraLiterals: string[]): (text: string) => string` to `libs/scrubber/src/scrubber.ts` — redacts exact literal occurrences (length ≥ 4) of the run's decrypted secret env values, then delegates to the existing global `scrub()`. `ClaudeCliExecutor` builds the per-run function and passes it where `scrub` is used today (`ClaudeStreamParser({ scrub })`, `claude-cli.executor.ts:433`; plus the stderr-tail/diagnostics paths).

**Rationale**: The current `scrub` is a pure global (regex + entropy) with no value registration; secret env values (e.g. a low-entropy password) may not match any generic pattern, so exact-literal redaction keyed to the run's own secrets is required by FR-007. Wrapper keeps the global function pure and every existing call site unchanged.

**Alternatives considered**: *Rely on entropy heuristic alone*. Rejected: fails for short/dictionary passwords; FR-007/SC-003 demand zero leakage of the actual configured values.

## D7. Fail-fast on unopenable secrets

**Decision**: If a run's merge references the sealed blob and `openSecret` throws (`SecretBoxError`: wrong key, tamper) — the run fails before spawn with a diagnosable error message naming the workspace and the operation (never the values). No silent "run without the secrets" degradation.

**Rationale**: Spec edge case; matches the constitution's fail-loud posture and the existing pattern (api_key-only executors fail fast when the key can't be opened).

## D8. Admin-MCP secret transport

**Decision**: New tool `set_env` (scope: workspace | repository | agent). Non-secret pairs travel as tool args. Secret values NEVER travel through the model: the tool arg carries `{ key, secret_from_env: "SOME_VAR" }` and the MCP server process resolves `SOME_VAR` from its own environment (the operator exports it before launching Claude Code) — same discipline as `BRIGADIR_AGENT_INSTRUCTIONS_TOKEN` in feature 030. `create_workspace.repositories[].env` accepts the same shape.

**Rationale**: Preserves the established "secrets are injected by the server from operator env, the model only names them" contract (CLAUDE.md admin-MCP section); satisfies US5 acceptance scenario 3 verbatim.

## D9. UI structure

**Decision**: As decided in spec discussion: `WorkspaceForm.vue` keeps repo rows in create mode only (edit mode drops them); `WorkspaceSettings.vue` gains (a) an "Environment defaults" block and (b) a "Repositories" card block — card shows name/git_url/branch/Default tag/env summary ("N vars, M secret"), per-card `FormDialog` (modal pattern of e451550) contains repo fields + a shared `EnvVarsTable` component (key/value/secret rows, inline reserved-key + format validation, masked secret rows with replace/delete only); `AgentForm.vue` gains a collapsed advanced section hosting the same `EnvVarsTable` with "overrides workspace/repo" badges. "Applies to new runs" hint near save. A "Make default" card action reorders the array (index 0 = default, unchanged convention).

**Rationale**: Single post-creation home for repositories removes the two-homes drift hazard; the shared table component keeps validation/masking identical across all three surfaces.

## D10. Read-surface masking shape

**Decision**: All read endpoints return non-secret env verbatim plus `secret_keys: string[]` (names only) per scope. No endpoint ever returns secret values; UI renders masked rows from `secret_keys`. Responses carry no `has_env_secrets` boolean — the key list itself is the indicator (needed anyway for masked rows and override badges).

**Rationale**: Key names are required for the UI (masked rows, summaries, override markers) and are non-sensitive by policy (operators name keys; policy documented). Values stay write-only end-to-end.
