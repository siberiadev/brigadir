# Data Model — Branch Handoff Follow-Up (024)

**No database schema migration.** All persisted deltas are additive keys in
existing `run_events.payload` jsonb; all transport deltas are an env var and an
HTTP header. `ReportSchema` / `packages/contracts` zod schemas are untouched.

## 1. `run_events` — `start-ref` payload (extended, US3)

Written by the executor once per mounted repo, now AFTER `prepareAll`
succeeds (research D5). Existing keys unchanged; one key added.

```jsonc
{
  "source": "start-ref",
  "message": "st3_agentic: continuing branch run/ST3-780, reported by run <id>",
  "repo": "st3_agentic",              // WorktreeRepo.name (workspace repo name)
  "decision": "report_confirmed",     // 'report_confirmed' | 'default_branch'
  "continueBranch": "run/ST3-780",    // string | null
  "reportedByRunId": "<run id>",      // string | null
  "unmatchedReportedRepos": [],       // string[] (unchanged, 023)
  "startSha": "<40-hex>"              // NEW: resolved commit the worktree started at
}
```

- `startSha` = `git rev-parse HEAD` in the freshly created detached worktree
  (identical to resolving the start ref; recorded as the gate's baseline).
- Ordering change: prepare-crash runs write no `start-ref` rows (they fail
  loudly before an agent starts; nothing hands off). Rows now describe
  worktrees that actually exist.
- Consumers: dashboard timeline (renders `message`, unchanged); the completion
  gate (reads `repo` + `startSha` for this run's rows).

## 2. `run_events` — `handoff-violation` payload (new, US3)

Written by `CallbackService` once per rejected completion (one row listing all
violating repos — a rejection is one timeline fact).

```jsonc
{
  "source": "handoff-violation",
  "message": "completion rejected: unreported work in st3_agentic (a1b2c3… → d4e5f6…)",
  "violations": [
    {
      "repo": "st3_agentic",
      "startSha": "<40-hex>",
      "observedHead": "<40-hex>"
    }
  ],
  "outcome": "success"                // the outcome the rejected report claimed
}
```

Type: `log` (same as start-ref; no run_events type enum change).

## 3. Tool-server env block — `BRIGADIR_REPO_DIRS` (new, US3)

Added by the executor to the per-run MCP config file's env block (0600, outside
the worktree, deleted at cleanup — Constitution V delivery path). Optional:
absent for no-repo runs and pre-024 configs.

```jsonc
// value is a JSON string:
{ "st3_agentic": "/abs/worktreeRoot/<runId>/st3_agentic", "infra": "/abs/…/infra" }
```

Keys are workspace repo names exactly as recorded in start-ref events; values
are absolute worktree dirs. Parsed leniently by the MCP server (malformed ⇒
treated as absent, logged to stderr).

## 4. HTTP header — `x-brigadir-observed-heads` (new, US3)

Attached by the MCP server to the `POST /runs/:id/complete` request only.
Body contract (`ReportSchema.strict()`) unchanged.

```text
x-brigadir-observed-heads: {"st3_agentic":"d4e5f6…","infra":"9f8e7d…"}
```

- Value: JSON object, repo name → 40-hex SHA; repos whose `rev-parse` failed
  are omitted.
- Backend parsing: zod `record(string, /^[0-9a-f]{40}$/)`, size-bounded
  (≤20 entries — mirrors `repos[].max(20)`); invalid or absent ⇒ gate silent
  (evidence-absent).
- Trust: authored by the tool server process (agent's tool input cannot set
  it); rides the same Bearer run-token auth as the body.

## 5. Gate decision (pure function, `libs/callback`)

```text
Inputs:
  startRefs:    Map<repo, startSha>      // from this run's start-ref events
  observed:     Map<repo, sha> | null    // from header; null = evidence absent
  artifacts:    NormalizedRepoArtifact[] // normalizeReportArtifacts(report)
  mountedCount: number                   // startRefs.size (v1 attribution)

Rule (per repo in startRefs):
  moved      = observed?.has(repo) && observed.get(repo) !== startRefs.get(repo)
  reported   = artifacts.some(a => a.repo === repo)
               || (mountedCount === 1 && artifacts.length > 0 && artifacts[0].repo === undefined)
  violation  = moved && !reported

Output: violations[] (repo, startSha, observedHead) — empty ⇒ completion
proceeds unchanged.
```

State transitions: none added. A rejected completion leaves the run exactly as
it was (`running`); accepted completions finalize precisely as today.

## 6. Removed (US2)

- `WrapperRepoInfo.suggestedBranch` (wrapper.ts) — field and rendering.
- `branchPrefix` resolution (`behavior.branch_prefix ?? 'run'`) in
  `loadRunConfig` and the `suggestedBranch` computation in the executor.
- `setupRunBranchIdentity` (worktree.ts) and its call site.

Persisted `branch_prefix` values (workspace settings jsonb, `agents.behavior`
jsonb, API responses, agents-yaml) remain valid and stored — inert (FR-007).
