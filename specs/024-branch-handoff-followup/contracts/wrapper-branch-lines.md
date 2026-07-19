# Contract — Wrapper repository branch lines (US2)

Amends the `## Repositories` section contract of feature 019 (spec FR-013),
as revised by 023. Applies to `buildWrapperText` /
`repositoriesSection` in `libs/executors/src/claude-cli/wrapper.ts`.

## Per-repo lines

```text
# continuation (unchanged from 023, byte-identical):
- <name>: <absPath> (continue branch <branch>, based on <defaultBranch>)

# no prior branch (changed — the "— create <suggested>" tail is GONE):
- <name>: <absPath> (no prior branch; at <defaultBranch>)
```

`WrapperRepoInfo.suggestedBranch` no longer exists. No system-proposed branch
name may appear anywhere in the wrapper, for any run kind (ticket runs and
workspace-setup runs alike).

## Rules block

The branching rule is reworded to stand without a suggested name. Required
semantics (exact wording chosen at implementation):

- Never commit on the detached HEAD.
- A repo with a `continue branch`: build on it; never start a competing
  branch.
- A repo without one: create a branch of your own choosing
  (`git switch -C <your-branch>`) before the first commit, push it, and
  report it — the name is the agent's to pick.
- The existing reporting rule stays: exactly one `artifacts.repos` entry per
  CHANGED repository, `schema_version: 2`; the next stage starts from what is
  reported, and (new, US3) a completion that omits a repository with local
  commits will be rejected.

## Inert field guarantee (FR-007)

`branch_prefix` remains accepted and persisted everywhere it exists today
(workspace settings PUT/response, `agents.behavior`, agents-yaml fixtures) and
influences nothing. No migration, no API shape change.
