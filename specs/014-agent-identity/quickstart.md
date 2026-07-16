# Quickstart — validating Agent Identity (014)

Runnable end-to-end checks proving the feature works. References: [data-model.md](data-model.md), [contracts/contracts-delta.md](contracts/contracts-delta.md).

## Prerequisites

- Docker running (testcontainers + compose), `pnpm install` done.
- For manual checks: `docker compose up --build` (postgres, redis, backend, worker) and the web dev server; `.env` per `docs/local-setup.md`.

## 1. Static + unit + integration gates (the handoff bar)

```bash
pnpm typecheck && pnpm lint && pnpm test
pnpm test:integration
```

Expected: green, including the new suites — `agent-key.spec.ts` (slug rule, empty-slug fallback, suffixing, reserved keys), updated `pipeline.service` / `setup-apply.service` / `handoff` / `orchestrator-seed` specs, and the agent-identity integration suite (creation paths, immutability, routing, migration backfill parity).

## 2. Migration + backfill on pre-feature data (US4)

Covered by the integration test (seeds pre-feature-shaped rows — orchestrator, slug-colliding worker names, a non-Latin name — applies `0007`, asserts):

- every row has non-empty `key`, unique per `(workspace_id, key)`;
- orchestrator: `role='teamlead'`, `key='brigadir'`;
- workers: `key` byte-identical to `slugifyAgentKey`/`ensureUniqueAgentKey` output, `role IS NULL`;
- `agents_workspace_name` unique constraint gone.

Manual spot-check against a dev DB:

```bash
docker compose exec postgres psql -U brigadir -c \
  "SELECT name, role, key, is_orchestrator FROM agents ORDER BY workspace_id, key;"
```

## 3. Key generation + immutability (US1/US3)

Via the dashboard API (or UI form):

```bash
# create → key derived server-side
curl -s -H "Authorization: Bearer $BRIGADIR_DASHBOARD_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Hera","role":"Reviewer", ...required agent fields...}' \
  http://localhost:3000/api/workspaces/$WS/agents | jq '{name,role,key}'
# expect: key == "hera-reviewer"

# rename persona → key unchanged
curl -s -X PATCH ... -d '{"name":"Athena","role":"Reviewer"}' .../agents/$ID | jq '{name,key}'
# expect: name "Athena", key still "hera-reviewer"

# supplying key on update → 422 (strict schema)
curl -s -X PATCH ... -d '{"name":"Athena","key":"athena-reviewer"}' .../agents/$ID
# expect: validation error

# duplicate persona in one workspace → both saved, distinct keys
# create second {"name":"Hera","role":"Reviewer"} → key "hera-reviewer-2"
```

UI: `/workspaces/:id/agents` — name + role editable, key shown read-only; after a rename the key cell is unchanged.

## 4. Routing by key → id (US1)

Integration/unit path (mock executors): fail a worker run → triage handoff roster lists `- <key> — <name> (<role>): <description>` and instructs routing by key → mock orchestrator returns `routing.target_agent = "<key>"` → assert the rework run's `agent_id` is the target's uuid. Negative cases: unknown key, disabled agent's key, `brigadir` → human task created (unknown-target escalation).

Rename-safety probe: rename the target persona between handoff and resolution — resolution still succeeds (key immutable, references by id).

## 5. Themed team generation (US2)

With `brigadir-admin` MCP connected (see CLAUDE.md) and a paused workspace with no workers: run `generate_agents`, then inspect the applied team:

```bash
docker compose exec postgres psql -U brigadir -c \
  "SELECT name, role, key FROM agents WHERE workspace_id='$WS' AND NOT is_orchestrator;"
```

Expected: one coherent theme across personas, distinct names, functional roles, keys = system-derived slugs. Repeat on a second workspace → a different theme (model-chosen; no theme list exists in the repo — `grep -ri "ancient greece\|matrix" libs packages apps` finds only prompt-prose examples in `handoff.ts`, not a selectable list).

## 6. Human-facing text (US3)

Trigger a run that posts a Jira comment / creates a human task: agent mentions render as "name (role)"; the routed line in the ADF comment prints the target key verbatim. Dashboard runs/queue views show persona (+ role where designed).

## 7. Docs & audit gates

- `docs/architecture.md` §3 `agents` matches the Drizzle schema and `0007` migration; `REVIEW-0007_agent_identity.md` present.
- Audit: `grep -rn "agents.name" libs apps packages --include='*.ts'` → remaining hits are display/log-only (no lookups, joins, onConflict, dedup).
