# Contract: Generate-agents API + workspace/runs deltas

## `POST /api/workspaces/:id/generate-agents` (new, DashboardTokenGuard)

Starts the workspace-setup run of the seeded orchestrator (D11).

Preconditions (checked in order; first failure wins):

| Check | Failure response |
|-------|------------------|
| workspace exists | `404 {error:'workspace_not_found'}` |
| zero non-orchestrator agents | `409 {error:'worker_agents_exist'}` |
| enabled orchestrator agent present | `409 {error:'no_orchestrator'}` |
| no active setup run (`status ∈ queued/running/awaiting_human`, `ticket_id IS NULL`) | `409 {error:'setup_run_active', run_id}` |

Success: `202 {run_id}` — via `RunTriggerService.trigger({ticketId: null, agentId: <orchestrator>,
triggerEvent: {source:'workspace-setup', mock_scenario?}})`. A concurrent race that slips past the
endpoint check lands on `runs_one_active_setup` → `23505` → `409 {error:'setup_run_active'}`
(same dedup contract as ticketed runs). The workspace's paused/started state is NOT modified.

`mock_scenario` is threaded from the orchestrator's `behavior.mock_scenario` exactly like
triage runs do (`pipeline.service.ts` `mockScenarioOf` precedent) — no request parameter.

## Workspace creation delta (FR-001/D14)

- `POST /api/workspaces` (`workspaces.controller.ts:79`): insert `settings: { repositories, enabled: false }`.
- `ConfigSeeder.seed`: newly seeded workspaces get `enabled:false`; existing rows untouched.
- `WorkspaceResponse` unchanged (`enabled` already serialized; new workspaces now report `false`).

## Runs list delta (D11/D16)

`GET /api/workspaces/:id/runs` gains optional `source` filter
(`trigger_event->>'source' = :source`) alongside `agent`/`status`/`ticket`.
`RunListQuerySchema` += `source?: TriggerSource`.

Serialization: `ticket` becomes nullable on `RunListItem` and the run card
(left join; setup rows return `ticket: null`). The `ticket` ilike filter keeps inner-match
semantics (NULL never matches) — finding setup runs is what `source=workspace-setup` is for.
Run card for a ticketless run: `ticket: null`, history keyed by run id chain (no ticket join),
no Jira deep link.

## Human-tasks delta (D12/D16)

- `GET /api/human-tasks` (+ `?workspace=` variant): left join tickets; `HumanQueueItem.ticket`
  nullable.
- `POST /api/human-tasks/:id/resolve`: for a ticketless task, `target_agent_id` → `422`
  (`invalid_target`); `action:'resume'` on a parked setup run creates a NEW `workspace-setup`
  run carrying `human_task_id` + `resolution` (never answer-triage).

## Web UI contract (D11/D16)

- `AgentsList.vue` header: **Generate agents** button, visible when the agent list contains only
  the orchestrator; state driven by `useRuns(workspaceId, {source:'workspace-setup'})`
  (existing 5s poll): active run → button replaced by progress hint linking to the run card.
- Null-ticket rendering: `Runs.vue`, `RunCard.vue`, `HumanTaskRow.vue`, `HumanTaskDrawer.vue`
  show a neutral **Workspace setup** label instead of the ticket link.
- `ResumeAgentPicker` hidden for ticketless tasks.
- Workspace wizard: unchanged fields; post-create hint that the workspace starts paused.
