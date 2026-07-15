# Contract: Resolve Human Task — agent picker

**File**: `packages/contracts/src/resolve-human-task.schema.ts` (+ `ResumeService`,
`human-tasks.controller.ts`, Human Queue list item). Additive/backward-compatible.

## Request change

```ts
export const ResolveHumanTaskSchema = z
  .object({
    action: z.enum(['resume', 'done_manually', 'dismiss']),
    answer: z.string().max(4000).optional(),
    resolved_by: z.string().max(200).optional(),
    target_agent_id: z.string().uuid().optional(),   // NEW (FR-015) — resume only
  })
  .strict();
```

## Behavior (`POST /api/human-tasks/:id/resolve`, action `resume`)

| `target_agent_id` | Result |
|-------------------|--------|
| absent | Current behavior: new run for the **original** agent, attempt+1 (FR-015). |
| present + valid (exists ∧ enabled ∧ same workspace) | New run for the **chosen** agent, attempt restarts at 1; ticket → chosen agent's `status_running`; executor profile = chosen agent's (FR-015). |
| present + invalid (missing / disabled / other workspace) | **Reject** with validation error (400); nothing changes — no supersede, no new run (FR-015, AC US3-3). |

- The new run's trigger event references the human task + parked run (`source='human-resume'`,
  `human_task_id`, `resolution`) so the handoff renders the question + answer (FR-016).
- The guarded supersede+insert transaction and race handling in `ResumeService.resumeRun` are reused
  unchanged; only the target agent id/attempt logic is added.

## Human Queue list item change (`human-queue.schema.ts`)

Add a workspace reference so the UI selector can load the workspace's enabled non-orchestrator agents:

```ts
// HumanQueueItemSchema:
workspace: z.object({ id: z.string(), name: z.string() }).strict(),   // NEW (FR-017)
```

## UI contract (FR-017)

On a **blocking** task with action `resume`, the resolve panel shows an agent selector listing the
workspace's **enabled, non-orchestrator** agents, with the **original agent preselected**. Submitting
sends `target_agent_id`. Non-blocking tasks and non-resume actions show no selector.

## Tests

- Unit (`resume.service.spec.ts`): absent ⇒ same agent, attempt+1; valid target ⇒ new agent, attempt=1,
  running-status transition to the new agent; invalid target (disabled / other workspace / missing) ⇒
  reject, no rows change.
- Integration: park a run via blocking human task, resolve choosing a different agent, assert the new
  run belongs to the chosen agent and its assembled prompt contains the task title/details + answer.
- Contract (`resolve-human-task` / `human-queue` specs): `target_agent_id` optional UUID; queue item
  carries `workspace`.
