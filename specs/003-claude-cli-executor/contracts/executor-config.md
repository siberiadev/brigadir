# Contract — `claude_cli` Executor Configuration

Extends `ExecutorConfigSchema` in `packages/contracts/src/agents-config.schema.ts`.
Today that schema is `type` + common fields + `.passthrough()`. This feature adds
a **typed, boot-validated** branch for `type: "claude_cli"` while leaving `mock`
and the other (still-unimplemented) types unchanged. Validation failures MUST be
path-qualified fatal errors at boot (FR-023) via the existing `libs/app-config`
loader.

## Fields (claude_cli branch)

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `type` | `"claude_cli"` | yes | — | discriminant |
| `concurrency` | int ≥ 1 | no | 2 | existing; drives `run.claude_cli` global concurrency |
| `model` | string | yes | — | `--model` value (alias or full id, e.g. `claude-sonnet-5`) |
| `cliPath` | string | no | `"claude"` | substitutable binary (D8); resolved from PATH at run time |
| `repository` | string | yes | — | MUST match a `workspace.repositories[].name` (cross-checked in `superRefine`) |
| `allowedTools` | string[] | no | derived from `agent.behavior.allowed_tools` | `--allowed-tools` entries; permission-rule syntax |
| `keepFailedWorktrees` | boolean | no | false | retain worktree of failed runs for debugging (FR-005) |
| `worktreeRoot` | string | no | `<tmpdir>/brigadir/worktrees` | per-run worktree parent (D3) |
| `repoCacheRoot` | string | no | `<tmpdir>/brigadir/repos` | cached clone parent (D3) |
| `maxTurns` | int ≥ 1 | no | — | `--max-turns`; also `RunContext.limits.maxTurns` |
| `killGraceMs` | int ≥ 0 | no | 5000 | SIGTERM→SIGKILL grace (D2) |
| `cancelPollMs` | int ≥ 1 | no | 3000 | run-status cancel poll interval (D4) |
| `settleGraceMs` | int ≥ 0 | no | 5000 | feature 034: post-kill window for `close` before the run settles from the parsed outcome (runtime clamp [100, 60000]); a wedged stdio-holding descendant can no longer block settlement — a `run_events` log row (`payload.source: 'settlement-timeout'`) records the fallback |

Budget/timeout live on the **agent**, not the executor (existing
`AgentConfigSchema.max_budget_usd`, `timeout_minutes`) → flow into
`RunContext.limits.maxBudgetUsd` / `timeoutMs` (unchanged).

## Cross-field validation (superRefine, boot-time)

1. `repository` ∈ `{ workspace.repositories[].name }` — else
   `path: ['executors', <name>, 'repository']`, "references unknown repository".
2. `model` present & non-empty for `claude_cli`.
3. If `allowedTools` omitted, the resolved agent's `behavior.allowed_tools` MUST
   be non-empty — else fail with a path-qualified message (no silent
   "all tools" default; Principle V posture).

## Acceptance (US6 / FR-022, FR-023, FR-024)

- Valid `claude_cli` executor + a mock executor in one config → both validate,
  both resolvable by type via `ExecutorRegistry`, mock suite unchanged (SC-002).
- `repository` not in the workspace list → boot fails with the qualified path.
- Missing `model` → boot fails with the qualified path.

## Example (`agents.yaml` excerpt)

```yaml
executors:
  mock:
    type: mock
  coder:
    type: claude_cli
    model: claude-sonnet-5
    repository: product          # must exist in workspace.repositories
    concurrency: 1
    keepFailedWorktrees: true
    # cliPath omitted → "claude" from PATH
agents:
  - name: Implementer
    executor: coder
    instruction: "Implement the ticket."
    status_success: "In Review"
    status_failure: "Blocked"
    max_budget_usd: 5.0
    timeout_minutes: 30
    behavior:
      allowed_tools: ["Read","Edit","Write","Glob","Grep","Bash(git *)","Bash(pnpm *)"]
      required_checks: ["tests_pass","lint_pass"]
```
