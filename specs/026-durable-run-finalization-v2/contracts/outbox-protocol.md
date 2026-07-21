# Contract: Outbox file protocol (writer ↔ readers)

Cross-package on-disk contract between `packages/mcp-server/src/outbox.ts`
(writer, inside the agent's tool server) and `libs/executors/src/claude-cli/outbox.ts`
(readers: exit-time reconcile + periodic reconciler). The writer side is
**unchanged** by this feature; the reader side is widened.

## Location & naming

```
<configRoot>/.brigadir-outbox/<runId>.json
```

- Writer derives the dir from `dirname(BRIGADIR_MARKER_PATH)`; readers
  from `defaultMcpConfigRoot(os.tmpdir())`. These MUST stay in sync (they
  do today; any change is a breaking contract change).
- `OUTBOX_DIR_NAME = '.brigadir-outbox'` duplicated in both modules —
  keep in sync.
- Directory lifetime is decoupled from per-run cleanup: `WrittenMcpConfig.cleanup`
  never touches it; the periodic reconciler owns hygiene (Clarification Q5).

## File body

```jsonc
{
  "runId": "<uuid>",        // must equal filename stem; mismatch ⇒ unresolvable
  "outcome": "success",     // advisory; never used for finalization decisions
  "report": { ... },        // raw complete_task args; ReportSchema.parse is the gate
  "timestamp": "ISO-8601"
}
```

## Writer obligations (existing, restated)

1. Write (mkdir -p + atomic-enough single write) BEFORE the first
   `complete_task` HTTP attempt.
2. Delete on HTTP 2xx.
3. All failures best-effort/swallowed — the outbox must never break the
   live callback path.

## Reader obligations (this feature)

1. `readOutboxReport(configRoot, runId)` — never throws; `null` on
   missing/unparseable/id-mismatch. Report is NOT validated here.
2. NEW `listOutboxEntries(configRoot)` — returns
   `{ runId, filePath, mtime }[]` for `*.json` in the dir; missing dir ⇒
   `[]`; filename stem is the `runId` candidate.
3. Every finalization from a file goes `ReportSchema.parse` →
   `scrubAgentReport` → `finalizeWithReport` (status-guarded). Readers
   NEVER finalize from the `outcome` field or from unvalidated content.
4. `consumeOutbox` (delete, best-effort) is called only per the
   resolution matrix in [data-model.md](../data-model.md); notably NOT for
   `awaiting_human` (skip+keep) and NOT for invalid files (keep until
   7-day retention).
5. Retention: files with `mtime` older than 7 days are deleted with a log
   line, regardless of content.

## Concurrency

Multiple readers (exit-time path, periodic scan) and the live callback may
act on the same run concurrently. Correctness relies solely on
`finalizeWithReport`'s guarded UPDATE + `flipped` return:
- winner: performs checks/human-task writes + `onRunFinished`, consumes.
- loser (`flipped=false`): consumes the file, writes nothing else.
- double `consumeOutbox` is safe (`rm -f` semantics, never throws).
- `undelivered_report` attach is deduped by a pre-insert existence check.
