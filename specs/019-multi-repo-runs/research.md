# Research & Decisions: Multi-Repository Runs

**Feature**: 019-multi-repo-runs | **Date**: 2026-07-18

No NEEDS CLARIFICATION markers existed in the Technical Context; this document records
the design decisions that resolve every point the spec left to the plan, each grounded
in a code-level survey of the current implementation (file:line references are to the
state of the tree at planning time).

---

## D1 — Repository-scope resolution semantics

**Decision**: Resolution order for a repo-carrying run:

1. `behavior.repositories` non-empty → that subset, in workspace declaration order
   (the workspace list is the canonical order; the agent's list is a filter, not an
   ordering).
2. else `behavior.repository` non-empty string → one-element list (deprecated form).
3. else (absent/empty both) → **ALL** workspace repositories.

`pickWorkspaceRepository` (claude-cli.executor.ts:56) becomes
`pickWorkspaceRepositories(dbRepos, yamlRepos, names: string[], yamlLoaded): WorktreeRepo[]`
with the same DB-beats-YAML source-of-truth rule per list. Empty array `[]` is
normalized to "absent" (spec FR-001: empty/absent = all).

**Deliberate behavior change (documented)**: an agent with NO repo field at all
previously got the workspace DEFAULT (first) repository; it now gets ALL workspace
repositories. In a one-repo workspace this is identical; in a multi-repo workspace this
is the feature's intended default. The existing integration case "(b) absent
behavior.repository → default repo" in `test/integration/claude-cli-repository.spec.ts:137`
is updated to assert the new all-repos semantics.

**Rationale**: matches spec FR-001/FR-002 precedence exactly; keeps stored rows valid
without rewriting.

**Alternatives considered**: treating absent as "default repo only" (rejected — defeats
the feature for generated teams, which carry `behavior: {}`); erroring when both fields
are present (rejected — a stored legacy row plus a later list edit must coexist, spec
Assumptions).

## D2 — ReportSchema version bump strategy

**Decision**: `schema_version: z.union([z.literal(1), z.literal(2)])`. `artifacts`
gains `repos: z.array(ReportRepoArtifactSchema).max(20).optional()` inside the existing
`.strict()` `ReportArtifactsSchema` (report.schema.ts:132); flat fields stay. No
conditional tying `repos` to version 2 — v1+flat, v1+repos, v2 anything all validate
(forward-compatible per architecture §6 rules; there is no migration machinery in the
codebase and none is introduced). The wrapper/callback guidance advertises
`schema_version: 2`. `CompleteTaskSchema = ReportSchema`
(callback-tools.schema.ts:45), so the MCP `complete_task` tool picks the change up with
zero extra wiring.

**Rationale**: the only versioning mechanism that exists today is the literal itself
(no migration helpers anywhere — confirmed by survey); a union keeps every stored and
in-flight v1 report valid, which is exactly what "forward-compatible" means here.

**Alternatives considered**: separate ReportSchemaV2 + dispatch (rejected — no
consumer needs to distinguish versions; doubles every contract test); requiring
`repos` when version=2 (rejected — a v2 analysis-only run has no artifacts at all).

## D3 — Uniform workspace layout (no single-repo special case)

**Decision**: every repo-carrying run — including single-repo legacy agents and setup
runs — uses the new layout: `worktreeRoot/<runId>/<repo.name>/` per repo, agent cwd =
parent `worktreeRoot/<runId>/`, `runs.worktree_path` = parent,
`.brigadir/wrapper.txt` in the parent. `buildArgs` already derives the wrapper path
from the dir it is given (args.ts:59), so it receives the parent unchanged.

**Rationale**: one code path for prepare/cleanup/inspection/keepFailedWorktrees; the
spec text mandates this layout without exception (FR-005). US2 "behaves exactly as
before" is defined at the observable level (delivery, report, rendering) — the wrapper
now names each repo's absolute path explicitly, so a single-repo agent is told exactly
where its repo lives (mitigates prompts that assumed cwd = repo root). The parent dir
is not itself a git worktree, which is strictly cleaner: `.brigadir/` no longer sits
inside a repo's working tree.

**Alternatives considered**: keep legacy layout when N==1 (rejected — two layouts ⇒
divergent cleanup, leftover, inspection and test matrices; and `worktreeRoot/<runId>`
being a worktree for N==1 but a plain dir for N>1 makes `git worktree prune`/remove
logic conditional).

## D4 — prepare/cleanup orchestration and partial-failure policy

**Decision**: `worktree.ts` keeps the existing single-repo `prepare()` (renamed
internally to prepare one repo into an explicit target dir) and gains:

- `prepareAll(repos: WorktreeRepo[], runId, ticketKey, branchPrefix, worktreeRoot,
  repoCacheRoot, opts): Promise<MultiPrepareResult>` — sequential loop (repo count is
  small; sequential keeps error attribution and leftover handling deterministic). Each
  repo gets the unchanged leftover-branch policy (zero-commit → delete+recreate;
  commits → `WorktreePrepareError`, fail loud). On ANY failure at repo N: cleanup the
  N−1 worktrees already created, remove the parent dir, rethrow (spec FR-008, SC-006).
- `cleanupAll(prepared, { keep })` — `git worktree remove --force` per repo from its
  cache, then `rm -rf` the parent dir; `keep: true` skips everything (whole parent kept
  for inspection).
- **Resumed attempts** (`reuseBranch: true`): per repo, if the ticket branch exists →
  attach (current behavior); if it does NOT exist in some repo (agent's scope widened
  between attempts, or first attempt never created it there) → fall back to fresh
  branch creation instead of failing. A resume is a deliberate continuation; a missing
  branch in one repo is not prior-work danger.
- `setupRunBranchIdentity` untouched; setup runs flow through `prepareAll` with a
  one-element list (D5).

**Rationale**: reuses the battle-tested single-repo body (leftover policy revised after
live incident 2026-07-14 — do not rewrite it); explicit partial-failure unwind is the
spec's hard requirement.

**Alternatives considered**: parallel prepare (rejected — clone-on-cold-cache
parallelism complicates failure unwind for negligible gain; warm-cache worktree add is
seconds); failing a resume when a branch is missing in one repo (rejected — would make
widening an agent's scope brick every in-flight awaiting_human run).

## D5 — Setup runs keep a one-element scope

**Decision**: workspace-setup runs resolve exactly as today — the setup template
behavior's `repository`/default — yielding a one-element list into `prepareAll`; the
FR-017 degrade-to-scratch path (no repos at all) is untouched. Setup runs do NOT get
the all-repos default.

**Rationale**: spec Assumptions pin setup runs to current behavior; the setup protocol
already instructs the agent to self-clone additional repos into `.repos/<name>`, and
its prompts/budgets were tuned for one mounted repo (feature 015). Widening is a
separate future decision.

## D6 — Review-task fan-in (code_delivery = pull_request)

**Decision**: `maybeQueueReviewTask` (callback.service.ts:186) normalizes artifacts via
the shared helper (D8) and creates **one** review human task per run: single PR keeps
today's title `Review PR: <url>` byte-for-byte; multiple PRs → title
`Review PRs (<n>)` with a Markdown list of `<repo>: <pr_url>` in `details`.

**Rationale**: one run = one review gate; per-PR tasks would multiply human-queue noise
for a single logical change. Single-PR path unchanged preserves US2.

**Alternatives considered**: one task per PR (rejected — resolve/resume semantics are
per-run; N tasks for one run has no meaningful independent resolution).

## D7 — Scrubbing artifacts (both forms)

**Decision**: extend `scrubReport` (callback.service.ts:41) to pass artifact strings
through `scrub()`: flat `branch`/`pr_url`/`commits[]` AND `repos[].repo/branch/pr_url/
commits[]` (`files_changed` is numeric — untouched). The scrubber itself
(libs/scrubber) is unchanged — traversal stays field-by-field at the caller, matching
the existing pattern.

**Rationale**: survey found artifacts are NOT scrubbed today — a latent gap against
Constitution V ("every outgoing report passes the scrubber") that this feature would
otherwise widen by adding more free-text fields. Fixing it for both forms is cheap and
in-scope (spec FR-012 names the scrubber).

## D8 — One artifacts normalizer; net-new rendering surfaces

**Decision**: add to `packages/contracts/src/report.schema.ts`:

```ts
export interface ReportRepoArtifact { repo?: string; branch?: string; pr_url?: string;
  commits?: string[]; files_changed?: number }
export function normalizeReportArtifacts(report: AgentReport): ReportRepoArtifact[]
// repos[] present → repos[] (authoritative, flat ignored — spec FR-011);
// else flat fields present → one-element list with repo undefined; else [].
```

All four consumers use it — no re-implementations of the precedence rule:

1. **Jira ADF** `buildRunComment` (adf-composer.ts:28): net-new artifact lines (none
   exist today) — after the checks taskList, one paragraph line per entry:
   `<repo>: <branch> — PR <link> (<n> commits, <m> files)` (fields omitted when
   absent; legacy flat renders without the repo prefix). Snapshots regenerated.
2. **Dashboard**: `RunCardResponseSchema` (runs.schema.ts:143) gains
   `artifacts: array(...)` (already-normalized list); backend `card()`
   (runs.controller.ts:244) additionally selects `runs.report` and projects it;
   `RunCard.vue` renders an "Artifacts" block (one line per repo: branch, PR link,
   commit/file counts) above the checks collapse. Net-new UI — today the card shows
   no artifacts at all.
3. **Review task** (D6).
4. **feature-context** `latestArtifacts` (feature-context.ts:28): renders per-repo
   `branch:`/`PR:` lines from the normalized list (multi-repo prior runs surface all
   their branches to the next agent).

**Rationale**: the survey showed Jira/dashboard artifact rendering is entirely net-new,
so the cheapest correct shape is to normalize once at the contracts layer and render a
list everywhere. Spec FR-012 satisfied for both forms.

## D9 — Wrapper: repositories section (no behavior→wrapper compiler)

**Decision**: `buildWrapperText(ctx, workspaceDir, options)` gains
`options.repos?: { name; absPath; defaultBranch; branch }[]`. For repo-carrying runs a
new `## Repositories` section lists every prepared repo (`- <name>: <absPath> (branch
<branch>, base <defaultBranch>)`) and instructs, verbatim per spec FR-013: (a) decide
from the ticket which repos need changes; (b) commit/push only in repos actually
changed; (c) when PRs in different repos depend on each other, reference the dependent
PRs in each PR description; (d) report per-repo artifacts via `artifacts.repos` in
`complete_task` (`schema_version: 2`), plus: run required checks/tests only in the
repos you changed. The `## Rules` "work only inside this workspace directory" line now
names the parent dir. No-repo (triage) runs render no such section — byte-identical
wrapper.

**Scope note**: the §7 behavior→wrapper compiler (`code_delivery`/`required_checks`/
`verification` interpolation) is dormant Phase-2 machinery — confirmed unimplemented —
and stays out of scope. Spec FR-015 ("checks only in touched repos") is delivered at
the instruction level, which is the only level at which checks exist today; no new
harness enforcement is added.

**Alternatives considered**: building the full behavior compiler now (rejected —
explicit scope-discipline violation; the constitution names "behavior compiler" as a
deliberately cut feature).

## D10 — Cross-field validation on both write paths

**Decision**:

- **YAML/boot** (`AgentsConfigSchema.superRefine`, agents-config.schema.ts:171):
  `AgentBehaviorSchema` gains typed optional `repository: z.string()` and
  `repositories: z.array(z.string())`; the superRefine validates each name in either
  field against `workspace.repositories[].name` with a per-entry issue path
  (`agents[i].behavior.repositories[j]`), mirroring the existing executor check
  (L196-207). `ClaudeCliExecutorConfigSchema.repository` (L75) becomes **optional**
  (it is already ignored at runtime and stripped by the config-seeder); the existing
  reference check runs only when present.
- **Dashboard API**: `AgentBehaviorRequestSchema` (dashboard.schema.ts:145) gains
  `repositories: z.array(z.string().min(1)).optional()`; `agents.controller.ts`
  validates the names (and the deprecated single name — closing today's gap where a
  typo'd `repository` via API only fails at run prepare) against the workspace's
  `settings.repositories`, returning a 400 field error.

**Rationale**: spec FR-003; the run-time error in `pickWorkspaceRepositories` remains
as the last-resort guard but config-time rejection is the contract.

## D11 — RunRuntime doc contract (architecture §8)

**Decision**: doc-only update (no `RunRuntime` implementation exists in the tree —
confirmed): `prepare(spec: { repos: { repoUrl: string; ref: string }[]; env })` →
`WorkspaceHandle` now denotes the parent workspace containing one worktree per repo.
§6 gets the `repos[]` artifacts block + `schema_version enum [1,2]`; §7's behavior
example gains `"repositories": ["lib", "consumer"]` with the deprecated single-string
note and the new wrapper Repositories section.

## D12 — Test strategy (Constitution VI)

**Unit (same iteration)**:
- `agents-config.schema.spec.ts`: repositories accepted; unknown name → issue with
  path; both-fields precedence; executor `repository` now optional.
- `report.schema.spec.ts` (+ `callback-tools.schema.spec.ts`): v1 flat still valid;
  v2 + repos valid; repos entry shape; `normalizeReportArtifacts` precedence
  (repos-wins, flat fallback, empty).
- `worktree.spec.ts`: `prepareAll` two repos → layout + same branch both; leftover
  policies per repo; partial failure cleans up already-created worktrees + parent
  (SC-006); `cleanupAll` keep-flag; reuse-with-missing-branch fallback.
- `wrapper.spec.ts` (snapshots): repos section content; no-repo wrapper byte-identical.
- `pick-repository.spec.ts`: list resolution (subset, all, deprecated, unknown-name
  error).
- `claude-cli.executor.spec.ts`: worktree_path = parent; wrapper lands in parent.
- `adf-composer.spec.ts` snapshots; callback.service spec (scrub of both artifact
  forms; review-task single/multi); `feature-context.spec.ts` per-repo lines.
- Web: `agent-form.spec.ts` multi-select round-trip; RunCard artifacts render.

**Integration (testcontainers, real pg/redis — extending
`test/integration/claude-cli-repository.spec.ts`)**:
- Agent with `repositories: ['product','infra']` → both caches cloned, both worktrees
  prepared on the same ticket branch (assert branch exists in both cache repos), run
  completes, `runs.worktree_path` points at the (now removed) parent path.
- Legacy `behavior.repository: 'infra'` case unchanged (US2).
- Absent scope → ALL repos (updated expectation, D1).
- Unknown name in list at run level → run fails with the clear pickWorkspaceRepositories
  error (defense-in-depth behind config validation).
- Report round-trip with `artifacts.repos` via the fake-claude fixture (new
  `stream-success-multi-repo` fixture) → persisted report carries repos[]; scrubbed.

## D13 — No DB schema change

Confirmed: repository scope lives in `agents.behavior` jsonb, reports in `runs.report`
jsonb, `runs.worktree_path` already exists (text). No migration; architecture §3
untouched (spec FR-017).
