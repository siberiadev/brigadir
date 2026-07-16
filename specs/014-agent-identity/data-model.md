# Data Model — Agent Identity (014)

## `agents` table delta (architecture.md §3 must be updated in the same change)

```sql
CREATE TABLE agents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  executor_id     uuid NOT NULL REFERENCES executors(id),
  name            text NOT NULL,               -- CHANGED: persona display name ("Achilles"), editable, NOT unique
  role            text,                        -- NEW: function ("Developer", "QA", …; orchestrator: "teamlead"); editable, nullable
  key             text NOT NULL,               -- NEW: immutable readable handle, system-generated once at creation
  description     text,
  instruction     text NOT NULL,
  is_orchestrator boolean NOT NULL DEFAULT false,
  -- ... (all other columns unchanged) ...
  UNIQUE (workspace_id, key)                   -- NEW; replaces UNIQUE (workspace_id, name)
);
```

Drizzle schema (`libs/database/src/schema/agents.ts`): add `role: text('role')`, `key: text('key').notNull()`; unique constraint `agents_workspace_key` on `(workspaceId, key)`; remove `agents_workspace_name`.

## Field semantics

| Field | Mutability | Uniqueness | Who sets it | Where it may appear |
|-------|-----------|------------|-------------|---------------------|
| `id` | immutable | global (PK) | database | everywhere internal: FKs (`runs.agent_id`, `human_tasks.target_agent_id`), joins, lookups, onConflict targets |
| `key` | immutable after insert | per workspace | system only (`slugifyAgentKey` + `ensureUniqueAgentKey`), never LLM/client | LLM boundary (roster, `routing.target_agent`), UI read-only field, URLs, logs; resolved to `id` immediately at entry |
| `name` | editable | none | human or generation model (persona) | display only |
| `role` | editable, nullable | none | human or generation model | display ("name (role)"); `"teamlead"` on the seeded orchestrator carries no system meaning (the flag `is_orchestrator` does) |

## Key lifecycle

1. **Creation** (only time a key is computed) — paths: in-run team apply (`setup-apply.service#insertTeamAgents`), backend create (`agents.controller#create` — serves both dashboard and admin-MCP), config-file seeding (`config-seeder`), orchestrator seeding (constant `brigadir`), migration backfill.
   - `base = slugifyAgentKey(name, role)`; empty → `slugifyAgentKey(role)` → `'agent'`.
   - `key = ensureUniqueAgentKey(base, existingWorkspaceKeys ∪ RESERVED_AGENT_KEYS)` → suffix `-2`, `-3`, ….
   - Insert; on unique-violation race: re-read keys, next suffix, bounded retry. DB constraint is the final arbiter.
2. **Update** — `key` is absent from every write-request schema (all `.strict()`), and update statements never set it. Rejection of a supplied `key` falls out of Zod validation (research D5).
3. **Deletion/recreation** — a retired persona's key becomes free again; recreation may reuse it or get a suffix depending on current occupancy. No key-regeneration escape hatch exists (spec assumption).

## Orchestrator row

- Seed values: `role = 'teamlead'`, `key = ORCHESTRATOR_AGENT_KEY = 'brigadir'`, `is_orchestrator = true`.
- Singleton lookup: by `(workspace_id, is_orchestrator = true)` — **not** by name (name becomes editable persona; the default persona name stays "brigadir").
- Insert-if-absent conflict target: `(workspace_id, key)` — the reserved key guarantees at most one row wins.
- `RESERVED_AGENT_KEYS = ['brigadir']`: `ensureUniqueAgentKey` treats these as always taken, so no worker can obtain the key even in a workspace whose orchestrator row is absent.

## Backfill algorithm (migration `0007_agent_identity.sql`)

Deterministic, unattended, reviewed in `REVIEW-0007_agent_identity.md`:

1. `ALTER TABLE agents ADD COLUMN role text; ADD COLUMN key text;`
2. Orchestrators: `role='teamlead'`, `key='brigadir'`.
3. Workers: `key = trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'))`; empty → `'agent'`; `role` stays NULL (no guessing in SQL — spec decision 3).
4. Collisions per `(workspace_id, key)` (incl. vs the orchestrator's reserved key): keep first by `ORDER BY id`, suffix subsequent `-2`, `-3`, … deterministically; iterate until no duplicates (bounded — ≤20 agents/workspace).
5. `ALTER COLUMN key SET NOT NULL;` add `CONSTRAINT agents_workspace_key UNIQUE (workspace_id, key);` drop `agents_workspace_name`.

Integration test asserts SQL↔TS parity: for every pre-seeded row, the backfilled key equals `ensureUniqueAgentKey(slugifyAgentKey(name, null), …)` (research D3).

## Invariants preserved (audit targets)

- `runs`, `human_tasks`, `run_events` reference agents by uuid FK — untouched; resume path (`resume.service`, `resolve.controller`) already id-based — verify only.
- Idempotency layers (`runs_one_active`, BullMQ dedup id) key on `agent_id` — untouched.
- Status machine inputs (trigger/status columns, behavior) — untouched; `name`/`role`/`key` must not appear in any transition or dedup logic.
- Name-as-identity usages eliminated (full scan performed; the complete list lives in plan.md "Source Code" and research D2/D4): `orchestrator-seed` (lookup + onConflict by name → flag/key), `pipeline.service#resolveRoutingTarget` (name → key), `setup-apply#validateTeam` (name dedup → D4 semantics), `config-seeder` (name lookup → derived-key lookup), `agents-config.schema` (name dedup → derived-key dedup), `agents.controller` `ORDER BY name` (→ `ORDER BY key`, pagination determinism). Remaining `agent.name` reads are display/log-only and switch to "name (role)" or key per spec FR-017.
