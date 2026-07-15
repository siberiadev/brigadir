# Phase 0 Research: Orchestrator-Based Blocked-Ticket Routing

All spec unknowns are design decisions over an existing codebase (no external-technology
unknowns). Each decision below is grounded in a concrete file/pattern already in the repo.

---

## D1 — "routed" as a fourth report outcome (FR-001, FR-002)

**Decision**: Add `routed` to `REPORT_OUTCOMES` in `packages/contracts/src/report.schema.ts` and a
`routing` payload object `{ target_agent: string(≤200), task: string(≤4000) }`. Extend the existing
`.superRefine` so `outcome==='routed'` requires `routing`, exactly mirroring the
`needs_human`⇒`human_task` rule already there. Non-orchestrator `routed` reports are rejected at the
pipeline layer (not the schema layer), because "is this agent an orchestrator" is workspace state,
not contract state.

**Rationale**: Keeps routing in the single, versioned report channel (Constitution IV) instead of a
side channel (labels/queries/statuses — explicitly excluded by FR-001). The conditional-required
pattern is already proven for `human_task`.

**Alternatives considered**: (a) A separate `routing_report` schema — rejected: duplicates the whole
report envelope and the completion path. (b) Reusing `needs_human` with a magic title — rejected:
untyped, un-scrubbed target parsing, and breaks the "no other routing channel" rule.

---

## D2 — Orchestrator identity: marker + dedicated executor profile (FR-018, FR-019)

**Decision**: Represent the orchestrator as an ordinary `agents` row named `"brigadir"`, marked as
orchestrator via an explicit boolean column `is_orchestrator` (not a `behavior` JSON flag). It has
`trigger_status = NULL` and `trigger_jql = NULL` (never poll-triggered), points at a dedicated
low-cost executor profile with **no repository workspace**, and its `status_success`/`status_failure`
are inert placeholders.

**Rationale**: An explicit column is queryable in the roster filter (FR-017 excludes orchestrators),
the delete guard (FR-019), and the completion-path branch (FR-007) without JSON extraction, and it
survives instruction/behavior edits. The orchestrator flows through the existing run lifecycle, three
dedup layers, and executor registry unchanged (scope rule: keep abstractions intact).

**Alternatives considered**: (a) `behavior.is_orchestrator` JSON flag — rejected: not indexable,
easy to clobber on a behavior edit, awkward in `WHERE`. (b) Name convention (`name==='brigadir'`) —
rejected: names are editable per FR-019's "other settings editable", and workspace owners could
collide.

---

## D3 — Rework-cycle budget derived from run history (FR-006)

**Decision**: Compute the cycle count deterministically as the number of runs on the ticket whose
`trigger_event.source === 'rework'`. The per-workspace maximum lives in `workspaces.settings.rework_max`
(JSONB, default 2 via a typed accessor in `libs/database/src/workspace-settings.ts`, the existing
settings-accessor module). No counter column.

**Rationale**: Constitution I — run history is the source of truth for run counts; a separate counter
would be a second source of truth and could drift under replay/concurrency. A `COUNT(*) WHERE
source='rework'` over the ticket's runs is idempotent and replay-safe.

**Alternatives considered**: (a) `tickets.rework_count` column incremented on each rework — rejected:
duplicates authority, races with dedup. (b) Per-agent-pair budget — rejected by Assumptions (budget is
per ticket, counts rework runs regardless of target).

---

## D4 — Where triage is triggered: end of `PipelineService.onRunFinished` (FR-004)

**Decision**: Extend `onRunFinished` (`libs/pipeline/src/pipeline.service.ts`). After the existing
failure transition + comment succeed, and **before** writing the `jira_action` marker, run the triage
decision: if the run is a terminally-failed *worker* run (status `failed`/`timed_out`, agent not an
orchestrator), evaluate the budget and enqueue exactly one triage run for the enabled orchestrator via
`RunTriggerService`. Record the decision (`triaged` / `cycle_limit` / `no_orchestrator`) inside the
marker payload so a drift-repair replay short-circuits (the marker guard at the top already returns
early). Orchestrator-run completion and rework processing are handled by dedicated branches added to
the same method.

**Rationale**: `onRunFinished` is already the single persist-then-write completion seam and already
idempotent via the `jira_action` marker — extending it keeps one completion path and reuses the replay
guard (SC-001). Enqueuing through `RunTriggerService` inherits all three dedup layers (Constitution II).

**Alternatives considered**: (a) A new poller/scheduler that scans for blocked tickets — rejected:
adds polling delay (FR-004 says in-process, no delay) and a second trigger surface. (b) A BullMQ
"triage" event emitted separately — rejected: extra queue, weaker replay story than the existing marker.

---

## D5 — Terminal-failure gate (Assumptions)

**Decision**: "Terminally failed" = run status `failed` or `timed_out`. `cancelled` and `superseded`
are excluded (operator intent, not agent failure). This mirrors the existing `TERMINAL_STATUSES`
handling but narrows to the *failure* subset for the triage branch.

**Rationale**: Directly from Assumptions; prevents operator cancels from spawning triage.

---

## D6 — Orchestrator decision processing & overrides (FR-007..011)

**Decision**: A completed orchestrator run does NOT take the generic success/failure transition branch
(guarded by `is_orchestrator`). Instead:
- `routed` + valid target (exists, enabled, not orchestrator, same workspace, budget still available)
  ⇒ enqueue a **rework run** for the target via `RunTriggerService` carrying a `rework` trigger event
  (task text + `failing_run_id` + `deciding_run_id`), transition the ticket to the target's
  `status_running` directly (never through a trigger status), and post a routing comment.
- `routed` + invalid target / exhausted budget ⇒ override into a **non-blocking human task**
  containing the task text + override reason.
- `needs_human` ⇒ existing human-task mechanism, no ticket transition.
- orchestrator run itself `failed`/`timed_out` ⇒ **no second triage** (the triager is never triaged) +
  a human task describing the failure.

**Rationale**: All branches are deterministic pipeline code (Constitution VI); the model is never
trusted to enforce the budget or target validity (US2). Reusing `RunTriggerService` + the existing
human-task service keeps the dedup and Jira-write guarantees.

**Alternatives considered**: Trusting the orchestrator to self-limit — rejected explicitly by the spec
("not by trusting the orchestrator model").

---

## D7 — Handoff section: assembled at prompt time in the processors (FR-012..014)

**Decision**: Add a pure `buildHandoffSection(triggerEvent, db)` in `libs/pipeline` (or a small
`libs/handoff` helper co-located with pipeline) that, given a trigger event carrying a handoff source,
reads the referenced runs/tasks from Postgres and returns a bounded markdown block. Both processors
(`run.processor.ts`, `claude-cli-run.processor.ts`) prepend/append this block to the agent's stored
`instruction` at `RunContext` build time — **without persisting** any instruction change. This
*replaces* the current `instructionWithResumeAnswer` in the claude-cli processor (FR-014).

- triage source ⇒ failing report summary, failed/warning checks, artifacts, worker-agent roster
  (name + description), cycle count vs max, decision protocol.
- rework source ⇒ orchestrator task, failing summary + failed checks, branch/PR, fix-of-existing-work framing.
- human-resume source ⇒ human task title/details + operator answer.

Assembly is best-effort and size-bounded: missing source data degrades the section, never fails the
run (FR-013).

**Rationale**: The instruction stays the stored agent property (SC-002 — zero changes to worker
instructions); the handoff is ephemeral per-run context. Building it in the processor is where the
`RunContext.instruction` is already assembled and where `instructionWithResumeAnswer` already lives.

**Alternatives considered**: (a) Persisting a per-run instruction override column — rejected:
duplicates the instruction, muddies audit. (b) Building it in the executor — rejected: executors are
pluggable and should receive a ready `RunContext`; two executors would each re-implement it.

---

## D8 — Trigger-source vocabulary fix + extension (FR-023)

**Decision**: In `trigger-event.schema.ts` change `'human_resume'` → `'human-resume'` (the value
`resume.service.ts` already writes at line 121) and add `'triage'` and `'rework'`. Add optional
handoff fields to `TriggerEventSchema`: `failing_run_id`, `deciding_run_id`, `task`, `human_task_id`,
`target_agent`. The schema already `.passthrough()`es, but typing them makes handoff assembly and the
mock executor type-safe.

**Rationale**: This is the pre-existing bug called out in Edge Cases — resumed mock runs currently
crash validation because the enum lacks `human-resume`. Fixing it here (same vocabulary being extended)
is the natural place; historical stored events are display/validation data, no data migration needed
(Assumptions).

---

## D9 — Global settings store & default orchestrator instruction (FR-021, FR-022)

**Decision**: New `global_settings` table — `key text primary key`, `value jsonb`, `updated_at`. First
key: `default_orchestrator_instruction`. New `GET/PUT /api/general-settings` (backend
`general-settings.controller.ts`) reading/writing that key. At workspace-creation time the seeder reads
the key (falling back to a built-in constant when unset) and copies it into the seeded orchestrator's
`instruction`. Changing the default affects only workspaces created afterward (no propagation).

**Rationale**: Postgres is the system of record for platform config (Constitution tech constraints); a
key-value table is the minimal, forward-extensible shape (the spec says "first key"). Copy-at-creation
matches FR-022's "affects newly created workspaces only".

**Alternatives considered**: (a) Env var / config file — rejected: not editable from the admin UI
(FR-021 requires a settings tab with save). (b) A dedicated single-row table — rejected: less
extensible than key-value for the stated "General" section that will grow.

---

## D10 — Orchestrator seeding on all three paths + backfill (FR-018)

**Decision**: Factor a `seedOrchestratorAgent(db, workspaceId)` helper (insert-if-absent on
`UNIQUE(workspace_id, name='brigadir')`) called from: the wizard create in `workspaces.controller.ts`,
the yaml `config-seeder.ts`, and a new `orchestrator-backfill.service.ts` that runs once at startup
(`OnApplicationBootstrap`) iterating existing workspaces. It also ensures the dedicated cheap executor
profile exists (reuse `executor-backfill.service.ts` pattern).

**Rationale**: Insert-if-absent is the established seeding idiom in this repo (config-seeder feature 005;
executor-backfill) — never overwrites an existing orchestrator (FR-018), safe to run every boot.

**Alternatives considered**: A migration that inserts orchestrators — rejected: migrations shouldn't
carry per-workspace business seeding, and can't compute the default-instruction fallback dynamically.

---

## D11 — Human Queue agent picker (FR-015..017)

**Decision**: Extend `ResolveHumanTaskSchema` with optional `target_agent_id`. In `ResumeService.resumeRun`,
when present, validate (exists, enabled, same workspace, not required to exclude orchestrator at API —
but the UI list excludes it) and create the new run for that agent instead of the parked agent, with
attempt numbering restarting at 1 for a newly chosen agent (Assumptions/FR-015). The trigger event
references the human task + parked run so the handoff renders Q&A (FR-016). The Human Queue list item
gains a `workspace` ref so the UI selector can fetch that workspace's enabled non-orchestrator agents,
original agent preselected.

**Rationale**: Reuses the existing guarded supersede+insert transaction (idempotency level 3). The
attempt-restart-on-new-agent rule avoids a misleading attempt count across a different agent.

**Alternatives considered**: A brand-new endpoint for "resume as agent X" — rejected: duplicates the
resolve transaction and its race handling; an optional field is additive and backward-compatible.

---

## D12 — Mock executor "routed" scenario + ADF "routed" panel (FR-024)

**Decision**: Add a `routed` case to `MockExecutor` returning a `routed` report with a configurable
target agent name (read from `trigger_event`, defaulting to a roster entry) so integration tests can
drive fail→triage→route→rework→success. Add a `routed` entry to `PANEL_BY_OUTCOME` in `adf-composer.ts`
and a comment line naming the target agent + task.

**Rationale**: The mock executor is the sanctioned pipeline harness (Constitution VI); without a
`routed` scenario the full loop is only testable with a live agent, which the constitution forbids as a
"done" criterion.

---

## Resolved unknowns summary

| Spec area | Resolution |
|-----------|-----------|
| routing channel | `routed` report outcome + `routing` payload (D1) |
| orchestrator identity | `is_orchestrator` column + no-workspace executor profile (D2) |
| cycle count authority | derived from `source='rework'` run history; max in `workspaces.settings` (D3) |
| triage trigger point | end of `onRunFinished`, before marker; recorded in marker (D4) |
| terminal-failure set | `failed` + `timed_out` only (D5) |
| decision/override logic | deterministic pipeline branches (D6) |
| handoff mechanism | ephemeral prompt-time block in processors, replaces resume-answer append (D7) |
| trigger vocabulary | fix `human-resume`, add `triage`/`rework` + handoff fields (D8) |
| global settings | `global_settings` k/v table + General-settings API, copy-at-create (D9) |
| seeding/backfill | insert-if-absent helper on all 3 paths + startup backfill (D10) |
| resume picker | optional `target_agent_id`, attempt restart, workspace ref on queue item (D11) |
| testability | mock `routed` scenario + ADF `routed` panel (D12) |

No NEEDS CLARIFICATION items remain.
