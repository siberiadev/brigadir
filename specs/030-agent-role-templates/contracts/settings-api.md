# Contract: Template-source settings API (global + workspace) (030)

All endpoints under the existing `DashboardTokenGuard` (Bearer). Token values are
write-only everywhere; no response ever contains a token.

## 1. Global level

### `GET /api/agent-instructions-settings`

```jsonc
200 → {
  "source": { "git_url": "…", "git_ref": "main", "subdir": "roles" } | null,
  "has_token": true
}
```

`null` source = built-in defaults are the global effective source.

### `PUT /api/agent-instructions-settings`

```jsonc
{
  "source": { "git_url": "…", "git_ref": "…", "subdir": "…" } | null,  // optional; null = clear
  "token": "ghp_…" | null | ""                                          // optional tri-state
}
```

- `source` absent → unchanged; `null` → cleared (built-ins become global default).
- `token` absent → keep; `null`/`""` → clear; value → seal & replace.
- Clearing `source` while a token exists → 200 with `"warning": "token retained"` in
  the body (the UI offers explicit clearing; the system never silently drops a
  credential, and never silently reuses it for a future different URL — see pairing
  rule below).
- Validation: URL protocol allowlist, subdir path-safety (422 with path-qualified
  issues on failure).

## 2. Workspace level

### `GET /api/workspaces/:id` (extended response)

```jsonc
{
  // …existing fields…,
  "agent_instructions": { "git_url": "…", "git_ref": "…", "subdir": "…" } | null,
  "has_agent_instructions_token": false,
  "effective_instructions_level": "workspace" | "global" | "builtin"
}
```

`effective_instructions_level` is a CONFIG projection (which level wins by presence
of configuration), computed without touching git — the read path stays fast and
side-effect-free.

### `PUT /api/workspaces/:id/settings` (extended request)

```jsonc
{
  // …existing optional fields…,
  "agent_instructions": { "git_url": "…", "git_ref": "…", "subdir": "…" } | null,  // null = clear override
  "agent_instructions_token": "…" | null | ""                                       // tri-state
}
```

Same semantics and validation as the global PUT. Setting `agent_instructions: null`
clears the override (workspace falls back to global/built-in); the workspace token
column is cleared ONLY via the explicit token tri-state.

### `POST /api/workspaces` (extended create request)

Optional `agent_instructions` and `agent_instructions_token` accepted at creation with
identical semantics.

## 3. Token/URL pairing rule (server-enforced)

A token is only ever used with the SAME level's URL: workspace token ↔ workspace URL,
global token ↔ global URL. When resolution falls back from workspace to global, the
workspace token is NOT applied to the global URL. Rationale: a credential must never
be sent to a host the operator did not pair it with.

## 4. Admin-MCP surface

### `create_workspace` (extended input)

`agent_instructions?: { git_url, git_ref?, subdir? }` — passed through to the create
API. NO token parameter exists in the tool schema; if the admin-MCP server config has
`BRIGADIR_AGENT_INSTRUCTIONS_TOKEN` set, the server injects it (config-sourced, like
the Jira credentials). A smuggled `agent_instructions_token` argument is ignored.

### `set_agent_instructions_source` (new tool)

```jsonc
input:  { "workspace_id": "…" /* absent = global */, "source": { … } | null }
output: { "level": "workspace" | "global", "source": { … } | null }
```

Maps to `PUT /api/workspaces/:id/settings` or `PUT /api/agent-instructions-settings`.
Token handling identical to create_workspace (config-sourced only).

## 5. Dashboard UI contract (behavioral)

- **General → Agent instruction templates**: source form (url/ref/subdir), token
  block showing only "token set ✓ / no token" with Replace / Clear actions, and
  "Reset to built-in defaults" (= clear source).
- **Workspace → Settings → Agent instructions source**: same form + an
  effective-source indicator driven by `effective_instructions_level`
  ("This workspace uses: its own repo / the global repo / built-in defaults"),
  and "Use global default" (= clear override).
- Validation errors render path-qualified messages from the API (existing pattern).
- No template CONTENT is shown anywhere — the git repo is the editor (spec Non-Goal).
