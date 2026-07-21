# Quickstart: validating the Readable Run Timeline

How to prove the feature works end-to-end. References `contracts/` and `data-model.md` for shapes; no implementation code here.

## Prerequisites

- Repo bootstrapped: `pnpm install`
- Docker running (for integration tests / full stack via testcontainers)

## 1. Unit — sanitizer & stream parser

```bash
pnpm --filter @brigadir/executors test -- stream-parser tool-input-sanitizer
```

Expect (per `contracts/tool-call-payload.md`):

- A `Write` tool_use with a large `content` → `input.content === "<file content, N KB>"`, `truncated === false`.
- An `Edit` with long `new_string`/`old_string` → both placeholdered.
- A `mcp__brigadir__request_human` with 3 KB `details` → `input.details` stored in full (not cut); `input.title` in full.
- A `mcp__brigadir__complete_task` → `input.summary` full; `input.checks` array intact.
- A generic tool with a 5 KB `query` → capped at 2000, `truncated === true`.
- An assistant text block of 3 KB → persisted as a `progress` event with the **full** message (no 500-char cut).
- Emitting 150 text blocks → at most ~100 `progress` events (sampling cap), remaining dropped.
- `scrub` spy is invoked for each retained human-text and generic string field; NOT for placeholdered file content.

## 2. Unit — contract cap

```bash
pnpm --filter @brigadir/contracts test -- callback-tools.schema
```

Expect: `ReportProgressSchema` accepts a 4000-char `message`, rejects 4001.

## 3. Integration — callback fidelity (testcontainers)

```bash
pnpm test:integration -- callback-progress
```

Expect (extends the existing T111 test):

- `POST /api/callbacks/runs/:id/progress` with a ~4000-char `message` → 200, and the persisted `progress` `run_event` payload contains the message **in full** (scrubbed), not truncated.
- A `request_human` with multi-paragraph `details` → the `human_tasks` row keeps full `details` (existing path, re-asserted).

## 4. Unit — presenter & RunCard

```bash
pnpm --filter @brigadir/web test -- run-timeline-presenter run-card
```

Expect presenter (per `contracts/timeline-view-model.md`):

- `mcp__brigadir__report_progress` → `orchestrator === true`, `iconKey === 'report_progress'`, `title === 'report_progress → Brigadir'`.
- `mcp__brigadir__request_human` (`{kind,title,details,blocking}`) → `title` = the `title`, `tags` include `kind` and `blocking`, `body` = `details`, `bodyFormat === 'markdown'`.
- `mcp__brigadir__complete_task` (`{outcome,summary,checks:[...]}`) → `title === 'Complete · success'`, `body` = `summary`, `bodyFormat === 'markdown'`, a `<n> checks` tag.
- Structured input with no primary text field → `bodyFormat === 'kv'`, `kv` populated (no JSON dump).
- Legacy string `input` cut at 500 → `bodyFormat === 'mono'`, `legacyTruncated === true`.
- `report_progress` tool_call + matching `progress` event → deduped to one item (FR-015).

Expect RunCard (component):

- `bodyFormat: 'markdown'` renders a `MarkdownText` (headings/lists/code), not a `<pre>`.
- `bodyFormat: 'mono'` renders a `<pre>` block.
- `bodyFormat: 'kv'` renders a key/value list (muted key).
- A body over the collapse threshold shows a "show more" control; toggling reveals the full text (already in the DOM); a short body shows no control.
- Orchestrator icons (`Megaphone`/`MessageCircleQuestion`/`FlagTriangleRight`) are static — no `.anim-trigger`/`AnimatedIcon`.

## 5. Static gates

```bash
pnpm typecheck && pnpm lint && pnpm test
```

## 6. Visual smoke (optional, full stack)

```bash
docker compose up --build
```

Trigger a claude-cli run (or replay a fixture) that reports progress, requests a human with Markdown details, writes a large file, and completes. In the dashboard run timeline, confirm:

- No raw JSON blocks; file writes show `<file content, N KB>`.
- Progress/details/summary render as formatted Markdown, in full.
- Orchestrator calls carry the megaphone/question/flag icons and `→ Brigadir` / `Complete · …` titles, distinct from `Bash`/`Edit`.
- A very long message is collapsed with a per-entry expand control.

## Success = every FR observable

Maps to spec Success Criteria: SC-001 (full human text) ← §1/§3; SC-002 (no JSON dumps) ← §4; SC-003 (orchestrator distinguishable) ← §4/§6; SC-004 (bounded machine fields) ← §1; SC-005 (legacy graceful) ← §4; SC-006 (tests in-iteration) ← §1–§4; SC-007 (long-message collapse) ← §4/§6.
