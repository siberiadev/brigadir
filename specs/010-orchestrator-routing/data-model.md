# Phase 1 Data Model: Orchestrator-Based Blocked-Ticket Routing

Grounded in `docs/architecture.md` §3 and the live drizzle schema in
`libs/database/src/schema/`. Schema changes ship as migration `drizzle/0004_orchestrator_routing.sql`
with a `REVIEW-0004_orchestrator_routing.md` SQL review against §3 (rule 5).

---

## 1. Schema changes (persisted)

### 1.1 `agents` — new columns (`libs/database/src/schema/agents.ts`)

| Column | Type | Null | Default | Purpose |
|--------|------|------|---------|---------|
| `description` | `text` | yes | `NULL` | Roster line shown to the orchestrator in the handoff (FR-020). |
| `is_orchestrator` | `boolean` | no | `false` | Marks the per-workspace orchestrator (FR-018/019). Never poll-triggered, non-deletable, excluded from routing targets. In the resume picker it IS listed and preselected (answer-triage delta, FR-017/025) — resolving to it creates an answer-triage run. |

Constraints/rules:
- The orchestrator row has `is_orchestrator=true`, `trigger_status=NULL`, `trigger_jql=NULL`,
  `name='brigadir'`. `UNIQUE(workspace_id, name)` already guarantees one per workspace.
- Its `status_success`/`status_failure` are stored but inert (FR-007) — set to placeholder values
  (e.g. the workspace's failure status) to satisfy `NOT NULL`.
- Delete guard is enforced in the API (`agents.controller.ts` → 409), not a DB constraint, so
  instruction/enabled/timeout edits stay possible (FR-019).

### 1.2 `global_settings` — new table (`libs/database/src/schema/global-settings.ts`)

| Column | Type | Null | Default | Purpose |
|--------|------|------|---------|---------|
| `key` | `text` PK | no | — | Setting key. First key: `default_orchestrator_instruction`. |
| `value` | `jsonb` | no | — | Setting value (string for the default instruction). |
| `updated_at` | `timestamptz` | no | `now()` | Last write. |

- Platform-global (no workspace FK) — the "General" settings section (FR-021).
- Read at workspace-creation time; falls back to a built-in constant when the key is absent (FR-022).

### 1.3 `workspaces.settings` — new JSONB key (no migration; typed accessor)

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `rework_max` | integer | `2` | Per-workspace rework-cycle budget (FR-006). Read/written via the existing `libs/database/src/workspace-settings.ts` accessor. |

No column change — `workspaces.settings` is already `jsonb NOT NULL DEFAULT {}`.

### 1.4 No change to `runs`, `human_tasks`, `run_events`, `tickets`

Triage/rework runs are ordinary `runs` rows distinguished by `trigger_event.source`. The rework-cycle
count is derived (`COUNT(*) WHERE source='rework'`), not stored. Human-task overrides use the existing
`human_tasks` table with `blocking=false`. The triage decision is recorded in the existing
`run_events(type='jira_action')` marker payload.

---

## 2. Contract entities (not persisted as tables)

### 2.1 Report `routed` outcome (`packages/contracts/src/report.schema.ts`)

```
REPORT_OUTCOMES += 'routed'
routing?: { target_agent: string(≤200), task: string(≤4000) }   // .strict()
superRefine: outcome==='routed' ⇒ routing required   (mirrors needs_human ⇒ human_task)
```

- `target_agent` is a name (resolved to an agent id in the pipeline, validated there).
- `task` passes the secret scrubber before persistence/Jira (FR-003), like all report fields.

### 2.2 Trigger-event vocabulary (`packages/contracts/src/trigger-event.schema.ts`)

```
TRIGGER_SOURCES: ['manual','webhook','poll','human-resume','triage','rework','answer-triage']
                  # was 'human_resume' (bug) → 'human-resume' (FR-023)
                  # 'answer-triage' added by the answer-triage delta (FR-025)
Optional handoff fields (typed, still .passthrough()):
  failing_run_id?, deciding_run_id?, human_task_id?, target_agent?, task?
MOCK_SCENARIOS += 'routed'   (FR-024)
```

Handoff-source classification:
| `source` | handoff kind | references |
|----------|-------------|-----------|
| `triage` | triage handoff | `failing_run_id` |
| `answer-triage` | answer-triage handoff (Q&A + triage material) | `failing_run_id`, `human_task_id`, `resolution` |
| `rework` | rework handoff | `failing_run_id`, `deciding_run_id`, `task`, `target_agent`, `human_task_id?` (when the decision was human-answered) |
| `human-resume` | resume handoff | `human_task_id`, parked run (via `resolution`) |

### 2.3 Handoff section (ephemeral, per-run)

Assembled at prompt time from the trigger event + run history; never persisted. See
`contracts/handoff-section.md` for the block layout per kind.

---

## 3. State & lifecycle

### 3.1 Rework-cycle budget (derived)

```
cycle_count(ticket) = |{ run ∈ ticket.runs : run.trigger_event.source == 'rework' }|
budget_available    = cycle_count(ticket) < workspace.settings.rework_max (default 2)
```

Evaluated deterministically in pipeline code (FR-006); never trusted to the model.

Answer-triage exemption (FR-026): a routed decision whose DECIDING run has
`trigger_event.source == 'answer-triage'` bypasses the exhausted-budget override —
the human answer grants exactly one extra cycle. The resulting rework run keeps
`source='rework'` and counts in `cycle_count`, so the next automatic triage
escalates `cycle_limit` as usual.

### 3.2 Triage decision (recorded in the `jira_action` marker)

```
decision ∈ { triaged, cycle_limit, no_orchestrator }
```

- `triaged` — enabled orchestrator exists AND budget available ⇒ one triage run enqueued.
- `cycle_limit` — budget exhausted ⇒ non-blocking human task, no triage.
- `no_orchestrator` — orchestrator disabled/absent ⇒ ticket stays Blocked (as today), no triage.

Replay (drift repair) re-reads the marker and no-ops (SC-001).

### 3.3 Orchestrator-decision outcomes (from a completed triage run)

```
routed + valid target + budget available   → rework run + running-status transition + routing comment
routed + invalid target OR budget exhausted → override to non-blocking human task (+ reason)
needs_human                                 → human task, no ticket transition
orchestrator run failed/timed_out           → no second triage + human task (orchestrator failure)
routed from a non-orchestrator agent        → treated as failure, invalid outcome noted in comment
```

Target validity = exists ∧ enabled ∧ `is_orchestrator=false` ∧ same workspace.

### 3.4 Run-source transitions across the loop

```
worker run (failed/timed_out)
  └─▶ [budget ok + orchestrator enabled] triage run  (source='triage', agent=brigadir)
        └─▶ routed(valid) ──▶ rework run  (source='rework', agent=target)  ──▶ success ▶ ends loop
        └─▶ routed(invalid)/budget-exhausted ──▶ human task (non-blocking)
        └─▶ needs_human ──▶ human task
        └─▶ orchestrator failed ──▶ human task (no re-triage)
  └─▶ [budget exhausted OR no orchestrator] human task (non-blocking) — no triage run

human resolves a BLOCKING task (answer-triage delta)
  └─▶ [target = orchestrator, the picker default] answer-triage run
        (source='answer-triage', agent=brigadir, refs: human_task + failing run)
        └─▶ routed(valid) ──▶ rework run (source='rework', +human_task_id) —
              exempt from the exhausted-budget override (one human-granted cycle)
        └─▶ routed(invalid target) ──▶ human task (override, as automatic triage)
        └─▶ needs_human ──▶ human task
  └─▶ [target = worker agent] human-resume run (unchanged direct resume)
```

---

## 4. Validation rules

| Field | Rule | Source |
|-------|------|--------|
| `report.routing` | required iff `outcome==='routed'`; else forbidden | FR-001 |
| `routing.target_agent` | ≤200 chars; must resolve to enabled non-orchestrator agent in same workspace | FR-001/008 |
| `routing.task` | ≤4000 chars; scrubbed before persist/post | FR-001/003 |
| `routed` from non-orchestrator | rejected → failure + noted in comment | FR-002 |
| rework-cycle count | `< rework_max` to route; else override to human | FR-006/009 |
| `resolve.target_agent_id` | optional; if set must exist ∧ enabled ∧ same workspace, else reject (nothing changes); the orchestrator is a VALID target (⇒ answer-triage run) | FR-015/025 |
| orchestrator delete | API rejects with 409 conflict | FR-019 |
| trigger `source` | one of the seven-value vocabulary; resumed mock runs validate | FR-023/025 |

---

## 5. Migration `0004_orchestrator_routing.sql` (outline)

```sql
ALTER TABLE agents ADD COLUMN description text;
ALTER TABLE agents ADD COLUMN is_orchestrator boolean NOT NULL DEFAULT false;

CREATE TABLE global_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

- No backfill of `is_orchestrator` in SQL — orchestrator rows are created by the seeding/backfill
  service (D10), which also sets the default instruction from `global_settings`.
- `rework_max` needs no DDL (lives in `workspaces.settings` JSONB).
- Ship `REVIEW-0004_orchestrator_routing.md` reviewing this SQL against architecture.md §3, and update
  §3/§6 of `docs/architecture.md` in the same change (FR-024).
