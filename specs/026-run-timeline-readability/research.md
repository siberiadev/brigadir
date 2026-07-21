# Research: Readable Run Timeline

Phase 0 decisions. Each resolves a design unknown the spec left open, grounded in the current code (`stream-parser.ts`, `claude-cli.executor.ts`, `callback.service.ts`, `presenter.ts`, `RunTimeline.vue`, `MarkdownText.vue`, `utils/markdown.ts`).

## R1 — Where the tool_call payload shape is decided

**Decision**: Change the payload shape in `ClaudeStreamParser.mapAssistant` (the only producer of `tool_call` run_events on the claude-cli path). The executor persists parser output verbatim: `claude-cli.executor.ts` does `persistRunEvent(parsed.event.type, parsed.event.payload)` with no reshaping. The `MockExecutor` already emits objects for its events, and it produces no `tool_call` rows, so it needs no change.

**Rationale**: Single write site; the entire fidelity fix is contained in the parser + a helper it calls. No new migration, no fan-out across writers.

**Alternatives considered**: (a) Reshape at read time in the API/presenter only — rejected: the data is already lost (JSON cut mid-string at 500 chars) before it reaches the client; fidelity must be fixed at write time. (b) A new run_events column — rejected: violates "no schema change" and is unnecessary since `payload` is `jsonb`.

## R2 — How request_human / complete_task reach the timeline

**Decision**: Their **typed cards are built from the parser's `tool_call` event** (`name: mcp__brigadir__request_human | complete_task`, structured `input`), not from a dedicated timeline event. Confirmed: `CallbackService.human()` writes to `human_tasks` (not `run_events`); `complete()` finalizes the run (not `run_events`). Only `progress()` writes a `run_events` row (`type:'progress'`), which is why only `report_progress` has the tool_call/progress dedup.

**Rationale**: This is the reason structured tool_call input is the linchpin — without it there is no faithful source for the request_human/complete_task cards. It also means those two cards depend on the agent actually emitting the tool_use block on stdout (it does, on the claude-cli path).

**Consequence**: The card fields (`title`, `details`, `kind`, `blocking`; `outcome`, `summary`, `checks`) must survive sanitization — see R3 (human-text fields never truncated; nested `checks` array passed through so its count is available).

## R3 — Per-field sanitization policy (structured input + truncated flag)

**Decision**: A pure helper `sanitizeToolInput(name, rawInput, scrub)` in `libs/executors/src/claude-cli/tool-input-sanitizer.ts` returns `{ input: Record<string, unknown>, truncated: boolean }`. Policy, applied to **every string field by key, at any depth**:

| Field class | Keys | Treatment |
|-------------|------|-----------|
| Human-authored text | `message`, `title`, `details`, `summary` | Never truncated; `scrub()` applied |
| File content | `content`, `new_string`, `old_string` | Replaced with `"<file content, N KB>"` placeholder (N ≈ `round(len/1024)`); no `scrub` (content is discarded) |
| Other strings | everything else (incl. `command`, `query`, `file_path`) | `scrub()` then cap at `MAX_FIELD_CHARS` (2000); if the pre-cap length exceeded the cap, set `truncated = true` |

Non-string leaf values (numbers, booleans, null) pass through. **Nested arrays/objects are recursed into** (e.g. `complete_task`'s `checks[].reason`, `artifacts.branch`/`pr_url`/`commits[]`), applying the same by-key policy so every retained nested string is scrubbed. This closes the Constitution V gap: the tool_call event is a real DB sink, and a `complete_task` input carries the full report — its nested agent free-text must not reach `run_events` unscrubbed. The presenter still reads only shape from these arrays (e.g. `checks.length`), never dumps them. The walk is depth/cycle-guarded; nested payloads are schema-bounded in practice.

`truncated` is set **only** for a genuine mid-value cut of a generic field. A file-content placeholder does **not** set it: the placeholder is self-describing (states its size), so no "input truncated" note is warranted.

**Rationale**: Field-name policy is the pragmatic way to protect human text and bound machine noise without the parser having to know each tool's full schema. The four human-text keys are exactly the brigadir callbacks' human fields; the three file-content keys cover Write (`content`) and Edit (`old_string`/`new_string`).

**Alternatives considered**: (a) Sanitize only top-level strings and let nested arrays/objects pass through unchanged — REJECTED after cross-artifact analysis (finding C1): nested `complete_task` report strings would reach `run_events` unscrubbed, conflicting with Constitution V; recursion by-key is cheap and closes the gap. (b) Tool-schema-aware sanitizer (import each tool's zod schema) — rejected: couples the executor to every tool definition and to future tools; the field-name heuristic is good enough for an internal tool and fails safe (unknown fields get the generic 2000 cap). (c) Keep stringifying but cap higher — rejected: still yields unparseable mid-JSON cuts (the core defect) and cannot decompose for typed cards.

**Constants** (tunable, per spec Assumptions): `MAX_FIELD_CHARS = 2000`, `FILE_CONTENT_FIELDS = {content, new_string, old_string}`, `HUMAN_TEXT_FIELDS = {message, title, details, summary}`.

## R4 — Assistant text & progress sampling

**Decision**: In `sampleProgress`, stop truncating the text (persist the full `text`), and raise the default sampling cap `maxProgressEvents` 20 → 100. Keep the count cap + optional min-interval as flood protection. The now-unused `snippetMaxChars` is removed from the progress path; its role for tool inputs is superseded by the sanitizer's `MAX_FIELD_CHARS`.

**Rationale**: FR-003 (human/assistant text never truncated) + FR-007 (sampling stays, cap raised). Sampling is retained precisely because an agent can emit hundreds of text blocks — the cap bounds row count, not the length of the rows kept.

**Alternatives considered**: Removing sampling entirely — rejected: unbounded row growth per run; the spec explicitly keeps sampling as flood protection.

## R5 — Callback contract cap

**Decision**: `ReportProgressSchema.message` `.max(500)` → `.max(4000)`, aligning with the existing `RequestHumanSchema.details.max(4000)`. Update `callback-tools.schema.spec.ts` accordingly. `CallbackService.progress()` already persists the full validated `message` (scrubbed) into the `progress` run_event — no service change needed beyond the raised bound.

**Rationale**: FR-004. 4000 matches the established human-text bound already used for `details`.

**Asymmetry (finding I1, intentional)**: the two progress sources have different ceilings — the callback path rejects a `report_progress` message over 4000 chars (contract validation, 422), while assistant-text progress captured by the parser (R4) is unbounded. Both honor FR-003 (never *truncate*): the callback path *rejects* rather than silently cutting, so no partial message is ever stored. The asymmetry is a consequence of one path being a validated contract and the other a passive capture; it is acceptable and now documented in FR-003/FR-004.

**Note**: The schema also feeds the MCP tool definition (`packages/mcp-server`); raising the zod max propagates to the tool's advertised input bound automatically. No mcp-server code change required, but its tests (if any assert 500) are checked in tasks.

## R6 — Scrubbing the newly-persisted text (Constitution V)

**Decision**: Inject the real `@brigadir/scrubber` `scrub` into `sanitizeToolInput` at the executor boundary (`claude-cli.executor.ts`), applied to every retained string field (human-text and generic) **at any depth** — the sanitizer recurses into nested objects/arrays so a `complete_task` report's nested strings (`checks[].reason`, `artifacts.*`) are scrubbed too, not just top-level fields (see R3; closes finding C1). The sanitizer stays pure/testable by taking `scrub` as a parameter (tests pass an identity or a spy).

**Rationale**: We now persist materially more agent-authored text into `run_events`. Constitution V requires outgoing text hit the scrubber before DB write; the callback path already scrubs `message`/`title`/`details`/`summary`, so the parser path should match rather than become a new unscrubbed sink. Cost is negligible (the sanitizer already visits each string).

**Alternatives considered**: Leave parser-side tool_call events unscrubbed as today (pre-existing behavior) — rejected: raising fidelity without scrubbing would widen the exact exposure Principle V guards; doing it in the sanitizer is a one-line-per-field addition.

## R7 — Presenter typing & body-format selection

**Decision**: Extend the pure presenter to detect `mcp__brigadir__(report_progress|request_human|complete_task)` and emit an enriched `TimelineItem` carrying: `orchestrator: boolean`, `iconKey` (for icon lookup incl. the three orchestrator icons), `tags[]`, `body`, `bodyFormat: 'markdown' | 'mono' | 'kv' | null`, `kv[]` (when `bodyFormat==='kv'`), `legacyTruncated`, `fieldTruncated`. Card rules:

- **request_human**: title = input `title`; tags = `kind` and `blocking ? 'blocking' : 'non-blocking'`; body = `details`, `bodyFormat: 'markdown'`.
- **complete_task**: title = `Complete · <outcome>`; body = `summary`, `bodyFormat: 'markdown'`; tag = `<n> checks` from `checks.length`.
- **report_progress**: unchanged rendering; dedup with its `progress` event preserved (the progress card renders the message as `bodyFormat: 'markdown'`).
- **ordinary tool** with a message-like primary field (message/summary/details) → `markdown`; with `command`/raw → `mono`; structured object with no primary text field → `kv` (compact key/value list); legacy/raw string → `mono` + `legacyTruncated` note.

**Rationale**: Keeping the presenter pure (returns a view-model, no Vue) preserves the existing unit-test seam (`run-timeline-presenter.spec.ts`) and pushes all DOM/format concerns to `RunCard.vue`. `bodyFormat` lets the component pick `MarkdownText.vue` vs `<pre>` vs a kv list without re-deriving payload logic.

**Alternatives considered**: Rendering decisions inside the component reading raw payload — rejected: duplicates payload knowledge and breaks the pure-presenter test seam.

## R8 — Icons & orchestrator affordance

**Decision**: Add to the `RunTimeline`/`RunCard` icon map: `report_progress → Megaphone`, `request_human → MessageCircleQuestion`, `complete_task → FlagTriangleRight` (all `lucide-vue-next`, all static). Title form `"<action> → Brigadir"` for orchestrator calls (replaces `prettifyToolName`'s `"<action> (brigadir)"` for the `brigadir` server only; other MCP servers keep the `(server)` form). Ordinary tools keep the `Wrench` icon and plain/`(server)` name.

**Rationale**: FR-013/FR-014/FR-017. Static icons honor the project convention (hover animation is sidebar-only, per CLAUDE.md and decision 2026-07-15/07-16). `AnimatedIcon` is deliberately **not** used here.

**Verification**: `Megaphone`, `MessageCircleQuestion`, `FlagTriangleRight` all exist in `lucide-vue-next` (current pinned version). Confirm at implementation against the installed version; substitute the nearest lucide glyph if a name moved.

## R9 — Markdown renderer reuse

**Decision**: Reuse `MarkdownText.vue` (which wraps `renderMarkdown` from `utils/markdown.ts`) for all Markdown bodies. `renderMarkdown` escapes-first and emits a curated safe tag subset (headings, lists, fenced code, blockquote, inline code/bold/italic/strike/links) — safe for `v-html`, no new dependency.

**Rationale**: FR-010. The renderer already exists for human-task `details`; the progress message, request details, and completion summary are the same class of agent-authored Markdown. Reuse keeps one sanitization path.

**Alternatives considered**: Adding `markdown-it` + DOMPurify — rejected: the repo deliberately avoids the dependency; the existing renderer covers the needed subset.

## R10 — Per-entry collapse for long bodies (FR-024)

**Decision**: The collapse is **component-local state in `RunCard.vue`**, not presenter output. A body whose rendered height/length exceeds a threshold is clamped (CSS `max-height` on the body wrapper) with a "show more"/"show less" toggle; below-threshold bodies render fully with no control. Threshold is a tuning constant (start: clamp bodies taller than ~12 lines / longer than ~800 chars). The full text is always in the DOM — the toggle only flips the clamp, so nothing is truncated and fidelity is preserved.

**Rationale**: FR-024 + the 2026-07-15 refinement. Keeping it component-local avoids threading display state through the pure presenter and keeps every event a visible entry (only the body is clamped, never the entry hidden). One control per entry falls out naturally (one `ref` per `RunCard` instance).

**Alternatives considered**: (a) Presenter decides collapsibility by string length — rejected: rendered Markdown height ≠ source length; the component is where layout is known. (b) Global expand/collapse — rejected: the spec keeps entries individually visible and asks for one control per log.

## R11 — Legacy events

**Decision**: The presenter distinguishes new vs legacy by `typeof payload.input`: an **object** → new structured path; a **string** → legacy path (render the stored string in a `mono` block, set `legacyTruncated` when `input.length >= 500` so `RunCard` shows a small "input truncated by the executor" note). Never attempt to `JSON.parse`-repair a cut string.

**Rationale**: FR-016. The old shape is a (possibly cut) `JSON.stringify` string; the new shape is an object. `typeof` is an unambiguous discriminator. The existing `parseToolInput` already re-parses short legacy strings that happen to be valid JSON — that behavior is kept for clean short legacy rows; only cut rows get the note.

## Resolved unknowns

- Sanitizer location/shape → R1, R3 (pure helper, field-name policy).
- Which fields are "human-authored" → R3 (`message`/`title`/`details`/`summary`).
- File-content detection → R3 (`content`/`new_string`/`old_string` → size placeholder).
- Truncated-flag semantics → R3 (generic mid-cut only; placeholder excluded).
- Scrubbing posture for the new text → R6 (scrub injected, applied to retained strings).
- Card typing & body-format contract → R7.
- Icons/titles → R8. Markdown reuse → R9. Collapse ownership → R10. Legacy discriminator → R11.

No open `NEEDS CLARIFICATION` remain. Tuning constants (`MAX_FIELD_CHARS`, sampling cap, collapse threshold) are explicitly adjustable per the spec's Assumptions without changing behavior.
