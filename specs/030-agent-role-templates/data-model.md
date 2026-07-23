# Data Model: Agent role instruction templates (030)

## 1. Storage changes

### 1.1 `workspaces` — new column (migration 0009)

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `agent_instructions_token` | `bytea` | YES | Sealed secret-box envelope (`version(0x01) ‖ iv(12) ‖ authTag(16) ‖ ciphertext`) of the workspace-level template-repo token. NULL = no token. Same key (`BRIGADIR_CREDENTIALS_KEY`) and codec as `jira_credentials` / `executors.secrets`. NEVER serialized; API projects only `has_agent_instructions_token`. |

Migration `drizzle/0009_agent_instructions.sql`:

```sql
ALTER TABLE "workspaces" ADD COLUMN "agent_instructions_token" bytea;
```

Companions in the same change (project rule 5): `docs/architecture.md` §3 row update,
`drizzle/REVIEW-0009_agent_instructions.md`, `drizzle/meta/` snapshot + journal entry.

### 1.2 `workspaces.settings` jsonb — new optional block (no DDL)

```jsonc
{
  // ... existing keys (repositories, scope_jql, enabled, rework_max, ...) ...
  "agent_instructions": {           // ABSENT = no workspace override
    "git_url": "git@github.com:acme/agents.git",   // required within the block
    "git_ref": "main",              // optional; absent = remote default branch
    "subdir": "roles"               // optional; absent = "roles"
  }
}
```

Extends `WorkspaceSettingsSchema` (packages/contracts/src/jira.types.ts). The block is
non-secret by construction — the token lives in the bytea column, never here.

### 1.3 `global_settings` — two new keys (no DDL; table exists)

| Key | Value shape | Semantics |
|---|---|---|
| `agent_instructions_repo` | `{ git_url, git_ref?, subdir? }` (JSON) | Global template source. Missing/corrupt value ⇒ treated as unset (built-ins), warn-log — the `getBrigadirAgentTemplate` fallback pattern. |
| `agent_instructions_repo_token` | base64 string of a sealed secret-box envelope | Global token. Missing ⇒ no token. Never returned by any API; reads project `has_token`. |

## 2. Contracts-layer entities (packages/contracts)

### 2.1 `AgentInstructionsSource` (new, `role-template.schema.ts`)

| Field | Type | Validation |
|---|---|---|
| `git_url` | string | min 1; MUST match `https://…` or `ssh://…` or scp-like `git@host:path`; `file://`, absolute/relative local paths REJECTED |
| `git_ref` | string? | min 1 when present (branch, tag, or SHA) |
| `subdir` | string? | min 1; no `..` segments, no leading `/` |

### 2.2 `RoleTemplateSummary` / `RoleTemplate`

| Field | Summary | Full | Source |
|---|---|---|---|
| `slug` | ✓ | ✓ | file name without `.md`; unique per source (dup ⇒ lexicographic winner + diagnostic) |
| `role` | ✓ | ✓ | frontmatter `role`, fallback = slug |
| `description` | ✓ | ✓ | frontmatter, optional |
| `model_hint` | ✓ | ✓ | frontmatter, optional, free text |
| `trigger_status_hint` | ✓ | ✓ | frontmatter, optional, free text |
| `body` | — | ✓ | markdown after frontmatter; cap 32 KB with `truncated` flag |

### 2.3 `ResolvedTemplateSource` (service output, also in diagnostics)

| Field | Type | Notes |
|---|---|---|
| `level` | `'workspace' \| 'global' \| 'builtin'` | winning level after resolution AND fallback |
| `git_url` | string? | absent for `builtin` |
| `git_ref` | string? | as configured |
| `subdir` | string? | effective folder |
| `fallback_from` | `'workspace' \| 'global'`? | present when a configured source failed and the chain fell through |
| `diagnostic` | string? | human-readable failure/cap note (bounded) |

### 2.4 Built-in defaults (`default-role-templates.ts`, dep-free)

`DEFAULT_ROLE_TEMPLATES: RoleTemplate[]` — four roles (developer, qa, reviewer,
planner) mirroring the reference repo (`siberiadev/agents`): same frontmatter fields
(hints: opus / deepseek / deepseek / sonnet), same body structure (Workflow / Hard
rules / Completion / Escalation with `> ADAPT:` markers, platform invariants embedded).

### 2.5 Callback tool schemas (`callback-tools.schema.ts` additions)

| Tool | Input | Output |
|---|---|---|
| `list_role_templates` | `{}` (strict) | `{ source: ResolvedTemplateSourceSummary, items: RoleTemplateSummary[] }` |
| `get_role_template` | `{ slug: string }` (strict, min 1) | `RoleTemplate` (with `truncated?`) — unknown slug ⇒ tool error listing available slugs |

### 2.6 Dashboard API shapes (`dashboard.schema.ts` changes)

- `WorkspaceSettingsRequestSchema` += `agent_instructions?: AgentInstructionsSource | null`
  (null = clear override) and `agent_instructions_token?: string | null` (tri-state:
  absent=keep, null/""=clear, value=replace).
- `WorkspaceCreateRequestSchema` += the same two optional fields.
- `WorkspaceResponseSchema` += `agent_instructions: AgentInstructionsSource | null`,
  `has_agent_instructions_token: boolean`, `effective_instructions_level: 'workspace' | 'global' | 'builtin'`
  (config-only projection: which level WOULD win by configuration presence — no git
  probing in the read path).
- Global settings endpoint (paired with the existing brigadir-agent settings surface):
  `GET` ⇒ `{ source: AgentInstructionsSource | null, has_token: boolean }`;
  `PUT` ⇒ `{ source?: AgentInstructionsSource | null, token?: string | null }` (same tri-state).

### 2.7 Admin-MCP tool schemas (`admin-tools.schema.ts` additions)

- `CreateWorkspaceInputSchema` += `agent_instructions?` (url/ref/subdir only — NO token field).
- New `set_agent_instructions_source`: input `{ workspace_id?: string, source?: AgentInstructionsSource | null }`
  — `workspace_id` absent ⇒ global level; `source: null` ⇒ clear. Token comes from the
  server's own env config, never from arguments (smuggled args ignored).

## 3. Relationships & lifecycle

```
global_settings[agent_instructions_repo]────┐
workspaces.settings.agent_instructions ─────┼─► ResolvedTemplateSource (per setup run,
workspaces.agent_instructions_token ────────┤    resolved at run start; fallback chain
global_settings[..._repo_token] ────────────┘    workspace → global → builtin)
                                                        │
                                              clone-cache fetch (backend only)
                                                        │
                                              Catalog (bounded, → handoff block)
                                              + on-demand bodies (→ MCP tools)
                                                        │
                                     orchestrator adapts → complete_task(team)
                                                        │
                                     setup-apply (UNCHANGED) → agents.instruction
```

- Templates influence **team creation only**. `agents.instruction` remains the runtime
  source of truth; no runtime path reads template sources.
- Token pairing rule: a level's token is only ever used with THAT level's URL (the
  override replaces the source as a unit; workspace token is never sent to the global
  URL and vice versa).
- Cache: `instructionsCacheRoot/<sha256(git_url)>` — keyed by URL hash (not name),
  fetched per run, self-healing on rot (clone-cache semantics).

## 4. Validation rules (enforced in contracts layer)

1. `git_url` protocol allowlist (https / ssh / scp-like); reject `file://` & local paths.
2. `subdir` path-safety: no `..`, no absolute paths.
3. Token strings: non-empty when replacing; sealed before persistence; never echoed.
4. Caps (single source of constants in `role-template.schema.ts`): `MAX_TEMPLATE_FILES = 50`,
   `MAX_TEMPLATE_BODY_BYTES = 32_768`, `GIT_OP_TIMEOUT_MS = 30_000`.
5. Frontmatter: unknown keys ignored; non-string values ignored; parse failure ⇒ file
   treated as body-only (never a run failure).
