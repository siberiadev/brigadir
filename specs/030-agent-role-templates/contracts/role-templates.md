# Contract: Role template files, catalog, and run-facing tools (030)

## 1. Template file contract (the repo IS the interface)

Location: `<subdir>/<slug>.md` (default `subdir` = `roles/`). Only direct `*.md`
children of the folder are read; subfolders and other files are ignored. Slug = file
name without extension.

```markdown
---
name: developer                  # optional; informational (slug comes from the file name)
role: Developer                  # optional; catalog label — fallback: slug
description: One catalog line.   # optional
model_hint: opus                 # optional; APPROXIMATE hint, free text
trigger_status_hint: In Progress # optional; APPROXIMATE hint, free text
---

# Role: Developer
... markdown role prompt; "> ADAPT:" lines mark project-specific fill-ins ...
```

Rules:
- Frontmatter is optional. A file that does not start with a `---` line is all body.
- Parser is permissive: `key: value` string lines only; unknown keys ignored;
  malformed frontmatter ⇒ file treated as body-only (diagnostic, never a failure).
- Body cap 32 KB (truncated with a visible marker + `truncated: true`).
- Per-source caps: max 50 files (lexicographic order, overflow dropped + diagnostic);
  duplicate slugs impossible within one folder by construction.
- Templates MUST NOT carry executor/tool grants — `model_hint` and
  `trigger_status_hint` are advisory text; capabilities are fixed by executor
  profiles at spawn time (platform invariant).

## 2. Callback HTTP endpoints (run-token auth, mirrors jira read tools)

Base: `api/callbacks/runs/:runId` (existing controller; existing run-token guard).
The workspace is derived from the run — no workspace parameter exists.

### `GET api/callbacks/runs/:runId/templates`

- 200 →
  ```jsonc
  {
    "source": { "level": "workspace|global|builtin", "git_url": "…", "git_ref": "…", "subdir": "…", "fallback_from": "workspace", "diagnostic": "…" },
    "items": [ { "slug": "developer", "role": "Developer", "description": "…", "model_hint": "opus", "trigger_status_hint": "In Progress" } ]
  }
  ```
- Source resolution + fetch happen server-side at call time; a failed configured
  source falls back down the chain (ultimately built-ins) and the response's
  `source` block says so — this endpoint NEVER 5xxes on a bad template repo.
- 401/403/404: standard run-token guard behavior (unchanged).

### `GET api/callbacks/runs/:runId/templates/:slug`

- 200 → `{ "slug": "…", "role": "…", "description": "…", "model_hint": "…", "trigger_status_hint": "…", "body": "…", "truncated": false }`
- 404 (body carries the machine-readable issue) when the slug is not in the effective
  source: `{ "ok": false, "error": "unknown role template \"x\"", "available": ["developer", "qa", …] }`
- Same never-5xx-on-bad-repo posture as the list endpoint.

## 3. MCP tools (packages/mcp-server → the two endpoints above)

| Tool | Input schema | Behavior |
|---|---|---|
| `list_role_templates` | `{}` strict | GET templates; 2xx → structuredContent; 4xx → tool error (no retry); 5xx/network → bounded retry then error. Identical error posture to `get_project_overview`. |
| `get_role_template` | `{ slug: string (min 1) }` strict | GET templates/:slug; 404 body (with `available`) surfaces to the model as a repairable tool error. |

Registration: added to `CallbackTools` (contracts) and to `CALLBACK_TOOL_NAMES`
(`libs/executors/src/claude-cli/args.ts`) — available to every callback-wired run.

## 4. Handoff catalog block (workspace-setup section)

Appended to `buildWorkspaceSetupSection` AFTER the executor-profiles list, BEFORE the
setup protocol text; budget-truncated like every other handoff field:

```
Role templates available (source: <workspace repo <url> | global repo <url> | built-in defaults>):
- developer — Implements a ticket end to end, runs the project gates, and opens a PR. (hint: opus)
- qa — Verifies a change against acceptance criteria and the project gates. (hint: deepseek)
…
Fetch a template's full text with get_role_template(slug); adapt it to THIS project.
```

Failure shape: when even built-ins somehow fail to render (programming error), the
block is omitted entirely — the setup instruction's template section is written to
degrade gracefully ("if no catalog is present, proceed as before").

## 5. Setup instruction additions (DEFAULT_WORKSPACE_SETUP_INSTRUCTION)

Two new sections (stored-value semantics unchanged: operator-editable global setting,
read live per run; edits to the DEFAULT apply only where the operator has not
overridden the stored text):

1. **"How to use role templates"** — consult the catalog above; `list_role_templates`
   / `get_role_template` for the roles this project needs; ADAPT to recon findings
   (real gate commands, per-repo rules, conventions); never deliver an un-adapted
   copy; skip irrelevant roles; if the catalog is absent, proceed without templates.
2. **"How to choose each agent's executor"** — profiles are picked from the handoff
   catalog by NAME; `model_hint` is approximate (map to the closest enabled profile
   by type/model + role needs); note substitutions in the final summary; never block
   on a missing match; the returned name must match a listed profile EXACTLY.

## 6. Security invariants (tested)

- Template-repo token: sealed at rest; decrypted only inside the backend fetch path;
  transported to git via ephemeral child-process env (`GIT_CONFIG_*`), NEVER via argv,
  NEVER via the agent's environment, NEVER logged; absent from every API response and
  run event. The scrubber remains a second line of defense, not the mechanism.
- URL allowlist enforced at write time (API validation) AND at fetch time (defense in
  depth — a legacy/hand-edited blob cannot smuggle `file://`).
- The MCP tools carry template TEXT only — no URLs-with-credentials, no tokens, no
  filesystem paths from the cache.
