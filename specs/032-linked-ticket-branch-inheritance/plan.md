# Implementation Plan: Linked-Ticket Branch Inheritance + Configurable Dependency Release Status

**Branch**: `claude/speckit-prompt-spec-9ccaa4` (feature directory `032-linked-ticket-branch-inheritance`) | **Date**: 2026-07-26 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/032-linked-ticket-branch-inheritance/spec.md`

## Summary

Two coupled changes to make chained tickets ("is blocked by" links) usable end-to-end:

1. **Configurable release threshold.** A new optional workspace setting `dependency_release_status` (Jira status name, in the existing `workspaces.settings` jsonb blob — no DDL). The dependency-gate predicate treats an inward blocked-by link as satisfied when the blocker's status name equals the setting (case-insensitive) OR its status category is `done`. Threaded into both existing call sites (`pipeline.service.ts` status-change path, `dependency-release.service.ts` release pass). Unset ⇒ byte-identical behaviour.

2. **Branch inheritance from blockers.** `tickets.blocked_by` becomes an always-written observation (poller writes it on every observation, release no longer nulls it). Start-point resolution in `prior-work.ts` gains a third precedence level: per mounted repository, after the ticket's own prior work and before the default branch, the blocker tickets' latest succeeded reported branches are inherited. Multiple blocker branches for one repository are merged deterministically at prepare time in `worktree.ts` (conflict ⇒ loud failure + human task). Missing blocker branches follow a status-dependent asymmetry (done ⇒ quiet default; not-done ⇒ default + deduplicated human task). Cross-repo chains are satisfied by mounting (existing repo-scope config), with an unmounted-artifacts diagnostic. The wrapper states per-repo provenance facts and a bounded "Linked tickets" block; the run timeline gains five start-ref decisions.

## Technical Context

**Language/Version**: TypeScript (strict) on Node.js 22, pnpm workspace monorepo

**Primary Dependencies**: NestJS 11 (backend + worker), Drizzle ORM, BullMQ 5, zod (contracts), Vue 3 + Element Plus (dashboard), git CLI via `execFile` (worktree layer)

**Storage**: Postgres 16 (`workspaces.settings` jsonb, `tickets.blocked_by` jsonb, `run_events`, `human_tasks`) — **no schema migration in this feature**; Redis holds only queues

**Testing**: vitest — unit (`libs/**/*.spec.ts`, real git in tmp dirs for the worktree layer), integration (`test/integration`, testcontainers Postgres/Redis, mock Jira, `claude-cli-harness`), web component tests

**Target Platform**: Linux/macOS server (docker compose stack: postgres, redis, backend, worker)

**Project Type**: monorepo web service (NestJS backend + worker libs + Vue dashboard)

**Performance Goals**: release-pass latency unchanged (one settings read per pass); prepare adds at most one batched Jira status fetch (`key in (…)`) per run **with** observed blockers, zero for runs without

**Constraints**: default behaviour with setting unset must be byte-identical (spec FR-016); no new domain entities; no silent fallbacks (constitution, Technology Constraints); `tickets.blocked_by` stays a cache, never truth (Principle I)

**Scale/Scope**: ~12 source files touched across `libs/pipeline`, `libs/ingest`, `libs/executors`, `libs/human-tasks`, `libs/database`, `packages/contracts`, `apps/backend`, `apps/web`; blocker fan-in per ticket in practice ≤ ~5

## Constitution Check

*GATE: evaluated against constitution v1.2.0 before Phase 0; re-checked after Phase 1 design — both pass.*

| Principle | Verdict | Notes |
| --- | --- | --- |
| I. Dual Source of Truth | PASS | `blocked_by` changes *write frequency*, not authority — still a diff cache; the release pass still re-fetches live issues before releasing; the prepare-time done/not-done asymmetry reads blocker status from **Jira live** (batched fetch), never from the cache. A failed status fetch fails the run loudly (no silent fallback). |
| II. Idempotency at Three Levels | PASS | All releases still flow through `RunTriggerService.trigger` (webhook dedup / BullMQ dedup / `runs_one_active`). The relaxed gate only changes *when* a candidate clears, not how it is triggered. |
| III. System-Only Jira Writes | PASS | No new Jira writes. The multi-blocker merge is performed by the system in the detached worktree before the agent starts; the wrapper explicitly does not delegate merging. |
| IV. Run Completion Contract | PASS | Untouched. The merge commit becomes `startSha`, so the feature-024 completion gate's baseline semantics are preserved by construction. |
| V. Secret Isolation & Output Scrubbing | PASS | No new secrets, no new env. `git merge` runs in the same credential context as existing fetch/clone; commit identity is passed via `-c` flags (no global config writes). Human-task texts contain only ticket keys, repo names, branch names — already-scrubbed report data. |
| VI. Test-Mandatory Pipeline Logic | PASS | Gate predicate, precedence chain, merge, missing-branch matrix, poller write path, dedup — all enumerated with unit + integration coverage (quickstart.md). |
| Lazy resource resolution | PASS | The setting is read per-pass/per-run inside injectable services; nothing new is evaluated at module composition. |

**Post-design re-check**: no violations introduced by Phase 1 artifacts. One deliberate deviation from the spec's *letter* is recorded in Complexity Tracking (human-task "kinds" realized without widening the agent-facing `kind` enum).

## Project Structure

### Documentation (this feature)

```text
specs/032-linked-ticket-branch-inheritance/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions R1–R9
├── data-model.md        # Phase 1 — settings field, blocked_by write matrix, event payloads
├── quickstart.md        # Phase 1 — validation guide
├── contracts/
│   ├── dependency-release.md    # gate predicate + release-pass + dashboard API delta
│   └── branch-inheritance.md    # precedence, merge, missing-branch matrix, events, wrapper
└── tasks.md             # Phase 2 (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
packages/contracts/src/
├── jira.types.ts                 # WorkspaceSettingsSchema + dependency_release_status
└── dashboard.schema.ts           # workspace settings payload delta (if typed there)

libs/database/src/
└── workspace-settings.ts         # getDependencyReleaseStatus accessor

libs/pipeline/src/
├── dependency-gate.ts            # predicate gains { releaseStatus } opt; allBlockedByKeys()
├── pipeline.service.ts           # threads setting; blocked_by write semantics
└── dependency-release.service.ts # threads setting; keeps blocked_by on release;
                                  # early-release run event; unmatched-setting diagnostic

libs/ingest/src/
└── poller.service.ts             # writes blocked_by on every observation

libs/executors/src/claude-cli/
├── prior-work.ts                 # getBlockerWork(); per-repo layered resolution
├── worktree.ts                   # mergeBranches support; RepoStart provenance fields
├── claude-cli.executor.ts        # blocker status fetch; missing-branch matrix;
│                                 # events + human tasks; wrapper data
└── wrapper.ts                    # provenance repo lines; "Linked tickets" block

libs/human-tasks/src/
└── human-task.service.ts         # title-keyed run-less dedup method

apps/backend/src/dashboard/
└── workspaces.controller.ts      # GET/PATCH settings surface for the new field

apps/web/src/
├── views/workspace-settings/GeneralPanel.vue   # status select + not-observed warning
├── composables/useWorkspaces.ts                # settings field plumbing
└── components/RunTimeline/presenter.ts         # render new start-ref decisions

test/integration/
├── dependency-gate.spec.ts               # extended: configured-status release matrix
├── sprint-sequencing.spec.ts             # regression: unset ⇒ unchanged
├── claude-cli-branch-handoff.spec.ts     # extended or sibling: blocker inheritance E2E
└── (new) blocker-inheritance.spec.ts     # blocker-status → dependent-starts-from-branch

docs/
├── architecture.md               # §3 blocked_by semantics, §4 prepare pipeline delta
└── progress.md                   # iteration entry
```

**Structure Decision**: no new packages or modules; every change lands in the existing lib that owns the concern (gate → pipeline, observation → ingest, resolution/merge → executors, task dedup → human-tasks, surface → backend/web). This keeps the "minimal, workspace-level, no new domain entities" design bias enforceable in review.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Spec FR-011 says three new human-task *kinds*; implementation keeps DB/contract `kind='blocker'` and realizes the kind + dedup tuple via a deterministic machine-readable title prefix (`[blocker_branch_lost] …`) with title-equality dedup (research R5) | `kind` is an agent-facing contract enum (`report.schema.ts` HUMAN_TASK_KINDS + `human-queue.schema.ts`); widening it would let agents emit system-reserved kinds and forces a lockstep contracts/UI/API migration for a purely diagnostic label | Widening the enum was rejected: it couples an internal diagnostic taxonomy to the versioned agent report contract (Principle IV forward-compat) for zero user-visible gain — the queue UI shows title/details either way |
| Prepare-time blocker status comes from a live batched Jira fetch (one `key in (…)` call per run with blockers), not from a new `tickets` column (research R4) | The done/not-done asymmetry (spec FR-008) needs the status *category*, which the tickets cache does not store; caching it would require a DDL migration + architecture §3 change for data that must be fresh at exactly this decision point | The cache-column alternative was rejected: Principle I says Jira is the sole truth for status, staleness here flips quiet-vs-task behaviour, and the feature is explicitly no-migration |
