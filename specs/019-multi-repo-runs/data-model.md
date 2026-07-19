# Data Model: Multi-Repository Runs

**Feature**: 019-multi-repo-runs | **Date**: 2026-07-18

No database schema changes (architecture §3 as-is). All new data lives inside existing
jsonb columns and in-process contracts.

## 1. Agent repository scope (`agents.behavior` jsonb)

| Field | Type | Rules |
|---|---|---|
| `behavior.repositories` | `string[]` (optional) | Each entry must equal a `workspace.settings.repositories[].name` (validated at config write time, both YAML boot and dashboard API). Empty array ≡ absent. |
| `behavior.repository` | `string` (optional, **deprecated**) | Legacy one-element form. Kept valid forever; stored rows never rewritten. |

**Resolution** (single implementation: `resolveRepositoryNames` +
`pickWorkspaceRepositories` in the claude-cli executor):

```
repositories non-empty  → that subset (workspace declaration order)
else repository non-empty → [repository]
else                     → ALL workspace repositories
```

Repository source of truth unchanged: `workspaces.settings.repositories` (DB) first,
`agents.yaml workspace.repositories[]` fallback for YAML-imported setups.

**States/lifecycle**: none — pure configuration read at run start.

## 2. Run workspace (filesystem layout + `runs.worktree_path`)

```
worktreeRoot/<runId>/                  ← parent dir; agent cwd; runs.worktree_path
├── .brigadir/wrapper.txt              ← instruction wrapper (outside any repo tree)
├── <repoA.name>/                      ← git worktree of repoA cache, DETACHED at its start ref
└── <repoB.name>/                      ← git worktree of repoB cache, own start ref
```

> **SUPERSEDED by feature 023** — the three bullets on branch identity, the leftover
> policy and `reuseBranch` below are historical. Current model: the system creates no
> branch; each repo is detached at `origin/<continueBranch>` (the branch a previous
> stage reported for THAT repo) or `origin/<defaultBranch>`. Repos diverge
> independently — there is no run-level branch.

- ~~Branch identity: `<branchPrefix>/<ticketKey>` in EVERY repo~~; ticketless setup runs
  suggest `setup/<runId[0:8]>` to the agent (feature 023 — no longer created).
- Clone caches unchanged: `repoCacheRoot/<repo.name>` (one per repo, shared across runs);
  since 023 the refresh fetch prunes deleted remote-tracking refs.
- Lifecycle: `prepareAll` (all-or-nothing; partial failure unwinds created worktrees
  and removes the parent) → run → `cleanupAll` (worktree remove per repo + parent rm),
  skipped entirely when `keepFailedWorktrees` && run failed. **Unaffected by 023.**
- ~~Leftover-branch policy per repo: 0 commits beyond base → delete+recreate; >0 commits →
  fail loud. Resume (`reuseBranch`): attach if branch exists, else create.~~ Retired: with
  detached worktrees the system owns no branch name to collide with, and `git branch -D`
  left the codebase — no code path can discard prior work.

## 3. Report artifacts (`runs.report` jsonb — ReportSchema v2)

```jsonc
{
  "schema_version": 2,               // union: 1 | 2 (v1 stays valid forever)
  // ... outcome/summary/checks/human_task/routing/team unchanged ...
  "artifacts": {
    // flat form — legacy single-repo (still valid, v1 producers):
    "branch": "feat/T-1", "pr_url": "…", "commits": ["…"], "files_changed": 3,
    // plural form — authoritative when present:
    "repos": [
      {
        "repo": "lib",               // workspace repository name
        "branch": "feat/T-1",
        "pr_url": "https://…",       // optional
        "commits": ["sha1 …"],       // optional
        "files_changed": 2           // optional
      }
    ]
  }
}
```

Constraints: `repos` max 20 entries; entry `.strict()`; `repo` required, `branch`
optional (mirrors flat), rest optional. All string fields pass the secret scrubber
before persistence/Jira (both forms — closes the existing artifacts-unscrubbed gap).

**Normalization** (contracts, single source):
`normalizeReportArtifacts(report) → ReportRepoArtifact[]`
— `repos[]` present → it (flat ignored); else flat non-empty → one-element list
(`repo` undefined); else `[]`. Consumers: Jira ADF composer, dashboard run card,
review-task creation, feature-context.

## 4. Run card contract (`RunCardResponseSchema`, additive)

| Field | Type | Source |
|---|---|---|
| `artifacts` | `{ repo?: string; branch?: string; pr_url?: string; commits_count?: number; files_changed?: number }[]` | Backend `card()` projects `runs.report` through `normalizeReportArtifacts` (commits collapsed to a count for the card). |

Absent/empty → UI renders no Artifacts block (legacy cards unchanged).

## 5. Wrapper input (in-process, `buildWrapperText` options)

```ts
options.repos?: Array<{
  name: string;          // workspace repository name
  absPath: string;       // worktreeRoot/<runId>/<name>
  defaultBranch: string; // base branch (origin/<defaultBranch> is the worktree base)
  branch: string;        // <branchPrefix>/<ticketKey> — same across repos
}>
```

Present ⇒ `## Repositories` section + multi-repo conduct rules (commit/push only where
changed; cross-reference dependent PRs; per-repo artifacts in complete_task; checks
only in touched repos). Absent (no-repo triage runs) ⇒ wrapper byte-identical to today.

## 6. Relationships

```
workspace.settings.repositories[] ──declares──> repo names
agents.behavior.repositories[]    ──subset-of──> workspace repo names (validated)
run ── prepares ──> worktree per resolved repo (same branch)
run.report.artifacts.repos[].repo ──names──> repos the agent actually changed
                                              (⊆ prepared repos; enforced socially via
                                               wrapper, not schema — agent-reported)
```
