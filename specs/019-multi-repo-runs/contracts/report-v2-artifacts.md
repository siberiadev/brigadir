# Contract: ReportSchema v2 — per-repository artifacts

**Feature**: 019-multi-repo-runs. Normative mirror for the `docs/architecture.md` §6
update; the zod source of truth is `packages/contracts/src/report.schema.ts`.

## Schema changes (additive, forward-compatible)

```jsonc
// schema_version: { "enum": [1, 2] }   (was { "const": 1 })
"artifacts": {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "branch":        { "type": "string" },              // legacy flat — kept
    "pr_url":        { "type": "string" },              // legacy flat — kept
    "commits":       { "type": "array", "items": { "type": "string" } },
    "files_changed": { "type": "integer" },
    "repos": {                                          // NEW — authoritative when present
      "type": "array", "maxItems": 20,
      "items": {
        "type": "object",
        "required": ["repo"],
        "additionalProperties": false,
        "properties": {
          "repo":          { "type": "string", "maxLength": 200 },
          "branch":        { "type": "string", "maxLength": 300 },
          "pr_url":        { "type": "string", "maxLength": 1000 },
          "commits":       { "type": "array", "items": { "type": "string", "maxLength": 500 }, "maxItems": 100 },
          "files_changed": { "type": "integer", "minimum": 0 }
        }
      }
    }
  }
}
```

Rules:

- **No version⇄field coupling**: v1+flat, v1+repos, v2+flat, v2+repos, and
  artifact-less reports all validate. v2 is what new wrappers advertise; v1 producers
  keep working forever (no migration machinery exists or is added).
- **Precedence**: `repos[]` present ⇒ authoritative; flat fields are then ignored by
  every consumer (never double-rendered). Implemented once in
  `normalizeReportArtifacts(report): ReportRepoArtifact[]` (exported from contracts).
- `repos[].repo` SHOULD name a prepared workspace repository; not schema-enforced
  (agent-reported data — consumers render it verbatim after scrubbing).
- `CompleteTaskSchema = ReportSchema` — the MCP `complete_task` tool and the HTTP
  callback accept v2 automatically; the 422 repair-loop behavior is unchanged.

## Consumer obligations (all via `normalizeReportArtifacts`)

| Consumer | Obligation |
|---|---|
| `scrubReport` (libs/callback) | Scrub `branch`, `pr_url`, `commits[]` of BOTH forms + `repos[].repo` before persistence/Jira (closes the existing artifacts-unscrubbed gap). |
| `maybeQueueReviewTask` (libs/callback) | 1 PR → title `Review PR: <url>` (unchanged); N>1 PRs → one task `Review PRs (<n>)`, details = Markdown list `<repo>: <url>`. Gate stays `code_delivery === 'pull_request'` + at least one `pr_url`. |
| `buildRunComment` (libs/jira ADF) | Net-new artifact lines after the checks taskList: one per entry — `<repo>: <branch> — <pr_url> (<n> commits, <m> files)`, absent fields omitted; flat/legacy entry renders without repo prefix. |
| Dashboard `card()` + `RunCardResponseSchema` + `RunCard.vue` | Card gains normalized `artifacts[]` (commits as count); UI shows an Artifacts block only when non-empty. |
| `latestArtifacts` (feature-context) | Per-repo `branch:` / `PR:` lines from the normalized list. |
| `pipeline.service` rework recast | Continues to spread `report.artifacts` opaquely — no change. |

## Wrapper guidance (§7)

Repo-carrying runs are instructed to report `schema_version: 2` with one
`artifacts.repos` entry per repository they actually changed (commit(s) beyond base),
and none for untouched repositories.
