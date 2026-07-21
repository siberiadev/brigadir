# Contract: timeline presenter view-model

Producer: `presentEvents(events)` / `presentEvent(event)` in `apps/web/src/components/RunTimeline/presenter.ts` (pure).
Consumer: `RunCard.vue`.

## Output type

```ts
interface TimelineItem {
  id: string;
  time: string;            // 'HH:MM:SS'
  timeTitle: string;       // full local datetime
  typeKey: TimelineTypeKey;// accent color; existing set: log|progress|tool_call|jira_action|api_retry|error|unknown
  title: string;
  percent: number | null;
  orchestrator: boolean;
  iconKey: TimelineTypeKey | 'report_progress' | 'request_human' | 'complete_task';
  tags: { label: string; tone?: 'info' | 'success' | 'warning' }[];
  body: string | null;
  bodyFormat: 'markdown' | 'mono' | 'kv' | null;
  kv: { key: string; value: string }[] | null;
  legacyTruncated: boolean;
  fieldTruncated: boolean;
}
```

## Invariants

1. **Purity**: no Vue/DOM imports; deterministic; never throws on any `payload` (object, string, number, null).
2. **Dedup preserved**: `presentEvents` still drops a `report_progress` `tool_call` immediately followed by a `progress` event carrying the same message (FR-015). The comparison reads the structured `input.message` (new shape) and the legacy string form.
3. **Orchestrator detection**: `orchestrator === true` iff `name` matches `^mcp__brigadir__(report_progress|request_human|complete_task)$`.
4. **Titles**: per data-model §3.1 — arrow form `"<action> → Brigadir"` for report_progress/request_human; `"Complete · <outcome>"` for complete_task; existing `prettifyToolName` for other MCP/plain tools.
5. **Body-format**: per data-model §3.2 — human-text → `markdown`; command/raw/legacy → `mono`; structured-without-primary-text → `kv`; nothing → `null`.
6. **Tags**: per data-model §3.3.
7. **Legacy**: `legacyTruncated === true` iff the payload used the legacy string `input` and `input.length >= 500`. No JSON repair.
8. **fieldTruncated**: mirrors new-shape `payload.truncated`.
9. `bodyFormat === 'kv'` ⟺ `kv !== null`; otherwise `kv === null`.

## Notes for the consumer (`RunCard.vue`)

- `bodyFormat: 'markdown'` → render via `MarkdownText.vue`.
- `bodyFormat: 'mono'` → render in a `<pre>` block (existing style).
- `bodyFormat: 'kv'` → render a compact list: muted `key`, regular `value`.
- `legacyTruncated` / `fieldTruncated` → render a small muted "input truncated by the executor" note beneath the body.
- Per-entry expand/collapse for long bodies is component-local (not in this view-model) — see data-model §4.
- Icons resolved from `iconKey`; all static.
