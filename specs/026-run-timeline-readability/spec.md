# Feature Specification: Readable Run Timeline

**Feature Branch**: `claude/new-session-ultlns`

**Created**: 2026-07-21

**Status**: Draft

**Input**: User description: "Improve the run timeline so an operator can read everything an agent said, without raw JSON dumps, and can see at a glance when an agent is speaking to the orchestrator (Brigadir) versus using ordinary tools."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Read the full agent narrative (Priority: P1)

An operator opens a run's timeline to understand what the agent did and why. Every message the agent authored — progress updates, questions to a human, the final completion summary — is shown in full, formatted for reading (headings, lists, code blocks), with nothing cut off mid-sentence and no raw JSON blobs.

**Why this priority**: The timeline is the operator's primary window into an autonomous run. If the agent's own words are truncated or buried in unreadable payloads, the operator cannot judge whether the run went well, diagnose a failure, or answer a human task with confidence. This is the core value of the feature.

**Independent Test**: Trigger a run whose agent emits a long progress message, a human request with multi-paragraph Markdown details, and a completion summary. Open the timeline and confirm each human-authored text appears complete and rendered as formatted text, not truncated and not shown as JSON.

**Acceptance Scenarios**:

1. **Given** an agent emits a progress message longer than 500 characters, **When** the operator views the timeline, **Then** the entire message is shown, formatted as Markdown, with no truncation marker.
2. **Given** an agent asks a human a question with a title and multi-paragraph details, **When** the operator views the timeline, **Then** the details render as formatted Markdown (headings/lists/code preserved) in full.
3. **Given** an agent completes a task with a Markdown summary, **When** the operator views the timeline, **Then** the summary renders in full as formatted text.
4. **Given** a tool call whose input contains a very large file body (e.g. a file write), **When** the operator views the timeline, **Then** the file content is replaced by a short placeholder indicating its size, and no multi-kilobyte blob is shown.
5. **Given** a progress message or completion summary that is very long, **When** the operator views the timeline, **Then** its body is collapsed to a preview with a per-entry expand control, and expanding reveals the complete text in place with nothing truncated.

---

### User Story 2 - Distinguish orchestrator calls from ordinary tools (Priority: P1)

An operator scanning the timeline can tell at a glance when the agent is speaking to the orchestrator (Brigadir) — reporting progress, asking for a human, or completing the task — versus running an ordinary tool such as a shell command or file edit. Orchestrator calls carry a distinct icon and a title that reads as a message to Brigadir rather than a generic tool invocation.

**Why this priority**: The agent's only voice to the orchestrator is through three callback tools. Today they look identical to any other tool call, so an operator cannot separate "the agent talked to the system" from "the agent ran a command." Making this distinction visible is essential to reading the run's control flow and is independently valuable even without the fidelity improvements in Story 1.

**Independent Test**: View a run that reports progress, requests a human, and completes. Confirm each orchestrator call shows a distinct icon and a title of the form "action → Brigadir", visually separable from an ordinary tool call.

**Acceptance Scenarios**:

1. **Given** the agent reports progress to the orchestrator, **When** the operator views the timeline, **Then** the entry shows a megaphone-style icon and a title reading "report_progress → Brigadir" (not "report_progress (brigadir)" with a generic tool icon).
2. **Given** the agent requests a human, **When** the operator views the timeline, **Then** the entry shows a question-style icon and an orchestrator-directed title.
3. **Given** the agent completes the task, **When** the operator views the timeline, **Then** the entry shows a flag-style icon and a completion-styled title.
4. **Given** the agent runs an ordinary tool (e.g. a shell command), **When** the operator views the timeline, **Then** the entry keeps its ordinary tool icon and name, clearly distinct from orchestrator calls.

---

### User Story 3 - Typed cards for orchestrator callbacks (Priority: P2)

For each orchestrator callback, the operator sees a purpose-built card instead of a generic body: a human request shows its title as the heading with its kind and blocking status as tags and its details as formatted text; a completion shows its outcome, its summary as formatted text, and a count of checks; a progress report continues to appear once (not duplicated by the tool call that produced it).

**Why this priority**: Builds on Stories 1 and 2 to make the most important events legible at a glance. Valuable but dependent on the fidelity and affordance work; a plain-but-complete rendering already delivers most of the benefit, so this is P2.

**Independent Test**: Produce a run with a human request (kind, title, details, blocking) and a completion (outcome, summary, checks). Confirm each renders as its typed card with the expected tags and formatted body, and that the progress report is not shown twice.

**Acceptance Scenarios**:

1. **Given** a human request with kind, title, details, and blocking flag, **When** the operator views its card, **Then** the title is the heading, kind and blocking appear as tags, and details render as Markdown.
2. **Given** a completion with an outcome, a summary, and a set of checks, **When** the operator views its card, **Then** the title reads "Complete · <outcome>", the summary renders as Markdown, and the number of checks appears as a tag.
3. **Given** a progress report, **When** the operator views the timeline, **Then** it appears exactly once even though it originates from both a tool call and a progress event.

---

### User Story 4 - Graceful handling of unknown and legacy payloads (Priority: P3)

An operator viewing older runs (recorded before this feature) or events whose payload has no obvious message still sees something readable: structured payloads are shown as a compact key-value list rather than a JSON dump, and events that were truncated by the old executor are shown as before with a small note explaining the input was truncated — never a repaired-but-wrong reconstruction.

**Why this priority**: Ensures no regression for historical data and unexpected shapes, but affects a minority of entries and does not block the primary reading experience, so it is P3.

**Independent Test**: Load a run containing a legacy truncated tool-call string and a structured payload with no primary text field. Confirm the legacy entry shows the stored string plus a truncation note, and the structured entry shows a key-value list rather than raw JSON.

**Acceptance Scenarios**:

1. **Given** a payload object with no primary text field, **When** the operator views the entry, **Then** it renders as a compact key-value list (muted key, regular value), not as a JSON string.
2. **Given** a legacy event whose input was stored as a truncated string, **When** the operator views the entry, **Then** it shows the stored content plus a note that the input was truncated by the executor, with no attempt to repair broken JSON.

---

### Edge Cases

- **Flood of progress messages**: An agent that emits hundreds of text blocks must not overwhelm the timeline or storage; sampling continues to bound how many progress entries are kept per run (raised limit), while human-authored texts that are kept are never truncated.
- **Truncated non-human machine fields**: A tool input with a long non-file string field (e.g. a large query) is capped per field so a single entry cannot dominate the timeline, with a truncation flag set.
- **File content in edits**: A file body inside a write/edit-style input is replaced by a size placeholder regardless of length, so file contents never appear inline.
- **Empty or absent bodies**: An event with no displayable text shows only its title and time, with no empty grey block.
- **Mixed truncation**: A tool input where some fields were truncated and others were not sets the truncated flag and still shows every field's (possibly capped) value structurally.
- **Markdown containing code that looks like JSON**: A human-authored message containing a JSON snippet renders as a formatted code block, not mistaken for a raw payload dump.
- **Very long body block**: A body that exceeds the length threshold is collapsed to a preview with a per-entry "show more" / "show less" control; expanding reveals the full text in place (no navigation away) and collapsing restores the compact view. The complete text is always present — the control only affects visibility, never fidelity.
- **Body just under vs. just over the threshold**: A body below the threshold renders fully with no control; only over-threshold bodies get the expand affordance, so short messages are never cluttered by an unused control.

## Requirements *(mandatory)*

### Functional Requirements

**Data fidelity (recording side)**

- **FR-001**: The system MUST persist a tool call's input as a structured object, never as a single stringified blob, so the timeline can always decompose it into fields.
- **FR-002**: When persisting a tool call's input, the system MUST truncate individual string fields independently (not across the serialized whole) and MUST set a `truncated` flag on the persisted input when any field was cut.
- **FR-003**: The system MUST never truncate human-authored texts: progress messages (whether derived from assistant text or from a progress report), human-request title and details, and completion summary MUST be stored in full.
- **FR-004**: The system MUST raise the progress-report message length limit in the callback contract from 500 to 4000 characters so agents can report fuller messages.
- **FR-005**: The system MUST replace file-content fields in write/edit-style tool inputs with a short placeholder indicating the content's size (e.g. "<file content, 34 KB>") rather than storing the file body.
- **FR-006**: The system MUST cap other (non-human-authored, non-file) string fields at approximately 2000 characters per field, setting the truncated flag when a cap is applied.
- **FR-007**: The system MUST raise the per-run progress-sampling cap from 20 to approximately 100 kept progress events, retaining sampling as flood protection.

**Presentation (reading side)**

- **FR-008**: The system MUST render an orchestrator human-request as a typed card: title as heading, kind and blocking status as tags, and details rendered as Markdown.
- **FR-009**: The system MUST render an orchestrator completion as a typed card: title "Complete · <outcome>", summary rendered as Markdown, and a tag showing the number of checks.
- **FR-010**: The system MUST render message-like bodies (progress message, request details, completion summary) as formatted Markdown (headings, lists, code) rather than as a preformatted monospace block.
- **FR-011**: The system MUST keep shell commands and genuinely raw payloads in a monospace block (not Markdown-rendered).
- **FR-012**: When a payload object has no primary text field, the system MUST render a compact key-value list (muted key, regular value) instead of a serialized JSON string.
- **FR-013**: The system MUST render orchestrator callback tool calls with distinct static icons — a megaphone for progress reports, a question-style icon for human requests, a flag-style icon for completion — and MUST title them in the form "<action> → Brigadir" (arrow, not parentheses).
- **FR-014**: The system MUST keep ordinary (non-orchestrator) tool calls visually distinct from orchestrator calls, retaining their existing icon and name treatment.
- **FR-015**: The system MUST continue to show a progress report exactly once, preserving the existing de-duplication between a progress report's tool call and the progress event it produces.
- **FR-016**: The system MUST degrade gracefully for legacy events whose input was stored as a truncated string: show the stored content as today plus a note that the input was truncated by the executor, and MUST NOT attempt to repair broken JSON.
- **FR-017**: All timeline icons MUST be static (no hover animation), consistent with the project convention that hover animation is limited to the sidebar.

**Preserved behavior**

- **FR-018**: The system MUST keep every run event present in the timeline as its own visible entry — no entries hidden, filtered, or grouped behind a control — so the operator still sees the full sequence of what happened at a glance.
- **FR-024**: For a message body that exceeds a length threshold, the system MUST collapse it by default to a preview and provide a per-entry expand/collapse control ("show more" / "show less") that reveals or re-hides the full text in place; exactly one such control per timeline entry, and no control for bodies below the threshold (they render in full). This refines the 2026-07-15 "everything visible" decision rather than reversing it: fidelity is preserved — nothing is truncated or removed, the full text is one click away — while a wall of very long text no longer forces the operator to scroll past it to reach the next event.
- **FR-019**: The system MUST NOT change the run-events database schema; all changes are to the shape of data stored within the existing JSON payload column.
- **FR-020**: The system MUST NOT change how the system writes to Jira.

**Testing (delivered in the same iteration)**

- **FR-021**: The recording-side changes MUST ship with stream-parser unit tests covering structured input persistence, per-field truncation and the truncated flag, file-content placeholder substitution, non-truncation of human-authored text, and the raised sampling cap.
- **FR-022**: The callback changes MUST ship with integration tests (against real Postgres/Redis) covering the raised message limit and full-fidelity persistence of human-authored fields.
- **FR-023**: The presentation changes MUST ship with presenter and run-card unit tests covering typed cards, orchestrator icons and titles, Markdown vs. monospace selection, the key-value fallback, and legacy-event degradation.

### Key Entities *(include if feature involves data)*

- **Run event**: A single timeline entry recorded during a run. Has a type (log, tool call, progress, Jira action, API retry, error) and a free-form payload. This feature changes only the payload shape for tool-call events, not the entry itself.
- **Tool-call payload**: The recorded input of a tool the agent invoked. After this feature it is a structured object of named fields (with per-field caps, a file-content placeholder where applicable, and a truncated flag), replacing the previous single stringified blob.
- **Orchestrator callback**: One of three tool calls that are the agent's only voice to the orchestrator — a progress report (message, stage, percent), a human request (kind, title, details, blocking), and a task completion (outcome, summary, checks). This feature gives each a typed card and a distinct affordance.
- **Timeline item (view model)**: The reader-side representation of a run event — time, icon/type, title, and body. This feature adds orchestrator-specific icons/titles, Markdown vs. monospace body selection, tags, and a key-value fallback.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of human-authored texts (progress messages, human-request titles and details, completion summaries) are displayed in full, with zero truncation, for runs recorded after this feature.
- **SC-002**: Zero raw JSON dumps appear in the timeline for tool inputs recorded after this feature; every tool input is displayed either as a typed card, a structured key-value list, or a monospace command/raw block.
- **SC-003**: An operator can distinguish an orchestrator call from an ordinary tool call at a glance in 100% of cases, by icon and title, without opening or expanding anything.
- **SC-004**: No single timeline entry exceeds a bounded size for machine-generated fields — file contents never appear inline and non-human string fields are capped — so the timeline remains scannable regardless of tool input size.
- **SC-005**: Legacy runs recorded before this feature remain readable: no broken-JSON reconstruction is attempted, and truncated legacy inputs are clearly annotated as such.
- **SC-006**: The recording, callback, and presentation changes each ship with passing automated tests in the same iteration, with no pipeline logic left unverified.
- **SC-007**: A very long human-authored message no longer forces the operator to scroll its full length to reach the next event: it is collapsed to a preview by default and expandable in place per entry, with the complete text always available.

## Assumptions

- The reader is an internal operator/engineer using the dashboard; there is no external or multi-tenant audience for the timeline in scope here.
- The existing Markdown renderer component is suitable for rendering human-authored message bodies (headings, lists, code) and is reused rather than replaced.
- "Orchestrator callback tools" are exactly the three brigadir callback tools (progress report, human request, completion); no other tool family gets special affordances in this feature.
- The per-field string cap (~2000 chars) and the raised progress-sampling cap (~100) are tuning values chosen to bound noise while preserving readability; exact constants may be adjusted during implementation without changing behavior.
- The collapse threshold for "very long" bodies is a tuning value (e.g. a body taller than roughly 8–12 lines or longer than ~800 characters); the exact threshold and preview height may be adjusted during implementation. The expand/collapse control is per timeline entry, defaults to collapsed for over-threshold bodies, and is absent for shorter bodies. Collapse affects display only — the full text remains in the payload and in the page.
- The file-content placeholder needs only to convey approximate size (e.g. in KB); exact byte-accurate reporting is not required.
- No database migration is needed because the run-events payload column already stores free-form JSON; only the shape of stored values changes.
- The existing timeline layout (time · icon · title · body block) remains the frame for all new rendering. The 2026-07-15 "everything visible, no expand/collapse" decision is refined here, not reversed: every event stays a visible entry and no text is truncated, but very long message bodies gain a per-entry expand/collapse so they don't dominate the view.
