# Quickstart: validating workspace setup by the orchestrator

Runnable end-to-end scenarios proving the feature works. Prerequisites: Docker (testcontainers),
`pnpm i`. Contracts: see [contracts/](./contracts/); entities: [data-model.md](./data-model.md).

## Gates

```bash
pnpm typecheck && pnpm lint && pnpm test    # statics + units + contract tests
pnpm test:integration                        # real Postgres/Redis, mock executor + mock Jira
```

## Scenario A — Full loop under the mock executor (SC-001/002/008)

Integration test (`test/integration/workspace-setup.integration.spec.ts`), via `seedPipeline`
+ mock Jira:

1. Create a workspace through `POST /api/workspaces` → assert `enabled:false` in the response
   and that reconcile passes skip it (no polling).
2. Orchestrator agent exists (seeded); set its `behavior.mock_scenario='team'` with a two-agent
   roster (statuses from the mock board).
3. `POST /api/workspaces/:id/generate-agents` → `202 {run_id}`; run has `ticket_id NULL`,
   `trigger_event.source='workspace-setup'`.
4. Let the mock executor complete → assert: both agents exist `enabled=true` with correct
   trigger/status/executor bindings; ONE human task `kind='review'`, `blocking=false`,
   `ticket_id NULL`; run `succeeded`; completion marker `{setup:'applied', agents_created:2}`;
   workspace still `enabled:false`.
5. Resolve the review task; `PUT settings {enabled:true}`; run a reconcile pass → tickets in
   trigger statuses now enqueue worker runs (and did NOT before).

## Scenario B — Guards (SC-003/004/007)

1. **Race**: fire two concurrent `generate-agents` → exactly one `202`, one `409
   setup_run_active`; exactly one active setup run in DB (`runs_one_active_setup`).
2. **Invalid proposal**: `mock_scenario='team_invalid'` (bogus status name) → `complete_task`
   rejected `422` with `status_absent` issue; ZERO agents created; run continues; mock then
   exits without a valid report → run `failed`, ticketless failure human task, NO triage run.
3. **Replay**: re-invoke `onRunFinished` for the applied run → no duplicate agents, no second
   review task (marker no-op).
4. **Duplicate name vs existing agent** → `422` (not a 500 from the DB unique).

## Scenario C — Read-only Jira tools (SC-005)

Integration test against the mock Jira layer:

1. Mint a run token for an active run; call `GET …/jira/overview`, `POST …/jira/search`,
   `GET …/jira/tickets/:key` → workspace-scoped data, comments/description present.
2. Request a key from another project → `403 out_of_scope`.
3. Oversized description/comments → truncated with `truncated:true`.
4. Same calls with a finished run's token → `409`; foreign token → `401`.
5. Worker (ticketed) run token works identically — tools are not setup-only.

## Scenario D — Human interaction & ticketless UI (SC-006)

1. `mock_scenario='needs_human'` on a setup run → ticketless blocking task parks the run;
   `resolve {action:'resume', answer}` → NEW `workspace-setup` run whose handoff carries Q&A;
   `target_agent_id` on that task → `422`.
2. Web (vitest + MSW): runs list renders a null-ticket row with the **Workspace setup** label;
   run card renders without ticket link; Human Queue row/drawer render a ticketless task;
   `ResumeAgentPicker` hidden; Generate button visible only when the roster is orchestrator-only
   and no setup run is active.

## Scenario E — Live smoke (manual, post-merge)

1. `docker compose up --build`; create a workspace against the test Jira project (wizard) —
   it appears **Paused**.
2. Agents tab → **Generate agents**; watch the setup run in the Runs tab (no ticket key,
   "Workspace setup" label); orchestrator uses `get_project_overview`/`search_tickets`/
   `get_ticket` (visible in the run timeline as progress events).
3. Review the proposed agents in the Agents tab, resolve the review task in the workspace
   Human queue tab, press Start. Confirm the first real ticket in a trigger status spawns a
   worker run — and nothing ran before Start.

## Expected outcomes summary

| Check | Expectation |
|-------|-------------|
| New workspace | `enabled:false`, excluded from reconcile |
| Generate | one setup run, ticketless, orchestrator, no repo |
| Valid team | agents enabled + review task + `succeeded`, one transaction |
| Invalid team | 422 to the agent, zero agents, repair loop; fail-closed if never fixed |
| Failure | ticketless human task, never triaged |
| Read tools | scoped, credential-free, size-bounded, all runs |
| UI | null-ticket tolerated everywhere, labeled "Workspace setup" |
| Start gate | zero worker runs before `enabled:true` |
