# Implementation Plan: Branch Handoff Follow-Up

**Branch**: `claude/brigadir-023-followup-rop3qc` (feature directory `024-branch-handoff-followup`) | **Date**: 2026-07-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/024-branch-handoff-followup/spec.md`

## Summary

Three follow-ups to feature 023's report-driven branch handoff:

1. **US1 (P1, live bug)** — the rework/triage/answer-triage handoff prompt
   sections read only flat v1 artifacts and bypass `normalizeReportArtifacts`;
   in a v2-reporting workspace they render no branch line at all. Fix: route
   both sites in `libs/pipeline/src/handoff.ts` through the single normalizer
   and render one line per repo (research D1).
2. **US2 (P2)** — the wrapper stops suggesting a system-invented branch name
   (`run/<TICKET>`): the suggestion machinery (`suggestedBranch`,
   `branchPrefix ?? 'run'`, `setupRunBranchIdentity`) is removed;
   `branch_prefix` stays inert in schemas/API/UI, no migration (research D2).
3. **US3 (P3)** — deterministic backstop for "agent committed but reported
   nothing": `complete_task` is gated. The MCP tool server observes per-repo
   worktree HEADs and sends them in a request header; the backend compares
   them against start SHAs recorded at prepare time and rejects a completion
   that omits a moved repo — run stays active, agent corrects; uncorrected ⇒
   the existing fail-closed path. The 023 exit-time sketch is abandoned as
   provably not a control (research D3–D6).

## Technical Context

**Language/Version**: TypeScript strict, Node 22 (pnpm workspace monorepo)

**Primary Dependencies**: NestJS 11 (backend + worker), BullMQ 5, drizzle-orm,
zod 4 (`packages/contracts`), `@modelcontextprotocol/sdk` (mcp-server)

**Storage**: Postgres 16 (`runs`, `run_events` — jsonb payloads, additive keys
only; **no schema migration**)

**Testing**: vitest unit/contract per lib; vitest + testcontainers integration
(`test/integration`) — **Docker unavailable in this session**; integration
runs deferred to the operator's stand (iteration-29 precedent, stated not
implied)

**Target Platform**: Linux server (self-hosted backend + worker node
processes)

**Project Type**: web-service monorepo (NestJS apps + shared libs + Vue
dashboard; dashboard untouched by this feature)

**Performance Goals**: n/a beyond existing paths — adds ≤2 local git
`rev-parse` calls per repo per run (prepare + complete), no network calls

**Constraints**: handoff assembly stays best-effort and size-bounded (feature
010 FR-013); callback POST body contract (`ReportSchema.strict()`) must not
change; run/ticket finalization ordering must not change; hard-won rules 3, 7
untouched

**Scale/Scope**: ≤20 repos per run (schema cap); 3 libs + 1 package touched
(`libs/pipeline`, `libs/executors`, `libs/callback`, `packages/mcp-server`) +
contracts docs

## Constitution Check

*GATE: evaluated pre-Phase-0 and re-checked post-design — PASS (no violations,
no Complexity Tracking entries).*

- **I. Dual Source of Truth** — PASS. No new source of truth: start SHAs and
  violations live in `run_events` (Postgres, run history domain); Jira
  untouched; the gate runs before any Jira write is enqueued.
- **II. Idempotency at Three Levels** — PASS. No trigger path touched; no
  dedup layer altered. Gate rejections leave the run active — the repeated
  `complete` 409 for finished runs is preserved (research D6).
- **III. System-Only Jira Writes** — PASS. Agents still report only through
  callback tools; no new Jira write path; wrapper text changes reinforce the
  reporting contract.
- **IV. Run Completion Contract** — PASS, deliberately strengthened.
  Completion remains "schema-valid accepted `complete_task` only"; the gate
  adds a rejection reason *before* finalization, mirroring the existing
  invalid-team-report 422 (run stays active, agent corrects). No structured-
  output rescue path added; exit-without-completion still fails closed.
  Exactly one completion channel per run — unchanged.
- **V. Secret Isolation & Output Scrubbing** — PASS. `BRIGADIR_REPO_DIRS`
  rides the existing 0600 tool-server env-block config file (worktree paths
  are not secrets, but the delivery path is the sanctioned one); nothing new
  in argv or the agent's env; report scrubbing unchanged (gate reads the
  already-scrubbed report); observed-heads header carries only SHAs the
  system computed itself.
- **VI. Test-Mandatory Pipeline Logic** — PASS. All three stories are pipeline
  logic and ship with unit/contract tests in the same change (research D7);
  integration additions are written now, executed on the stand (Docker absent
  here — explicitly deferred, never implied).
- **Technology Constraints** — PASS. No new dependencies; no eager
  composition-time resource reads added (the MCP server reads env at process
  start as designed — it is a per-run child process, not a Nest module).

## Project Structure

### Documentation (this feature)

```text
specs/024-branch-handoff-followup/
├── spec.md              # feature specification (amended: US3 gate semantics)
├── plan.md              # this file
├── research.md          # D1–D7 decisions
├── data-model.md        # run_events payload deltas, env/header shapes
├── quickstart.md        # validation guide (session + stand)
├── contracts/
│   ├── handoff-artifact-lines.md   # US1: prompt-line rendering contract
│   ├── wrapper-branch-lines.md     # US2: wrapper repo-line contract
│   └── completion-gate.md          # US3: header + gate + rejection contract
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks output (next phase)
```

### Source Code (repository root)

```text
libs/pipeline/src/
├── handoff.ts                      # US1: failureLines + buildReworkSection → normalizer
└── handoff.spec.ts                 # US1 tests (v1 assertions preserved)

libs/executors/src/claude-cli/
├── wrapper.ts                      # US2: drop suggestedBranch rendering; reword rules line
├── wrapper.spec.ts                 # US2 tests
├── worktree.ts                     # US2: delete setupRunBranchIdentity; US3: RepoStart.startSha
├── worktree.spec.ts (if present) / executor spec seams
├── claude-cli.executor.ts          # US2: drop branchPrefix/suggestedBranch;
│                                   # US3: start-ref event after prepareAll (+startSha);
│                                   #      BRIGADIR_REPO_DIRS into tool-server env block
└── mcp config writer (same file / mcp-config.ts)

packages/mcp-server/src/
├── main.ts                         # US3: optional BRIGADIR_REPO_DIRS env
├── tools.ts                        # US3: complete_task observes HEADs → header
└── tools.spec.ts                   # US3 tests

packages/contracts/src/
└── (no schema change; contracts docs only — ReportSchema untouched)

libs/callback/src/
├── callback.service.ts             # US3: gate before finalizeWithReport + run_event
├── gate (new small module, e.g. completion-gate.ts)  # pure decision fn
└── specs                           # US3 tests

libs/runs/src/runs.service.ts       # untouched (guards stay as-is)

test/integration/                   # extended flows; execution deferred (no Docker here)
docs/progress.md                    # iteration entry (same change as code)
docs/architecture.md                # §5 callback protocol: observed-heads header note
```

**Structure Decision**: existing monorepo layout; no new projects. The only
new file is a small pure decision module in `libs/callback` so the gate is
unit-testable without HTTP or DB plumbing.

## Complexity Tracking

No constitution violations — table intentionally empty.
