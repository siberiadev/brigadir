# Data Model: Readable Run Timeline

No relational schema change. `run_events` is unchanged (`id`, `run_id`, `type`, `payload jsonb`, `created_at`). This document specifies the **value shapes inside `payload`** for `tool_call` events (new + legacy) and the **presenter view-model** the client derives from them.

## 1. Persisted `run_events.payload` shapes

### 1.1 `tool_call` — new (this feature)

```jsonc
{
  "name": "mcp__brigadir__request_human",   // tool name, unchanged source (assistant tool_use block)
  "input": {                                 // STRUCTURED object — never a stringified blob
    "kind": "question",
    "title": "Clarify empty-input behavior",       // human-text field: full, scrubbed
    "details": "## Context\n- ...",                 // human-text field: full, scrubbed, Markdown
    "blocking": true
  },
  "truncated": false                         // true iff a generic string field was cut at MAX_FIELD_CHARS
}
```

Field sanitization applied to **top-level string values** of `input` (see research R3):

| Class | Keys | Stored value |
|-------|------|--------------|
| Human text | `message`, `title`, `details`, `summary` | full text, `scrub()`-ed, never truncated |
| File content | `content`, `new_string`, `old_string` | `"<file content, N KB>"` (N ≈ round(len/1024)) |
| Generic | all other strings (`command`, `query`, `file_path`, …) | `scrub()`-ed, capped at `MAX_FIELD_CHARS` (2000); cut ⇒ `truncated=true` |

Non-string top-level values pass through. Nested arrays/objects (e.g. `complete_task.checks`, `artifacts`) pass through unchanged (bounded, schema-validated; presenter reads shape only).

`truncated` semantics: `true` only for a genuine mid-value cut of a generic field. File-content placeholder does **not** set it (self-describing).

Example — `complete_task` (input is the structured report):

```jsonc
{
  "name": "mcp__brigadir__complete_task",
  "input": {
    "schema_version": 1,
    "outcome": "success",
    "summary": "Implemented X and opened a PR.\n\n- added tests\n- updated docs",  // full, Markdown
    "checks": [ { "name": "tests_pass", "status": "pass" }, { "name": "lint_pass", "status": "pass" } ]
  },
  "truncated": false
}
```

Example — `Write` (file body elided):

```jsonc
{ "name": "Write", "input": { "file_path": "/a/b.ts", "content": "<file content, 34 KB>" }, "truncated": false }
```

### 1.2 `tool_call` — legacy (pre-feature, read-only)

```jsonc
{ "name": "Write", "input": "{\"file_path\":\"/a/b.ts\",\"content\":\"xxxx…(cut at 500)" }
```

`input` is a **string** (`JSON.stringify` output, possibly cut at 500 chars). Discriminator: `typeof payload.input === 'string'` ⇒ legacy. No repair attempted.

### 1.3 `progress` — unchanged shape, raised fidelity

```jsonc
{ "stage": "implement", "message": "…full message up to 4000 chars, scrubbed…", "percent": 40 }
```

Written by `CallbackService.progress()` (message now bounded at 4000 by contract) and by the parser's `sampleProgress` (assistant text, no longer truncated). Sampling caps **row count** (~100/run), not message length.

### 1.4 Other event types — unchanged

`log`, `jira_action`, `api_retry`, `error` payloads are untouched by this feature.

## 2. Contract change — `ReportProgressSchema`

`packages/contracts/src/callback-tools.schema.ts`:

```diff
- message: z.string().max(500),
+ message: z.string().max(4000),
```

Validation rule: `message` length 0–4000 accepted; >4000 → 422 (unchanged failure path). Aligns with `RequestHumanSchema.details.max(4000)`.

## 3. Presenter view-model — `TimelineItem`

Produced by the pure presenter (`presenter.ts`), consumed by `RunCard.vue`. Existing fields kept; new fields added:

```ts
interface TimelineItem {
  // existing
  id: string;
  time: string;            // 'HH:MM:SS'
  timeTitle: string;       // full local datetime (tooltip)
  typeKey: TimelineTypeKey;// drives accent color (unchanged set)
  title: string;           // e.g. 'report_progress → Brigadir', 'Complete · success', 'Bash'
  percent: number | null;

  // new
  orchestrator: boolean;   // true for mcp__brigadir__* callbacks
  iconKey: IconKey;        // icon lookup incl. megaphone/question/flag
  tags: TimelineTag[];     // e.g. [{label:'question'},{label:'blocking',tone:'warning'}], [{label:'2 checks'}]
  body: string | null;     // primary text (message/details/summary/command/raw) or null
  bodyFormat: 'markdown' | 'mono' | 'kv' | null;   // how RunCard renders body
  kv: { key: string; value: string }[] | null;     // when bodyFormat==='kv'
  legacyTruncated: boolean; // legacy string input cut by the old executor → show note
  fieldTruncated: boolean;  // payload.truncated → show 'input truncated' note
}

interface TimelineTag { label: string; tone?: 'info' | 'success' | 'warning'; }
type IconKey = TimelineTypeKey | 'report_progress' | 'request_human' | 'complete_task';
```

### 3.1 Title rules

| Event | Title |
|-------|-------|
| `report_progress` (brigadir) | `report_progress → Brigadir` (arrow form) |
| `request_human` (brigadir) | `request_human → Brigadir` |
| `complete_task` (brigadir) | `Complete · <outcome>` |
| other MCP tool | `<tool> (<server>)` (existing `prettifyToolName`) |
| plain tool | `<tool>` |
| progress event | capitalized `stage` or `Progress` (existing) |

### 3.2 Body-format selection

| Source | `bodyFormat` | `body` / `kv` |
|--------|--------------|---------------|
| progress message, request `details`, complete `summary` | `markdown` | the text |
| `command` / legacy raw string / non-text raw payload | `mono` | the text |
| structured `input` with no primary text field | `kv` | `kv` = each `{key, value}` (value stringified compactly) |
| no displayable content | `null` | `body: null` (row only, no block) |

### 3.3 Tags

- `request_human`: `kind` (tone `info`) + `blocking`/`non-blocking` (blocking → tone `warning`).
- `complete_task`: `<n> checks` (tone `info`) from `checks.length`.
- others: none (empty array).

### 3.4 Icon map (in `RunCard.vue` / `RunTimeline.vue`)

```
report_progress → Megaphone
request_human   → MessageCircleQuestion
complete_task   → FlagTriangleRight
tool_call       → Wrench          (ordinary tools)
progress → Activity · log → Info · jira_action → Ticket · api_retry → RotateCcw · error → TriangleAlert · unknown → CircleDot
```

All static (no `AnimatedIcon`, no `.anim-trigger`), per project convention.

## 4. Collapse state (not in the view-model)

Per-entry expand/collapse (FR-024) is **local state in `RunCard.vue`**, not a `TimelineItem` field: a boolean `expanded` ref + a threshold (start: clamp bodies taller than ~12 lines / longer than ~800 chars). The full body is always rendered; the toggle flips a CSS `max-height` clamp. Below-threshold bodies render with no control.

## 5. Constants

| Constant | Value (initial) | Location | Note |
|----------|-----------------|----------|------|
| `MAX_FIELD_CHARS` | 2000 | `tool-input-sanitizer.ts` | generic string field cap |
| `HUMAN_TEXT_FIELDS` | `{message,title,details,summary}` | `tool-input-sanitizer.ts` | never truncated |
| `FILE_CONTENT_FIELDS` | `{content,new_string,old_string}` | `tool-input-sanitizer.ts` | → size placeholder |
| `maxProgressEvents` | 100 (was 20) | `stream-parser.ts` | sampling row cap |
| `report_progress.message` max | 4000 (was 500) | `callback-tools.schema.ts` | contract |
| collapse threshold | ~12 lines / ~800 chars | `RunCard.vue` | display only, tunable |

All tunable per spec Assumptions without behavior change.
