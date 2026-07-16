# Contracts Delta — Agent Identity (014)

All schemas are Zod 4 in `packages/contracts`. This file specifies the *contract* changes; implementation bodies belong to tasks.

## 1. NEW `packages/contracts/src/agent-key.ts` (dep-free module)

```ts
/** The canonical agent-key slug. The ONLY slug rule in the project (spec FR-005). */
export function slugifyAgentKey(name: string, role?: string | null): string;
// rule: `${name} ${role ?? ''}` → lowercase → /[^a-z0-9]+/g → '-' → collapse → trim '-'
// empty result → slugifyAgentKey(role) → 'agent'   (research D6)
// "Hera" + "Reviewer" → "hera-reviewer"; "Ахиллес" + null → "agent"

/** Smallest free suffix: base, base-2, base-3, … Reserved keys count as taken. */
export function ensureUniqueAgentKey(base: string, taken: ReadonlySet<string>): string;

export const ORCHESTRATOR_AGENT_KEY = 'brigadir';
export const RESERVED_AGENT_KEYS: readonly string[] = [ORCHESTRATOR_AGENT_KEY];
```

Exported from the main barrel. Consumers: `setup-apply.service`, `agents.controller`, `config-seeder`, `orchestrator-seed` (constants only), migration parity test.

## 2. `report.schema.ts` (LLM-facing — model never sees or emits `key`)

- `TeamAgentSchema`:
  - `name` description → persona display name (themed, Latin script, distinct within the team), no longer "unique agent name".
  - NEW `role: z.string().min(1).max(100)` — required in team proposals ("Developer", "QA", "Reviewer", …).
  - NO `key` field (system-derived).
- `ReportRoutingSchema.target_agent` — description/doc-comment updated: it is the target worker's **key** exactly as shown in the roster; resolved to id by the system. Field name unchanged (`target_agent`) — pre-feature stored reports carry old names, which equal backfilled keys, so history stays resolvable.
- Validation applies at submission (`complete_task`) only; stored reports are read leniently as today (Constitution IV note in plan).

## 3. `admin-tools.schema.ts` (admin-MCP tool contracts)

- `AgentWriteInputSchema` (create_agent): `name` description → persona; NEW optional `role` (text ≤100). No `key` input — ever.
- Update input: unchanged shape + optional `role`; schemas stay `.strict()` so a supplied `key` fails validation (research D5).
- Agent list/read item: + `key`, + `role`.
- create_agent / create_team responses: + `key` (system-generated) per created agent.
- `generate_agents`: contract unchanged (starts a setup run); themed-persona behavior comes from the setup handoff prompt (research D8).

## 4. `dashboard.schema.ts`

- `AgentResponseSchema`: + `key: z.string()`, + `role: z.string().nullable()`.
- `AgentWriteRequestSchema`: + `role: z.string().max(100).optional()`; remains `.strict()`, no `key` — create derives it server-side, update cannot touch it.
- `TeamWriteRequestSchema` (admin create_team path) inherits the `TeamAgentSchema` change (+ role).
- Run/human-task DTOs that embed `agent: { id, name }` → `{ id, key, name, role }` (display).

## 5. `agents-config.schema.ts` (config-file seeding)

- Per-agent entry: + optional `role`.
- Duplicate detection switches from `name` to derived key: `slugifyAgentKey(name, role)` must be unique within the config's workspace section (a config is authored by humans — collisions are authoring errors, so this stays a hard validation error, unlike runtime suffixing).
- `config-seeder` idempotent lookup switches from `(workspace_id, name)` to `(workspace_id, key)` with the derived key.

## 6. Handoff prose contracts (`libs/pipeline/src/handoff.ts`)

- **Roster line** (triage + answer-triage): `- <key> — <name> (<role>): <description>`; header instructs: *"route to one of these by key (`target_agent` = key exactly as listed)"*.
- **Setup section** (team generation, both entry paths): add the themed-team instruction — invent ONE coherent random theme for this workspace (prose examples, explicitly non-exhaustive; no list in code), each agent gets persona `name` (Latin script, distinct within the team) + functional `role`; do NOT invent keys — the system derives them.

## 7. Behavior contracts (tested)

| Contract | Guarantee |
|---|---|
| Routing resolution | `target_agent` matched by exact `key` among enabled, non-orchestrator agents of the workspace; hit → continue by `id`; miss/disabled/orchestrator → human-task escalation (unchanged unknown-target behavior) |
| Key immutability | No update path selects or sets `key`; supplying `key` on update → Zod 422 (strict schema) |
| Key generation | Every creation path derives via the ONE function + `ensureUniqueAgentKey`; DB `UNIQUE(workspace_id, key)` is the final guard with bounded retry on race |
| Reserved key | `brigadir` unobtainable by workers on any path (incl. backfill) |
| Ordering | Agents list `ORDER BY key` (deterministic pagination) |
| Migration parity | SQL backfill produces byte-identical keys to the TS functions for the same inputs |
