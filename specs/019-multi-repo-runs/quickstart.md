# Quickstart: validating Multi-Repository Runs

**Feature**: 019-multi-repo-runs. Runnable checks proving the feature end-to-end.
Contracts: [agent-repository-scope.md](contracts/agent-repository-scope.md),
[report-v2-artifacts.md](contracts/report-v2-artifacts.md); shapes:
[data-model.md](data-model.md).

## Prerequisites

- Node 20 + pnpm, Docker running (testcontainers for integration).
- `pnpm install && pnpm --filter @brigadir/contracts build` (workspace deps as usual).

## 1. Static + unit (fast loop)

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected green suites (new/extended): `agents-config.schema.spec`,
`report.schema.spec`, `callback-tools.schema.spec`, `pick-repository.spec`,
`worktree.spec`, `wrapper.spec` (snapshots include the `## Repositories` section),
`claude-cli.executor.spec`, `adf-composer.spec` (regenerated snapshots),
callback service spec (artifact scrubbing + review-task fan-in),
`feature-context.spec`, web `agent-form.spec` (multi-select) and RunCard spec.

## 2. Integration (real Postgres/Redis, fake-claude harness)

```bash
pnpm test:integration -- claude-cli-repository
```

Covers (extended `test/integration/claude-cli-repository.spec.ts`):

| Case | Expectation |
|---|---|
| `behavior.repositories: ['product','infra']` | Both caches cloned (`repoCacheRoot/product`, `/infra`); ticket branch exists in BOTH cache repos after the run; run succeeds; `runs.worktree_path` = `worktreeRoot/<runId>` (parent). |
| Legacy `behavior.repository: 'infra'` | Only infra cloned — byte-compatible with today (US2). |
| No scope fields | ALL workspace repos prepared (new default — D1). |
| Unknown name in list (seeded directly to DB) | Run fails with the clear "no repository named" diagnostics. |
| Fixture `stream-success-multi-repo` | Persisted report carries `artifacts.repos[]`, strings scrubbed. |

## 3. Manual end-to-end sketch (full stack)

1. `docker compose up --build`; workspace with two repositories declared in
   Settings; agent with the repository multi-select set to both (or left empty = all).
2. Move a ticket into the agent's trigger status.
3. During the run: `ls $WORKTREE_ROOT/<runId>/` → `.brigadir/ repoA/ repoB/`; both
   repos on branch `<prefix>/<TICKET-KEY>` (`git -C repoA branch --show-current`).
4. Agent commits in one repo only → after completion:
   - Run card shows ONE artifact line (repo, branch, PR link, counts).
   - Jira comment carries the same artifact line under the checklist.
   - Untouched repo: no PR, no push; its zero-commit branch is deleted+recreated on
     the next run for the same ticket (leftover policy — SC-003).
5. Kill/fail a prepare mid-way (e.g. second repo URL invalid): no
   `worktreeRoot/<runId>` directory remains (SC-006); with `keepFailedWorktrees: true`
   and a failing run, the whole parent dir is retained and `runs.worktree_path`
   points at it.
6. Legacy check: an agent still storing `behavior.repository: "product"` runs
   exactly as before (single repo, flat report accepted, rendering unchanged) —
   without editing the stored row (SC-002).

## 4. Docs gate (same iteration — spec FR-017)

- `docs/architecture.md`: §6 (artifacts.repos + schema_version enum), §7 (behavior
  `repositories` + wrapper Repositories section), §8 (`RunRuntime.prepare` takes
  `repos[]`).
- `docs/progress.md`: new iteration entry.
- No `drizzle/` migrations in the diff (schema §3 untouched).
