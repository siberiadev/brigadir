# Quickstart — validating Branch Handoff Follow-Up (024)

## Prerequisites

- pnpm install done; repo on the feature branch.
- Static + unit gates run anywhere: `pnpm typecheck && pnpm lint && pnpm test`.
- Integration gates need Docker (`pnpm test:integration`) — **not available in
  the authoring cloud session**; run them on the stand. After deploying to the
  stand, REBUILD `dist/` AND RESTART worker + backend — a running node process
  never picks up a rebuilt bundle.

## US1 — handoff prompts render v2 artifacts

Unit (this session):

```bash
pnpm vitest run libs/pipeline/src/handoff.spec.ts
```

Expected: new v2 cases pass (rework `Continue on:` and triage `Artifacts:`
render one line per `artifacts.repos[]` entry; repos[] beats flat; empty ⇒ no
line) AND every pre-existing v1 assertion passes unmodified.

Stand check: trigger a rework on a ticket whose failing run reported
`artifacts.repos[]`; open the new run's assembled instruction (run detail →
prompt/wrapper artifact) and verify the `Continue on:` block lists each
reported repo with its branch/PR.

## US2 — no system-suggested branch name

Unit (this session):

```bash
pnpm vitest run libs/executors/src/claude-cli/wrapper.spec.ts
```

Expected: the no-prior-branch repo line is `(no prior branch; at <default>)`
with no `— create …` tail; continuation lines byte-identical to 023; stored
`branch_prefix` still round-trips (workspace-settings specs untouched in
behavior).

Stand check: start a first stage on a fresh ticket; the wrapper (`.brigadir/
wrapper.txt` of the run, or kept failed workspace) must contain no proposed
branch name; the agent picks its own (spec-kit convention expected from the
planner).

## US3 — completion gate

Unit (this session):

```bash
pnpm vitest run packages/mcp-server/src/tools.spec.ts \
  libs/callback libs/executors/src/claude-cli
```

Expected: mcp-server attaches `x-brigadir-observed-heads` from
`BRIGADIR_REPO_DIRS` (omits failing repos, silent without env); gate decision
function flags moved+unreported repos only (v1 single-repo attribution, D5);
callback service rejects with the violation list, writes the
`handoff-violation` run_event, leaves the run active; corrected report then
accepted; evidence-absent cases accepted.

Integration (stand, Docker):

```bash
pnpm test:integration
```

Expected: extended callback-completion/lifecycle flow — prepare with recorded
`startSha` → move HEAD in one repo worktree → complete without that repo ⇒
422-style rejection + run still `running` → complete with the entry ⇒ run
finalizes; plus the pre-existing 6 failures noted in the 023 handoff (they
predate this feature — compare against a clean-tree run).

Live check (stand, costs a real run): let a developer stage push and complete
normally — must be accepted with zero rejections (SC-005's read-only/honest
paths unaffected); the run timeline shows `start-ref` events with `startSha`.

## Documentation to verify in the same change

- `docs/progress.md` — new iteration entry.
- `docs/architecture.md` §5 (callback protocol) — observed-heads header +
  gate; §«start-ref» note about `startSha`.
- `docs/spec.md` — `branch_prefix` comment updated (suggestion removed,
  field inert).
