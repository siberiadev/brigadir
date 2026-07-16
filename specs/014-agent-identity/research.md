# Research — Agent Identity (014)

Phase 0 output. Every open question from the spec and the codebase scan is resolved here; no NEEDS CLARIFICATION remain.

## D1 — Orchestrator key: `brigadir`, reserved

**Decision**: The seeded orchestrator's key is the constant `brigadir` (new `ORCHESTRATOR_AGENT_KEY`), role `teamlead`. A dep-free `RESERVED_AGENT_KEYS = ['brigadir']` set lives next to the slug function; `ensureUniqueAgentKey` treats reserved keys as always occupied, so no worker derivation can ever produce bare `brigadir` (a persona slugging to it gets `brigadir-2`).

**Rationale**: The key must be immutable while `role` stays editable — encoding "teamlead" into the key (`brigadir-teamlead`) would freeze a copy of editable data into the immutable handle. `brigadir` is also the value pre-feature reports and logs already contain (today's orchestrator *name*), so history stays coherent. Reservation is structural: the orchestrator is excluded from routing targets (existing FR), so its key must be unobtainable by workers.

**Alternatives considered**: `brigadir-teamlead` (rejected: duplicates role into an immutable field; longer handle with no disambiguation benefit — the key is already unique per workspace); no reservation, rely on seed-first ordering (rejected: the orchestrator row is created at workspace creation, but relying on ordering is fragile vs. a workspace whose orchestrator was deleted/re-seeded; an explicit reserved set is one line and testable).

## D2 — Canonical slug: one dep-free module in contracts

**Decision**: `packages/contracts/src/agent-key.ts` exports:
- `slugifyAgentKey(name: string, role?: string | null): string` — `"${name} ${role ?? ''}"` → NFKD-free simple rule: lowercase, every char outside `[a-z0-9]` → `-`, collapse `-+`, trim `-`. No transliteration (deliberate: deterministic and reviewable; non-Latin input falls through to D6 fallback).
- `ensureUniqueAgentKey(base: string, taken: ReadonlySet<string>): string` — returns `base` or `base-2`, `base-3`, … (smallest free), treating `RESERVED_AGENT_KEYS` as taken.
- `ORCHESTRATOR_AGENT_KEY`, `RESERVED_AGENT_KEYS`.

The module imports nothing (like `pagination.constants.ts`), is exported via the main barrel, and is the ONLY slug implementation in TS. Callers: `setup-apply.service` (in-run team apply), `agents.controller` create (dashboard + admin-MCP both land here — admin-MCP is a thin HTTP client of the same API), `config-seeder` (config-file seeding), `orchestrator-seed` (uses the constant, not the function).

**Rationale**: One rule, one place (spec FR-005). Dep-free keeps it importable anywhere including the web bundle if ever needed. Admin-MCP requires no slug code at all because it delegates writes to the backend API — verified in `packages/admin-mcp/src/tools.ts` (create_agent/create_team POST to the dashboard API).

**Alternatives considered**: a `slugify` npm dependency (rejected: transliteration behavior varies across versions — the key must be reproducible in SQL for the backfill, D3); placing it in `libs/database` (rejected: contracts is the shared typed source; web and admin-mcp can't import server libs).

## D3 — Backfill: SQL re-implementation of the slug, parity-tested

**Decision**: Migration `drizzle/0007_agent_identity.sql` backfills in pure SQL:
1. `role = 'teamlead'`, `key = 'brigadir'` for `is_orchestrator = true` rows.
2. Workers: `key = trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'))`, `role = NULL`. Empty result falls back to `'agent'` (D6).
3. Collision resolution within a workspace (including vs. the reserved orchestrator key): deterministic `row_number() OVER (PARTITION BY workspace_id, key ORDER BY id)` — first keeps the base key, subsequent get `-2`, `-3`, … re-checked until unique (with ≤20 agents per workspace a single windowed pass + fixups is sufficient; the review doc walks the SQL).
4. Then `SET NOT NULL`, add `UNIQUE (workspace_id, key)`, drop `agents_workspace_name`.

An integration test runs the migration against seeded pre-feature-shaped rows (incl. an orchestrator, a name collision after slugging, and a non-Latin name) and asserts every resulting key equals what `slugifyAgentKey` + `ensureUniqueAgentKey` produce for the same inputs.

**Rationale**: Migrations in this repo are plain SQL files (drizzle/ *.sql) applied by drizzle — no TS execution context; the parity test turns the unavoidable one-time duplication of the rule into a checked equivalence instead of a hope. Deterministic (`ORDER BY id`) satisfies spec US4.

**Alternatives considered**: programmatic TS migration (rejected: breaks the repo's migration format and SQL-review convention); backfilling `role` by parsing names like "st3-developer" (rejected per spec assumption: guesswork in SQL; role stays NULL and is editable later; the test workspace can be re-themed via the admin generate flow afterwards).

## D4 — Collision & validation semantics per creation path

**Decision**:
- **All insert paths** (setup-apply, backend create, config-seeder, backfill): derive base key, `ensureUniqueAgentKey` against the workspace's existing keys + reserved set, insert; on a concurrent unique-violation race, re-read keys and retry with the next suffix (bounded retries).
- **validateTeam (in-run + admin generate → same 422 envelope)**: replace both `duplicate_name` checks with: (a) intra-proposal duplicate *persona name* (case-insensitive) → 422 `duplicate_name` (pushes the model to produce distinct personas, spec's SHOULD made enforceable at the only boundary where regeneration is cheap); (b) drop the check against *existing workspace* names entirely — names are non-unique now, and key collisions vs. existing rows are resolved silently by suffixing.

**Rationale**: Suffixing everywhere guarantees FR-008; erroring only on intra-proposal duplicates keeps generation quality without making renames or re-created personas fail. The pre-feature "duplicate vs existing workspace" 422 existed only because name was the identity — that reason is gone.

**Alternatives considered**: 422 on any collision (rejected: makes legitimate re-use of a retired persona name fail); silent suffix intra-proposal too (rejected: a whole team slugging to one key — the spec's degenerate case — would yield `hera-dev`, `hera-dev-2`, … and a visibly broken themed roster; better to bounce it back to the model).

## D5 — `key` in update payloads: rejected by strict schemas (no new code)

**Decision**: `AgentWriteRequestSchema` (dashboard + admin-MCP update path) stays `.strict()` and does NOT gain a `key` field; the update controller never selects/sets `key`. Supplying `key` on update therefore fails Zod validation (422) — the "reject" branch of the spec's open micro-choice, for free. Create responses include the generated `key`.

**Rationale**: Zero code to maintain, explicit contract, and a contract test pins it. Silent-ignore would require deliberately weakening the schema.

## D6 — Empty-slug fallback chain

**Decision**: In `slugifyAgentKey`: if the name+role slug is empty → slug of role alone → literal `agent`. Suffixing then applies as usual (`agent`, `agent-2`, …). Same chain expressed in the backfill SQL (D3).

**Rationale**: Spec FR-008/US2-AS4. Deterministic, no transliteration dependency, and the generation prompt additionally instructs Latin-script persona names (belt and suspenders — the fallback is for the belt breaking).

## D7 — Agents list ordering: `ORDER BY key`

**Decision**: `agents.controller.ts` list switches `ORDER BY name` → `ORDER BY key` (unique per workspace ⇒ fully deterministic).

**Rationale**: Repo pagination rule requires a deterministic ORDER BY; `name` stops being unique in this feature, which would silently violate it. `key` is stable, readable, and roughly alphabetical by persona anyway. (Alternative `ORDER BY name, id` rejected: two-column ordering for no benefit; key IS the canonical sort handle.)

## D8 — Themed generation: prompt-only, in the setup handoff

**Decision**: The team-proposal instruction lives where it already lives — the setup-run handoff prose (`libs/pipeline/src/handoff.ts`, `buildSetupSection`) — extended with: invent ONE coherent random theme for this workspace (examples given as prose, explicitly non-exhaustive), give every agent a themed persona `name` (Latin script) + functional `role`, distinct personas within the team, do NOT emit keys. `generate_agents` (admin-MCP) just starts a setup run, so it inherits the same prompt — one instruction site, both paths covered. `TeamAgentSchema` gains required `role`; keys remain absent from every model-facing contract.

**Rationale**: Spec FR-011/FR-012 and the "no hardcoded theme list" decision: the examples stay in prompt prose (illustrative), never in a code-level list the system selects from. A single prompt site prevents the two generation paths from drifting.

**Alternatives considered**: system-side random theme pick from a list (rejected by spec decision 2: caps variety, ties themes to deployments); per-path prompts in admin-mcp and handoff (rejected: drift risk, and admin-mcp deliberately contains no LLM instructions today).
