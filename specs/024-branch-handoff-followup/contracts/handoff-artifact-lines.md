# Contract — Handoff artifact lines (US1)

Extends the handoff-section contract of feature 010 (best-effort, size-bounded,
ephemeral). Applies to the sections built by `libs/pipeline/src/handoff.ts`.

## Source of data

The failing run's stored report, passed through
`normalizeReportArtifacts(report)` from `@brigadir/contracts` — the single
flat-vs-plural precedence implementation. No handoff code may read
`artifacts.branch` / `artifacts.pr_url` / `artifacts.repos` directly.

## Rendering

For a normalized list `entries` (empty ⇒ render nothing, no header line):

- **rework** (`buildReworkSection`): a `Continue on:` block, one line per
  entry.
- **triage / answer-triage** (`failureLines`): an `Artifacts:` block, one line
  per entry.

Per-entry line, parts joined with `, `; a part is omitted when its field is
absent; an entry with neither `branch` nor `pr_url` renders no line:

```text
# v2 entry (repo present):
- <repo>: branch <branch>, PR <pr_url>
# v1 normalized entry (repo undefined) — exactly one entry possible:
branch <branch>, PR <pr_url>
```

The v1 single-entry form MUST render byte-identically to the pre-024 output
(`Artifacts: branch X, PR Y` / `Continue on: branch X, PR Y` as a single
line) — existing `handoff.spec.ts` assertions stay green unmodified.

For multi-entry (v2) output the block is:

```text
Continue on:            |  Artifacts:
- repoA: branch X, PR Y |  - repoA: branch X, PR Y
- repoB: branch Z       |  - repoB: branch Z
```

## Guarantees preserved

- Best-effort: a missing failing run / report / artifacts degrades to no
  block; the builder never throws (FR-013 of 010).
- Size-bounded: fields are schema-capped (branch ≤300, pr_url ≤1000, repos
  ≤20); no additional truncation introduced.
- When both flat fields and `repos[]` are present, only `repos[]` renders
  (never double-rendered) — this follows from the normalizer, not from local
  logic.
