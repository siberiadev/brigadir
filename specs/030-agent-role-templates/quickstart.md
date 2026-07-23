# Quickstart: validating agent role templates (030)

Runnable scenarios proving the feature end-to-end. Contracts: [role-templates.md](contracts/role-templates.md), [settings-api.md](contracts/settings-api.md); shapes: [data-model.md](data-model.md).

## Prerequisites

- Stack up per `docs/local-setup.md` (`docker compose up --build`, or dev mode) with
  `BRIGADIR_CREDENTIALS_KEY`, `BRIGADIR_DASHBOARD_TOKEN` set; migration 0009 applied at boot.
- `export TOKEN=$BRIGADIR_DASHBOARD_TOKEN; API=http://localhost:3000`
- A workspace with an enabled orchestrator and NO worker agents (generate-agents precondition).

## Scenario 1 — US1: built-ins, zero config (MVP gate)

```bash
# 1. No sources configured anywhere:
curl -s -H "Authorization: Bearer $TOKEN" $API/api/agent-instructions-settings
# expect: { "source": null, "has_token": false }

# 2. Trigger team generation:
curl -s -X POST -H "Authorization: Bearer $TOKEN" $API/api/workspaces/$WS/generate-agents
# expect: 202 { "run_id": … }
```

Verify on the run's timeline (dashboard → run):
- handoff contains "Role templates available (source: built-in defaults)" with the 4 roles;
- `list_role_templates` / `get_role_template` tool calls appear and succeed;
- delivered team's instructions carry template structure (Workflow / Hard rules /
  Completion / Escalation) WITH project-specific commands (adapted, not verbatim);
- every agent's executor is an existing enabled profile name (hint-mapped).

## Scenario 2 — US2: global git source takes effect on the next run

```bash
# Point the global setting at the reference repo:
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  $API/api/agent-instructions-settings \
  -d '{"source":{"git_url":"git@github.com:siberiadev/agents.git","git_ref":"main","subdir":"roles"}}'
# Reset the workspace team (or use a fresh workspace), rerun generate-agents.
```

Expect: catalog block now says `source: global repo git@github.com:siberiadev/agents.git`;
roles/hints match the repo (developer→opus, planner→sonnet, qa/reviewer→deepseek).
No restart required (SC-002).

## Scenario 3 — US2: workspace override beats global; clearing falls back

```bash
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  $API/api/workspaces/$WS/settings -d '{"agent_instructions":{"git_url":"<other-repo-url>"}}'
curl -s -H "Authorization: Bearer $TOKEN" $API/api/workspaces/$WS | jq .effective_instructions_level
# expect: "workspace"; run uses the override's catalog.
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  $API/api/workspaces/$WS/settings -d '{"agent_instructions":null}'
# expect: effective_instructions_level back to "global".
```

## Scenario 4 — US2: private repo token is write-only and never leaks

```bash
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  $API/api/workspaces/$WS/settings \
  -d '{"agent_instructions":{"git_url":"https://github.com/acme/private-agents.git"},"agent_instructions_token":"ghp_test…"}'
curl -s -H "Authorization: Bearer $TOKEN" $API/api/workspaces/$WS | grep -c ghp_
# expect: 0 matches; has_agent_instructions_token: true
```

Run generate-agents; then assert the token appears NOWHERE:
run timeline events, `run_events` rows, backend logs, `ps` output during the run
(integration test automates the argv/env assertion). SC-005.

## Scenario 5 — US2: broken source never blocks (fallback + diagnostic)

```bash
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  $API/api/agent-instructions-settings -d '{"source":{"git_url":"https://github.com/acme/does-not-exist.git"}}'
```

Rerun generate-agents: run COMPLETES; catalog block shows built-in defaults with a
fallback diagnostic naming the failed source (SC-003). Same expectation for a bad
`git_ref` and an empty/malformed repo.

## Scenario 6 — US2: URL validation

```bash
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  $API/api/agent-instructions-settings -d '{"source":{"git_url":"file:///etc"}}' -w '%{http_code}'
# expect: 4xx with a path-qualified validation issue; nothing persisted.
```

## Scenario 7 — US3: dashboard round-trip (manual, SC-006)

In the dashboard, without docs: General → set global source; Workspace settings →
set override, observe indicator flip to "its own repo"; replace token, clear token
(indicator only, value never shown); "Use global default" → indicator "global repo";
clear global → "built-in defaults". Under 5 minutes end-to-end.

## Scenario 8 — US3: admin-MCP

With `brigadir-admin` connected (CLAUDE.md § admin-MCP): `create_workspace` with
`agent_instructions` attached → new workspace's `effective_instructions_level` is
`workspace`; `set_agent_instructions_source` with no `workspace_id` updates the
global level; passing a token as a tool argument has no effect (ignored — config-only).

## Automated gates

```bash
pnpm typecheck && pnpm lint && pnpm test   # unit/component incl. new contracts + parser + resolver
pnpm test:integration                       # bare-git fixture: resolution, fallback, token secrecy, tools E2E
```
