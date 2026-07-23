# Research: Agent role instruction templates from a git repository (030)

No NEEDS CLARIFICATION markers remained in the Technical Context — all decisions were
made interactively with the operator before specification. This document records each
decision with rationale and the alternatives considered.

## D1 — Delivery transport: backend fetches, agent reads via callback MCP tools

**Decision**: The backend clones/fetches the template repository server-side. The setup
agent consumes templates lazily through two new callback MCP tools
(`list_role_templates`, `get_role_template(slug)`) proxied to run-token-authenticated
callback endpoints, exactly like the existing `get_project_overview`/`search_tickets`.

**Rationale**:
- Private repos need a token; routing the clone through the agent would put the token
  in the agent's environment/context — a direct Constitution V violation (proven leak
  class). Server-side fetch keeps the credential structurally unreachable.
- Setup runs are not guaranteed a mounted worktree (repo-less workspaces exist); an
  agent-side `git clone` has nowhere deterministic to land.
- Lazy per-slug retrieval keeps the prompt small (catalog summary up front, bodies on
  demand) — same bounded-handoff philosophy as the rest of the system.

**Alternatives considered**:
- *Agent clones the repo itself* — simplest, works for public repos, but leaks tokens
  for private ones and requires a mounted workspace. Rejected (operator confirmed).
- *Backend inlines all bodies into the handoff* — no new tools, but unbounded prompt
  growth with large template sets; violates the bounded-handoff convention. Rejected.

## D2 — Consumption mode: reference (adapt), not verbatim

**Decision**: The orchestrator adapts each chosen template to the studied project;
verbatim copy is explicitly out of scope (spec Non-Goals).

**Rationale**: The platform's own quality bar (DEFAULT_WORKSPACE_SETUP_INSTRUCTION,
2026-07-16 comparison of live workspaces) established that generic role prompts are
too weak — project-grounded specifics are what make a strong team. Templates raise the
floor; recon supplies the specifics. The existing `setup-apply` validation/persistence
path stays byte-identical.

**Alternatives considered**: verbatim pinning (deterministic but project-blind) and a
dual mode — both deferred; dual mode remains a possible later feature without contract
breakage (a proposal could carry `template_slug` instead of `instruction`).

## D3 — Source resolution & storage split

**Decision**: Per-workspace resolution `workspace override ?? global setting ??
built-in defaults`. Non-secret config (`git_url`, `git_ref?`, `subdir?`) lives in
`workspaces.settings` jsonb (workspace) and the `global_settings` KV (global). The
optional token is a secret: new nullable `workspaces.agent_instructions_token` bytea
(workspace) and a sealed value under a dedicated `global_settings` key (global), both
sealed with the existing AES-256-GCM secret-box under `BRIGADIR_CREDENTIALS_KEY`.

**Rationale**:
- Mirrors the two established config planes (workspace settings jsonb; global KV with
  live-read getters and built-in fallback — the `workspace_setup_instruction` pattern).
- Tokens must not enter jsonb: settings blobs are serialized into API responses and
  UI forms; the bytea + seal pattern (`jira_credentials`, `executors.secrets`) already
  guarantees write-only handling with `has_*` projections.
- Override replaces the WHOLE source (url+ref+subdir+token as a unit) — mixing one
  level's token with another level's URL would send a credential to the wrong host.

**Alternatives considered**: a dedicated `template_sources` table (overkill for two
levels of one pointer); env-only global config (not operator-editable at runtime,
violates the "settings live in the dashboard" direction of features 010/015).

## D4 — Git access: extracted clone-cache + header-based auth

**Decision**: Extract `ensureCache`/`git()` from `libs/executors/src/claude-cli/worktree.ts`
into a shared clone-cache util; template fetches reuse it against a separate cache root
(`instructionsCacheRoot/<sha256(url)>`). HTTPS auth is injected per invocation via
`git -c http.extraHeader="Authorization: Basic <b64>"` (never in the URL, never in
argv as a plaintext token, never persisted in the repo's `.git/config`); SSH URLs use
the host's ambient SSH agent (no token). `file://` and local paths are rejected at
validation time.

**Rationale**:
- The worktree cache already solved the hard problems: self-healing rot detection,
  `fetch --prune` staleness, argv-safety via `execFile`. Reuse beats reimplementation.
- `http.extraHeader` appears in argv only as the config KEY with the value in the same
  argument — to remove even that exposure, the header value is passed via
  `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` environment variables of
  the short-lived git child process (never the agent's process), keeping `ps` output
  clean. This is the documented git mechanism for ephemeral config.
- Separate cache root prevents template repos from colliding with workspace repo
  caches keyed by repo NAME (template sources are keyed by URL hash).

**Alternatives considered**: `GIT_ASKPASS` helper script (equivalent security, more
moving parts — a temp executable); a JS git library (new dependency, loses parity with
the battle-tested exec-git layer); shallow `git archive --remote` (not supported by
GitHub over HTTPS).

## D5 — Template file format: frontmatter + body, one file per role

**Decision**: `roles/<slug>.md` (configurable `subdir`, default `roles`); optional YAML
frontmatter with `name`, `role`, `description`, `model_hint`, `trigger_status_hint`;
body = the role prompt with `> ADAPT:` markers. Slug = file name. No frontmatter →
role falls back to slug, other fields empty. Built-in defaults ship the same four
roles as the reference repo (`git@github.com:siberiadev/agents.git`).

**Rationale**: Deliberately close to Claude Code's `.claude/agents/*.md` format
(familiar, potentially reusable), while excluding fields that are platform matters in
BRIGADIR (`tools`, `model` are fixed by executor profiles at spawn — a template must
not grant capabilities). Format agreed with the operator; the reference repo already
exists in this exact shape.

**Frontmatter parsing**: a ~40-line permissive parser (split on `---` fence, `key: value`
lines, strings only) — the five known keys need no YAML library; unknown keys are
ignored. Avoids adding a yaml dependency to the contracts/lib layer.

**Alternatives considered**: JSON sidecar metadata (two files per role — clumsy in
review); a single `agents.yaml` manifest (merge conflicts, loses one-file-per-role
review ergonomics).

## D6 — Executor selection by approximate hint

**Decision**: `model_hint` is free-text guidance (`opus`, `sonnet`, `deepseek`,
`capable`, `fast`, `cheap`, …). DEFAULT_WORKSPACE_SETUP_INSTRUCTION gains a
"How to choose each agent's executor" section: map the hint to the closest ENABLED
profile from the handoff catalog by type/model and role needs; always return an exact
profile NAME; note substitutions in the final summary; never block on a missing match.
The reference repo's hints: developer→opus, planner→sonnet, qa/reviewer→deepseek.

**Rationale**: Profile names are installation-specific; templates are shared across
installations. The orchestrator already receives the full profile catalog (name, type,
model) in the handoff — mapping is a judgment call it is well positioned to make, and
`setup-apply` already hard-validates the returned name (`executor_unknown` /
`executor_disabled`), so a bad mapping fails loudly, not silently.

**Alternatives considered**: exact profile names in templates (breaks portability);
a deterministic mapping table in code (false precision — "closest capable model" is
inherently contextual; the validator remains the hard guarantee either way).

## D7 — Failure posture and caps

**Decision**: Template source failures (unreachable, bad ref, empty, malformed,
over-caps) NEVER block team generation. Fallback order = next source in the chain,
ultimately built-ins; every fallback emits a run diagnostic (visible in the run
timeline/summary). Caps: ≤ 50 template files per source (deterministic
lexicographic-order truncation), ≤ 32 KB per body (truncate with marker),
≤ 30 s per git operation. Catalog block in the handoff is budget-truncated like other
handoff fields. Duplicate slugs: lexicographically first file wins + diagnostic.

**Rationale**: Mirrors the established best-effort posture of repo recon in setup runs
("never block setup on it, never fabricate"). Setup is rare and human-reviewed — a
degraded-but-successful run with a visible note beats a blocked pipeline.

**Alternatives considered**: fail-fast on a configured-but-broken source (punishes a
typo with a dead feature; the operator sees the diagnostic either way).

## D8 — Tool exposure scope

**Decision**: The two new MCP tools join `CALLBACK_TOOL_NAMES` in
`libs/executors/src/claude-cli/args.ts`, i.e. they are available to every
callback-wired run (setup AND worker runs), like the read-only Jira tools.

**Rationale**: The tools are read-only catalog lookups scoped by the run's own
workspace; a worker consulting a role template is harmless. Gating them to setup runs
only would require a new per-run tool-set mechanism — complexity with no security
payoff (the token never transits the tools; bodies are operator-curated text).

**Alternatives considered**: setup-only exposure via a run-source conditional in args
assembly — deferred unless a real abuse pattern appears.

## D9 — Token API semantics

**Decision**: Write-only tri-state on both levels (absent=keep, empty string/null=clear,
value=replace); reads expose only `has_agent_instructions_token` (workspace response) /
`has_token` (global settings response). Identical to the executor-secrets pattern.

**Rationale**: Constitution V + an already-proven API shape (`executors.secrets`,
`jira_credentials` rotation) — the dashboard and admin-MCP already know how to drive it.

## D10 — Admin-MCP surface

**Decision**: `create_workspace` gains an optional `agent_instructions` pass-through
(url/ref/subdir only); a new `set_agent_instructions_source` tool sets/clears the
workspace or global source. Tokens NEVER come from tool arguments — an optional
`BRIGADIR_AGENT_INSTRUCTIONS_TOKEN` env on the admin-MCP server config is injected
server-side exactly like the Jira credentials in `create_workspace` (a smuggled token
argument is ignored).

**Rationale**: Preserves the admin-MCP's Principle-V posture: the model orchestrates,
the operator's own config supplies secrets.
