# Contract: Agent repository scope

**Feature**: 019-multi-repo-runs. Governs how an agent declares which workspace
repositories its runs operate on, across all three write surfaces.

## Behavior fields

| Field | Type | Status | Semantics |
|---|---|---|---|
| `behavior.repositories` | `string[]` | new | Subset of `workspace` repository names. Empty array ≡ absent. |
| `behavior.repository` | `string` | **deprecated** (kept valid) | One-element list. Never rewritten in stored rows. |

Precedence: `repositories` (non-empty) > `repository` (non-empty) > absent → ALL
workspace repositories. Both present → `repositories` wins silently (no error).

## Surfaces

### 1. YAML boot config — `AgentsConfigSchema` (packages/contracts/src/agents-config.schema.ts)

- `AgentBehaviorSchema` gains typed optional keys `repository: z.string().min(1)` and
  `repositories: z.array(z.string().min(1))` (previously `repository` rode
  `.passthrough()`).
- `superRefine` cross-field check (mirrors the existing claude_cli executor check at
  L196-207): every entry of `agents[i].behavior.repositories` and a non-empty
  `agents[i].behavior.repository` must match a `workspace.repositories[].name`.
  Issue path: `['agents', i, 'behavior', 'repositories', j]` (resp. `'repository'`).
  Skipped when the workspace declares no repositories (repo-less workspaces stay
  valid; run-time resolution is then the guard).
- `ClaudeCliExecutorConfigSchema.repository` (L75) becomes `optional()` — it is
  runtime-ignored since 2026-07-13 and seeder-stripped; the existing reference check
  applies only when present. Existing YAMLs (field present) stay valid.

### 2. Dashboard API — `AgentBehaviorRequestSchema` (packages/contracts/src/dashboard.schema.ts:145)

- Gains `repositories: z.array(z.string().min(1)).optional()`; `repository` stays
  `z.string().nullable().optional()` with a deprecation comment.
- `agents.controller.ts` (create + update): resolves the target workspace's
  `settings.repositories` and rejects unknown names in EITHER field with HTTP 400 and
  a field-level error (`behavior.repositories[j]`). Closes the pre-existing gap where
  a typo'd `repository` surfaced only at run prepare.
- Response echo: behavior is opaque jsonb — `repositories` flows through
  `toAgentResponse` with zero changes.

### 3. Web form — `AgentForm.vue`

- Single `el-select` for repository (L398-403) becomes a multi-select bound to
  `form.repositories: string[]`; loads from `a?.behavior?.repositories`, falling back
  to `a?.behavior?.repository` (rendered as a one-element selection); saves
  `behavior.repositories` (and `behavior.repository: null` to retire the legacy key on
  edit of THAT agent only — an untouched agent keeps its stored form).
- Placeholder/empty selection = "all repositories" (labelled in the UI).

## Run-time resolution (claude-cli executor)

- `resolveRepositoryName(behavior): string` → `resolveRepositoryNames(behavior): string[]`
  (pure, unit-tested): applies the precedence table above, returns `[]` for "all".
- `pickWorkspaceRepository(...)` → `pickWorkspaceRepositories(dbRepos, yamlRepos,
  names, yamlLoaded): WorktreeRepo[]`: DB-list-wins rule per name; `names.length === 0`
  → the full winning list; unknown name → throw (same message family as today —
  defense-in-depth behind config validation). Order: workspace declaration order.
- Setup runs: unchanged one-element resolution (template setup behavior), FR-017
  degrade path intact.

## Out of contract

- admin-mcp `create_agent`/`update_agent` have no `behavior` field today; adding one
  is out of scope for this feature.
- Repo-subset inference from Jira metadata: out of scope (spec).
