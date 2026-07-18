# Tasks: Multi-Repository Runs

**Input**: Design documents from `/specs/019-multi-repo-runs/`

**Prerequisites**: plan.md, spec.md, research.md (D1–D13), data-model.md, contracts/, quickstart.md

**Tests**: MANDATORY — every story below touches pipeline logic (executor lifecycle, report processing, callback validation), so test tasks are included per constitution Principle VI and spec FR-016. Write each story's tests first and see them fail before implementing.

**Organization**: grouped by user story (US1 multi-repo run, US2 back-compat, US3 scoping) so each is independently implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1 / US2 / US3 from spec.md

## Path Conventions

pnpm monorepo: `packages/contracts`, `libs/*`, `apps/backend`, `apps/web`, integration suite in `test/integration/` (testcontainers), fake-claude fixtures in `test/fixtures/claude-cli/`.

---

## Phase 1: Setup

**Purpose**: clean baseline — no scaffolding needed (all changes land in existing modules).

- [X] T001 Verify baseline is green before starting: `pnpm typecheck && pnpm lint && pnpm test` at repository root (record any pre-existing failures so they are not attributed to this feature)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: ReportSchema v2 + the artifacts normalizer — every story types against these (US1 renders repos[], US2 asserts v1 stays valid, US3's wrapper guidance references v2).

**⚠️ CRITICAL**: no user story work can begin until this phase is complete.

- [X] T002 [P] Contract tests for ReportSchema v2 in `packages/contracts/src/report.schema.spec.ts`: v1 + flat artifacts still valid; v2 + `artifacts.repos[]` valid; v1 + repos valid (no version⇄field coupling, research D2); repos entry `.strict()` shape (`repo` required, max 20 entries); `normalizeReportArtifacts` precedence — repos[] wins over flat, flat → one-element list with `repo` undefined, neither → `[]` (contracts/report-v2-artifacts.md)
- [X] T003 Implement ReportSchema v2 in `packages/contracts/src/report.schema.ts`: `schema_version: z.union([z.literal(1), z.literal(2)])`; add `ReportRepoArtifactSchema` and `repos` to the `.strict()` `ReportArtifactsSchema`; export `ReportRepoArtifact` type and `normalizeReportArtifacts(report)`; confirm `CompleteTaskSchema = ReportSchema` propagates in `packages/contracts/src/callback-tools.schema.ts` and update any `schema_version: 1` fixtures in `packages/contracts/src/callback-tools.schema.spec.ts`

**Checkpoint**: contracts build green; both report forms validate; normalizer unit-tested.

---

## Phase 3: User Story 1 — A cross-repository ticket is completed in a single run (Priority: P1) 🎯 MVP

**Goal**: a run prepares one worktree per in-scope repo under `worktreeRoot/<runId>/<repo.name>/` (cwd = parent, same ticket branch everywhere), the wrapper instructs per-repo conduct, and per-repo artifacts flow through scrubber → review task → Jira comment → dashboard card.

**Independent Test**: integration case — agent in a two-repo workspace (no scope fields: absent = ALL repos, research D1) runs on a ticket; both caches cloned, both worktrees on `feat/<ticket>`, run completes with `artifacts.repos[]` persisted; card/comment render one line per reported repo.

**Note on scope fields**: `behavior` is opaque jsonb at runtime — the executor reads `repositories`/`repository` directly, so US1 does not depend on US3's schema typing/validation.

### Tests for User Story 1 (write first, watch them fail) ⚠️

- [X] T004 [P] [US1] Extend `libs/executors/src/claude-cli/worktree.spec.ts`: `prepareAll` two repos → layout `worktreeRoot/<runId>/<name>` + same branch in both caches; leftover policy per repo (zero-commit deleted+recreated, with-commits fails loud naming the repo); partial failure at repo 2 unwinds repo 1's worktree and removes the parent dir (SC-006); `cleanupAll` removes per-repo worktrees + parent, `keep: true` skips all; `reuseBranch` attaches where the branch exists and creates where it doesn't (research D4)
- [X] T005 [P] [US1] Extend `libs/executors/src/claude-cli/pick-repository.spec.ts`: `resolveRepositoryNames` precedence (repositories[] > repository > [] ); `pickWorkspaceRepositories` — empty names → ALL (DB list wins, workspace order), subset filter, unknown name throws, YAML fallback when DB list empty
- [X] T006 [P] [US1] Extend `libs/executors/src/claude-cli/wrapper.spec.ts` (snapshots): `## Repositories` section lists name/absPath/branch/base per repo + the four FR-013 conduct rules + checks-only-in-touched-repos line + `schema_version: 2` guidance; no-repo wrapper stays byte-identical

### Implementation for User Story 1

- [X] T007 [US1] Implement `prepareAll`/`cleanupAll` in `libs/executors/src/claude-cli/worktree.ts` per research D4: reuse the existing single-repo prepare body with an explicit per-repo target dir; sequential loop; all-or-nothing unwind; parent-dir removal in cleanup; `setupRunBranchIdentity` untouched
- [X] T008 [US1] Replace single-repo resolution in `libs/executors/src/claude-cli/claude-cli.executor.ts`: `resolveRepositoryName` → `resolveRepositoryNames(behavior): string[]`, `pickWorkspaceRepository` → `pickWorkspaceRepositories(...): WorktreeRepo[]`; `loadRunConfig` returns `repos: WorktreeRepo[]`; setup runs keep a one-element scope + FR-017 degrade path (research D5)
- [X] T009 [US1] Rewire `run()` in `libs/executors/src/claude-cli/claude-cli.executor.ts`: `prepareAll` over the repo list; `runs.worktree_path` = parent dir; `.brigadir/wrapper.txt` + spawn cwd = parent (verify `buildArgs` wrapper-path derivation in `libs/executors/src/claude-cli/args.ts` needs no change); `cleanupAll` with `keepFailedWorktrees && runFailed` keeping the whole parent; update `libs/executors/src/claude-cli/claude-cli.executor.spec.ts`
- [X] T010 [US1] Implement the `## Repositories` wrapper section in `libs/executors/src/claude-cli/wrapper.ts`: `options.repos?: {name; absPath; defaultBranch; branch}[]`; parent-dir wording in `## Rules`; conduct rules (a)–(d) from spec FR-013 + per-touched-repo checks (research D9 — no behavior→wrapper compiler)
- [X] T011 [US1] Per-repo artifact lines in `libs/executors/src/claude-cli/feature-context.ts` via `normalizeReportArtifacts` (prior multi-repo runs surface every branch/PR); update `libs/executors/src/claude-cli/feature-context.spec.ts`
- [X] T012 [US1] Scrub both artifact forms in `libs/callback/src/callback.service.ts` `scrubReport`: flat `branch`/`pr_url`/`commits[]` + `repos[].repo/branch/pr_url/commits[]` (closes the artifacts-unscrubbed gap, research D7); extend the callback service unit spec and `test/integration/callback-scrubbing.spec.ts`
- [X] T013 [US1] Review-task fan-in in `libs/callback/src/callback.service.ts` `maybeQueueReviewTask` via the normalizer: 1 PR → title unchanged; N>1 → one task `Review PRs (<n>)` with Markdown `<repo>: <url>` list in details (research D6); extend `test/integration/callback-pr-review.spec.ts`
- [X] T014 [P] [US1] Net-new artifact lines in `libs/jira/src/adf-composer.ts` `buildRunComment` after the checks taskList — `<repo>: <branch> — <pr_url> (<n> commits, <m> files)`, absent fields omitted, flat entry without repo prefix; regenerate `libs/jira/src/__snapshots__/adf-composer.spec.ts.snap` via `libs/jira/src/adf-composer.spec.ts`
- [X] T015 [US1] Dashboard card carries artifacts: add normalized `artifacts[]` (commits as count) to `RunCardResponseSchema` in `packages/contracts/src/runs.schema.ts`; select `runs.report` and project via the normalizer in `card()` in `apps/backend/src/dashboard/runs.controller.ts`
- [X] T016 [US1] Render the Artifacts block in `apps/web/src/views/RunCard.vue` (one line per entry: repo, branch, PR link, counts; hidden when empty); extend `apps/web/test/run-card.spec.ts`
- [X] T017 [P] [US1] New fake-claude fixture `test/fixtures/claude-cli/stream-success-multi-repo.ndjson`: structured output with `schema_version: 2` + two `artifacts.repos` entries (mirror `stream-success.ndjson` framing)
- [X] T018 [US1] Extend `test/integration/claude-cli-repository.spec.ts` (real pg/redis + fake-claude): (1) absent scope in a two-repo workspace → BOTH caches cloned, ticket branch exists in both cache repos, run succeeds, `runs.worktree_path` = parent `worktreeRoot/<runId>` — replaces the old "absent → default repo" expectation (research D1); (2) run with the multi-repo fixture → persisted `runs.report` carries scrubbed `artifacts.repos[]`

**Checkpoint**: US1 fully functional — quickstart §2 multi-repo rows pass.

---

## Phase 4: User Story 2 — Existing single-repository agents behave exactly as before (Priority: P2)

**Goal**: legacy `behavior.repository` agents, v1 flat reports, and ticketless setup runs are bit-compatible in observable behavior; stored rows never rewritten.

**Independent Test**: run a legacy agent (`behavior.repository: 'infra'`) end-to-end — one repo prepared, flat report accepted and rendered, no config edit; setup run keeps `setup/<runId8>` identity.

### Tests for User Story 2 (verification-heavy story — these ARE the deliverable) ⚠️

- [X] T019 [P] [US2] In `test/integration/claude-cli-repository.spec.ts`: keep/adjust the legacy case — `behavior.repository: 'infra'` clones ONLY infra (one-element list) under the new parent layout, run succeeds; keep the no-repos-anywhere error case (c) asserting the clear diagnostics
- [X] T020 [P] [US2] Extend `test/integration/callback-completion.spec.ts`: a `schema_version: 1` report with flat artifacts (no `repos`) validates, persists, and renders — review task title `Review PR: <url>` byte-identical, ADF comment shows the single legacy artifact line, run card shows one entry with no repo name
- [X] T021 [US2] Setup-run regression: unit coverage in `libs/executors/src/claude-cli/claude-cli.executor.spec.ts` + `libs/executors/src/claude-cli/worktree.spec.ts` that a ticketless setup run flows through `prepareAll` with a one-element scope on branch `setup/<runId[0:8]>` (never the all-repos default), and the FR-017 no-repo degrade path still lands in the scratch dir; then run the existing setup-run integration suite (`pnpm test:integration -- workspace-setup brigadir-agent-settings`) unchanged

**Checkpoint**: US1 + US2 — quickstart §2 legacy row and §3 step 6 pass without touching stored rows.

---

## Phase 5: User Story 3 — Operator scopes an agent to a subset of workspace repositories (Priority: P3)

**Goal**: `behavior.repositories` is a first-class, validated field on all three write surfaces (YAML boot, dashboard API, web form); typos rejected at config time with field-level errors.

**Independent Test**: agent with `repositories: ['product']` in a two-repo workspace → only product prepared; saving a list with an unknown name → YAML boot error / API 400 pointing at the offending entry.

### Tests for User Story 3 ⚠️

- [X] T022 [P] [US3] Extend `packages/contracts/src/agents-config.schema.spec.ts`: typed `behavior.repositories`/`repository` accepted; superRefine rejects unknown names with issue path `agents[i].behavior.repositories[j]` (and `.repository`); check skipped when workspace declares no repositories; both-fields precedence documented (list wins, no error); `ClaudeCliExecutorConfigSchema.repository` now optional — old YAMLs (present) and new YAMLs (absent) both valid, reference check still fires when present

### Implementation for User Story 3

- [X] T023 [US3] Implement the YAML contract in `packages/contracts/src/agents-config.schema.ts`: typed optional `repository`/`repositories` on `AgentBehaviorSchema`; cross-field superRefine mirroring the executor check; executor `repository` → `optional()` (contracts/agent-repository-scope.md §1)
- [X] T024 [US3] Dashboard API: add `repositories: z.array(z.string().min(1)).optional()` to `AgentBehaviorRequestSchema` in `packages/contracts/src/dashboard.schema.ts` (+ deprecation comment on `repository`); validate both fields' names against the workspace's `settings.repositories` in create/update in `apps/backend/src/dashboard/agents.controller.ts` returning 400 with field path; extend `test/integration/agent-crud.spec.ts` (valid list round-trips; unknown name → 400; legacy `repository` still accepted)
- [X] T025 [US3] Web form: repository single `el-select` → multi-select bound to `form.repositories` in `apps/web/src/components/AgentForm/AgentForm.vue` (loads `repositories` falling back to legacy `repository`; empty selection labelled "all repositories"; saving writes `repositories` and nulls the legacy key for that agent only); update `apps/web/test/agent-form.spec.ts`
- [X] T026 [US3] Subset run integration in `test/integration/claude-cli-repository.spec.ts`: `behavior.repositories: ['infra']` in a two-repo workspace → only infra cloned/prepared; DB-seeded unknown name in the list → run fails with the `pickWorkspaceRepositories` diagnostics (defense-in-depth behind config validation)

**Checkpoint**: all three stories independently green.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T027 [P] Update `docs/architecture.md`: §6 artifacts `repos[]` block + `schema_version {"enum":[1,2]}` (mirror contracts/report-v2-artifacts.md); §7 behavior example gains `repositories` + deprecated single-string note + wrapper Repositories section; §8 `RunRuntime.prepare` takes `repos: {repoUrl, ref}[]` (doc-only, research D11)
- [X] T028 [P] Append the iteration entry to `docs/progress.md` (feature 019: what shipped, decisions D1/D3 behavior notes, test counts) per house format
- [X] T029 Full validation per `specs/019-multi-repo-runs/quickstart.md`: `pnpm typecheck && pnpm lint && pnpm test`, then `pnpm test:integration` (full suite — shared testcontainers), regenerate any stale snapshots deliberately
- [X] T030 Final gates: `git diff --stat` contains no `drizzle/` changes (spec FR-017); finalization guards (`WHERE status='running'`, `markRunning`) untouched in the diff; spec SC-001…SC-006 spot-checked against the integration output

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: none.
- **Phase 2 (Foundational)**: after T001. T002 (tests) before T003 (impl). **Blocks all stories** (US1 consumers import the normalizer; US2 asserts the union; US3 wrapper guidance references v2).
- **Phase 3 (US1)**: after Phase 2. Internal order: T004–T006 (tests, parallel) → T007 → T008 → T009 → T010 → T011; T012 → T013 (same file, sequential); T014 [P] anytime after Phase 2; T015 → T016; T017 [P] anytime; T018 last (needs T009+T012+T017).
- **Phase 4 (US2)**: after US1's executor/worktree work (T007–T009) since it verifies the new code path preserves legacy behavior; T019/T020 parallel, T021 after T009.
- **Phase 5 (US3)**: T022–T025 depend only on Phase 2 and can run in parallel with US1 implementation (different files — schema/API/web); T026 needs US1's T008/T018 harness state.
- **Phase 6 (Polish)**: after all desired stories; T027/T028 parallel; T029 → T030 last.

### User Story Dependencies

- **US1 (P1)**: independent — reads behavior fields as opaque jsonb, needs no US3 typing.
- **US2 (P2)**: verifies US1's implementation; no US3 dependency.
- **US3 (P3)**: config surfaces independent of US1 (parallelizable); only its run-level integration case (T026) rides US1's harness.

### Parallel Opportunities

```text
After Phase 2:
  Track A (executor core):   T004 T005 T006 → T007 → T008 → T009 → T010 → T011
  Track B (report pipeline): T012 → T013;  T014;  T015 → T016;  T017
  Track C (US3 config):      T022 → T023 → T024 → T025
Join: T018 (A+B+fixture) → Phase 4 (T019 T020 in parallel, T021) → T026 → Polish
```

## Parallel Example: User Story 1

```bash
# Failing tests first, in parallel (three different spec files):
Task: "worktree.spec.ts — prepareAll layout/partial-failure/cleanupAll cases"
Task: "pick-repository.spec.ts — list resolution semantics"
Task: "wrapper.spec.ts — Repositories section snapshots"

# Independent implementation files in parallel once contracts are green:
Task: "adf-composer.ts artifact lines + snapshots"          # T014
Task: "stream-success-multi-repo.ndjson fixture"            # T017
```

---

## Implementation Strategy

### MVP First (US1 only)

1. Phase 1 → Phase 2 (contracts).
2. Phase 3 completely; stop at the checkpoint and run the quickstart §2 multi-repo rows.
3. That alone delivers the feature's value (cross-repo ticket in one run) with default all-repos scope.

### Incremental Delivery

1. + Phase 4 → back-compat certified (safe to deploy over existing workspaces).
2. + Phase 5 → operators can scope agents; validation guards typos.
3. + Phase 6 → docs gate satisfied (constitution: same-iteration docs), full suite green.

### Notes

- Same-file tasks are deliberately NOT marked [P] (T012/T013 both edit callback.service.ts; T008/T009 both edit the executor).
- Commit after each task or logical group; every checkpoint is a valid pause point.
- T018's expectation change (absent scope → ALL repos) is the one deliberate behavior change — research D1; do not "fix" the old expectation back.
