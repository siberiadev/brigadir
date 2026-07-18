# Implementation Plan: Multi-Repository Runs

**Branch**: `claude/multi-repo-runs-pdobzd` | **Date**: 2026-07-18 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/019-multi-repo-runs/spec.md`

## Summary

A run prepares one git worktree per repository in the agent's scope
(`behavior.repositories[]`, deprecated `behavior.repository` = one-element list,
absent = all workspace repos), laid out as `worktreeRoot/<runId>/<repo.name>/` with
the agent cwd at the parent; all worktrees share the branch
`<branchPrefix>/<ticketKey>`. The agent decides from the ticket which repos to change;
delivery and reporting are per touched repo via a new `artifacts.repos[]` list in
ReportSchema v2 (flat fields stay valid; `schema_version` becomes a `1|2` union).
One shared `normalizeReportArtifacts` helper feeds all four consumers (scrubber,
review-task, Jira ADF, dashboard card — the latter two render artifacts for the first
time). The single-repo `prepare()` body (incl. the leftover-branch policy) is reused
inside a new `prepareAll`/`cleanupAll` loop with all-or-nothing partial-failure unwind.
No DB schema change. Full decision log: [research.md](research.md) D1–D13.

## Technical Context

**Language/Version**: TypeScript strict, Node 20, pnpm monorepo

**Primary Dependencies**: NestJS 11 (backend + WorkerHost worker), BullMQ 5, zod
(contracts), drizzle (Postgres), Vue 3 + Element Plus (dashboard), git CLI (worktrees)

**Storage**: Postgres 16 — no schema change: scope in `agents.behavior` jsonb, report
in `runs.report` jsonb, `runs.worktree_path` column already exists. Redis: queues only

**Testing**: vitest units per package; integration via testcontainers (real
Postgres/Redis, shared containers per run — `test/integration/global-setup.ts`),
fake-claude harness fixtures for executor runs

**Target Platform**: Linux server (self-hosted, docker compose)

**Project Type**: monorepo web service — `apps/backend`, `apps/worker`, `apps/web`,
`libs/*`, `packages/contracts`

**Performance Goals**: untouched repos near-free at run start — warm-cache
`git worktree add` is seconds per repo (SC-005); no new queue/concurrency semantics

**Constraints**: stored agent rows and v1 reports must validate without rewriting
(SC-002); finalization guards (`WHERE status='running'`) and the three dedup layers
untouched; secrets posture unchanged (per-run creds/config outside worktrees)

**Scale/Scope**: internal team tool; workspaces with ~1–10 repos; `artifacts.repos`
capped at 20 entries

## Constitution Check

*GATE: evaluated pre-Phase-0 and re-checked post-Phase-1 design — PASS, no violations.*

| Principle | Verdict | Notes |
|---|---|---|
| I. Dual Source of Truth | PASS | No new state source; report stays in `runs.report`, scope in `agents.behavior`. Reconciliation/trigger contract untouched (spec Out of Scope). |
| II. Idempotency at Three Levels | PASS | No trigger-path changes; none of the three layers touched. |
| III. System-Only Jira Writes | PASS | Agents still report via callback tools only; new ADF artifact lines ride the existing per-issue write queue (`buildRunComment` call sites unchanged). |
| IV. Run Completion Contract | PASS | ReportSchema change is additive + versioned (`1|2` union — forward-compatible per §6); needs_human/routed/team conditionals untouched; 409/422 semantics unchanged. Contract tests updated in the same change. |
| V. Secret Isolation & Output Scrubbing | PASS (improves) | No new secret paths; wrapper.txt moves OUTSIDE any repo working tree (parent dir). scrubReport extended to artifacts — closing a discovered gap where artifacts bypassed the scrubber entirely (research D7). |
| VI. Test-Mandatory Pipeline Logic | PASS | Unit + integration matrix in research D12 / quickstart; executor lifecycle, callback validation, report processing changes all ship with tests in the same iteration. |
| Tech constraints | PASS | No `@Module()` decorator-arg resource init (changes are inside pure helpers/services); TypeScript strict; contracts stay the single typed source; no drizzle migration. |
| Scope discipline | PASS | The §7 behavior→wrapper compiler (a deliberately cut feature) is NOT built — FR-015 is delivered as wrapper instruction text only (research D9). `RunRuntime` stays a doc-level contract (§8 doc update only). |

## Project Structure

### Documentation (this feature)

```text
specs/019-multi-repo-runs/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions D1–D13
├── data-model.md        # Phase 1 — scope/layout/report shapes
├── quickstart.md        # Phase 1 — validation guide
├── contracts/
│   ├── agent-repository-scope.md
│   └── report-v2-artifacts.md
└── tasks.md             # Phase 2 (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
packages/contracts/src/
├── agents-config.schema.ts      # behavior.repositories + superRefine check; executor repository → optional
├── dashboard.schema.ts          # AgentBehaviorRequestSchema.repositories
├── report.schema.ts             # schema_version 1|2; artifacts.repos; normalizeReportArtifacts
├── runs.schema.ts               # RunCardResponseSchema.artifacts
└── callback-tools.schema.ts     # (no change — CompleteTaskSchema = ReportSchema)

libs/executors/src/claude-cli/
├── claude-cli.executor.ts       # resolveRepositoryNames / pickWorkspaceRepositories; prepareAll wiring;
│                                #   worktree_path = parent; wrapper repos; cleanupAll
├── worktree.ts                  # prepareAll / cleanupAll; per-repo target dir; partial-failure unwind
├── wrapper.ts                   # ## Repositories section + multi-repo conduct rules
└── feature-context.ts           # per-repo artifact lines via normalizeReportArtifacts

libs/callback/src/callback.service.ts   # scrubReport(artifacts both forms); review-task fan-in
libs/jira/src/adf-composer.ts           # net-new artifact lines in run comment
apps/backend/src/dashboard/
├── agents.controller.ts         # repo-name validation on create/update (400 field errors)
└── runs.controller.ts           # card(): select runs.report → normalized artifacts

apps/web/src/
├── components/AgentForm/AgentForm.vue  # repository multi-select
└── views/RunCard.vue                   # Artifacts block

test/integration/claude-cli-repository.spec.ts  # multi-repo matrix (research D12)
test/integration/fixtures (fake-claude)         # stream-success-multi-repo fixture
docs/architecture.md                            # §6, §7, §8 updates
docs/progress.md                                # iteration entry
```

**Structure Decision**: existing monorepo layout; every change lands in an existing
package/module — no new packages, no new modules, no new tables/queues.

## Phase 0 — research.md (complete)

All unknowns resolved as decisions D1–D13 in [research.md](research.md). Highlights
that shape the design:

- **D1**: absent scope now means ALL workspace repos (documented behavior change for
  agents with no repo field; identical in one-repo workspaces).
- **D2**: `schema_version: 1|2` union; no version⇄field coupling; `CompleteTaskSchema`
  aliases ReportSchema so MCP/HTTP callbacks need zero wiring.
- **D3**: uniform layout for ALL repo runs (no single-repo special case) — one
  prepare/cleanup/inspection code path; wrapper names each repo's absolute path.
- **D4**: `prepareAll` reuses the battle-tested single-repo prepare body; all-or-nothing
  unwind on partial failure; resume attaches where the branch exists, creates where it
  doesn't.
- **D6/D8**: one review task per run (Markdown PR list when N>1); one
  `normalizeReportArtifacts` helper feeds scrubber/review/ADF/card/feature-context —
  survey showed ADF + dashboard artifact rendering are entirely net-new surfaces.
- **D9**: wrapper gets a `## Repositories` section with spec FR-013 conduct rules; the
  dormant behavior→wrapper compiler stays unbuilt (scope discipline).
- **D10**: cross-field name validation on BOTH write paths (YAML superRefine + agents
  controller 400s), mirroring the existing executor repository check.

## Phase 1 — Design & Contracts (complete)

- [data-model.md](data-model.md) — behavior scope fields, workspace layout, report v2
  shape, run-card projection, wrapper input, relationships.
- [contracts/agent-repository-scope.md](contracts/agent-repository-scope.md) — the
  three write surfaces + run-time resolution contract.
- [contracts/report-v2-artifacts.md](contracts/report-v2-artifacts.md) — schema delta,
  precedence rule, per-consumer obligations.
- [quickstart.md](quickstart.md) — unit/integration/manual validation matrix + docs
  gate.
- Agent-context update script: not present in this repo's spec-kit scripts
  (`.specify/scripts/bash/` has no update-agent-context script) — step skipped; the
  feature pointer for downstream commands is `.specify/feature.json`.

### Implementation order (for /speckit-tasks)

1. **Contracts first**: report.schema (v2 + repos + normalizer) → agents-config /
   dashboard schemas (+ unit specs). Everything downstream types against these.
2. **Worktree layer**: `prepareAll`/`cleanupAll` + unit specs (layout, leftover,
   partial-failure, resume fallback).
3. **Executor**: `resolveRepositoryNames`/`pickWorkspaceRepositories`, loadRunConfig
   returns `repos[]`, prepare/cleanup wiring, worktree_path/wrapper parent-dir
   placement (+ executor unit specs).
4. **Wrapper + feature-context** (+ snapshot specs).
5. **Backend consumers**: scrubReport, review-task fan-in, agents controller
   validation, run-card artifacts (+ specs).
6. **Jira ADF + web** (AgentForm multi-select, RunCard artifacts) (+ specs/snapshots).
7. **Integration matrix** (extend claude-cli-repository.spec, new fixture).
8. **Docs**: architecture §6/§7/§8, progress.md iteration entry.

## Complexity Tracking

No constitution violations — table intentionally empty.
