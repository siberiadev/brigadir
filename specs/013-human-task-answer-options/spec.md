# Feature Specification: Suggested Answer Options on Human Tasks

**Feature Branch**: `013-human-task-answer-options`

**Created**: 2026-07-16

**Status**: Draft

**Input**: User description: "Suggested answer options (\"buttons\") on human tasks. When an agent asks a human a question via request_human or a needs_human report (blocking or non-blocking), it can attach up to 5 predefined answer options ({ label ≤80, value? ≤500, description? ≤200 }, value defaults to label). The Human Queue drawer renders them as one-click buttons; clicking one fills the answer input with the option's value; the free-text field remains below as the always-available custom answer; the human still presses the existing explicit resolve submit (no auto-submit). The chosen option becomes the ordinary STRING resolution through the existing answer field of POST /api/human-tasks/:id/resolve — the resume/answer-triage pipeline is untouched by design."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Agent offers answer options, human picks one (Priority: P1)

An agent working a ticket hits a decision point that is a **choice, not an essay**
("Should I migrate the config format or keep backward compat?"). It asks the human
via `request_human` (or a `needs_human` completion report) and attaches up to 5
predefined answer options. The operator opens the task in the Human Queue drawer,
sees the options as one-click buttons under the question, clicks one — the answer
input fills with that option's submitted value — reviews it, and presses the
existing Submit. The run resumes with the chosen answer exactly as if the operator
had typed it.

**Why this priority**: This is the whole feature — it turns the highest-friction
human interaction (free-text answering) into a one-click decision for the common
case, and it is the only story that touches every layer (intake → storage → queue
API → UI → resolution).

**Independent Test**: Drive a run that calls `request_human` with options; open
the queue, click an option, submit; verify the run resumes and the handoff shows
the Q&A with the option's value as the answer.

**Acceptance Scenarios**:

1. **Given** an open blocking human task created with 3 options, **When** the
   operator opens its drawer, **Then** 3 buttons render (label prominent,
   description as secondary text), with the free-text field still present below.
2. **Given** the drawer with options, **When** the operator clicks an option,
   **Then** the answer input fills with that option's value and NOTHING is
   submitted yet.
3. **Given** an option-filled answer input, **When** the operator presses Submit
   with action "Resume", **Then** the task resolves with that string as its
   resolution and the parked run resumes; the resumed run's handoff renders the
   question and the chosen value as an ordinary Q&A.
4. **Given** the drawer with options, **When** the operator ignores the buttons
   and types a custom answer, **Then** the custom text submits exactly as today.
5. **Given** an option whose `value` is omitted at intake, **When** the operator
   clicks its button, **Then** the answer input fills with the option's `label`.

---

### User Story 2 - Options travel through both intake surfaces and the queue API (Priority: P2)

An agent can attach options on BOTH ask surfaces: the mid-run `request_human`
callback tool and the `human_task` payload of a `needs_human` completion report.
Either way the options are persisted with the task and served to the dashboard on
the global Human Queue list and the per-workspace Human queue tab.

**Why this priority**: Without both surfaces the feature is invisible to half the
agents (report-driven ones); without the queue API carrying options the UI has
nothing to render.

**Independent Test**: Create one task via each surface with options; list the
queue globally and workspace-scoped; both items carry the options verbatim
(after scrubbing).

**Acceptance Scenarios**:

1. **Given** a `request_human` call with 2 options, **When** the task is created,
   **Then** the stored task carries both options and the queue list item includes
   them.
2. **Given** a `needs_human` completion report whose `human_task` carries options,
   **When** the run finalizes, **Then** the created task carries the options.
3. **Given** a task created without options (including every system-composed
   task: PR-review, triage-limit, orchestrator-failure, team-review), **When**
   listed, **Then** its `options` is null and the drawer renders exactly as today.
4. **Given** an option list with 6 items, or a label over 80 chars, or a value
   over 500 chars, or a description over 200 chars, or an unknown extra key,
   **When** the callback arrives, **Then** it is rejected as a validation error
   (422) and the run is untouched.
5. **Given** an option whose label contains a secret (matching the scrubber's
   patterns), **When** the task is created, **Then** the stored/served label is
   scrubbed — same guarantee as title/details.

---

### User Story 3 - Options are mirrored to the Jira question comment (Priority: P3)

The Jira comment that mirrors a blocking question renders the offered options as a
plain list under the question, so a teammate reading Jira sees the same choices
the dashboard operator sees. (Jira has no buttons — answering still happens in
the dashboard.)

**Why this priority**: Visibility parity for teammates who live in Jira; nothing
functional depends on it.

**Independent Test**: Snapshot the ADF comment built for a human task with
options; the options appear as a bullet list; without options the comment is
byte-identical to today's.

**Acceptance Scenarios**:

1. **Given** a blocking `request_human` with options on a ticketed run, **When**
   the question comment is posted, **Then** it contains the options as a plain
   ADF bullet list (label, plus description when present).
2. **Given** a task without options, **When** the comment is built, **Then** the
   ADF is unchanged from today (snapshot-stable).

---

### Edge Cases

- Option with `value` omitted → the button submits the `label` (documented
  default).
- Empty `options: []` at intake → treated as invalid (min 1 when present) so the
  stored column is never a meaningless empty array; agents omit the field
  instead.
- Closed tasks: the drawer's closed view shows the resolution text as today —
  options are NOT re-rendered as buttons on closed tasks.
- The operator clicks option A, then option B → the answer input is replaced
  (last click wins), still editable as free text afterwards.
- A task with options resolved via "Done manually" / "Dismiss" → options impose
  nothing; the existing actions behave as today.
- Duplicate labels/values across options → allowed (no uniqueness constraint);
  the human sees identical buttons and either works.
- The scrubber replaces a secret inside `value` → the button submits the
  scrubbed value (never the raw secret).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Agents MUST be able to attach a list of 1–5 answer options to a
  human task on BOTH ask surfaces: the `request_human` callback tool and the
  `human_task` payload of a `needs_human` completion report.
- **FR-002**: Each option MUST have a `label` (≤80 chars, required), and MAY have
  a `value` (≤500 chars; the string submitted as the answer; defaults to `label`
  when omitted) and a `description` (≤200 chars, secondary explanatory text).
  Unknown keys MUST be rejected.
- **FR-003**: The `options` field MUST be optional on both intake surfaces; when
  present it MUST contain 1–5 items. Tasks created without options MUST be
  stored and served with `options` null and behave exactly as today.
- **FR-004**: Option free text (`label`, `value`, `description`) MUST pass the
  secret scrubber before persistence, with the same guarantee as `title` and
  `details` (Constitution V).
- **FR-005**: Persisted options MUST be stored with the human task and survive
  restarts; system-composed tasks (PR review, triage-limit, orchestrator
  failure, team review) MUST carry no options.
- **FR-006**: The Human Queue list API (global and workspace-scoped) MUST serve
  each task's options (null when absent). The resolve endpoint contract MUST
  remain unchanged.
- **FR-007**: The Human Queue drawer MUST render an open task's options as
  one-click buttons — label prominent, description as secondary text — above the
  existing free-text answer field, which MUST remain available as the custom
  answer.
- **FR-008**: Clicking an option MUST fill the answer input with the option's
  submitted value (its `value`, or `label` when `value` was omitted) and MUST
  NOT auto-submit; the operator presses the existing explicit Submit.
- **FR-009**: The chosen option MUST flow through the EXISTING string `answer`
  field of the resolve endpoint; the resume, handoff Q&A rendering, and
  answer-triage pipeline MUST require zero changes.
- **FR-010**: The Jira question comment for a blocking ask MUST render the
  options as a plain list (no interactive elements); a task without options MUST
  produce today's comment unchanged.
- **FR-011**: The agent-facing tool documentation MUST mention that
  `request_human` / `needs_human` accept `options`, coaching agents to offer
  options whenever the answer is a choice, not an essay — without requiring any
  stored-instruction edits for existing agents.
- **FR-012**: Tasks with options MUST render no buttons once closed; the closed
  view stays as today.

### Key Entities

- **Answer option**: a suggested reply an agent attaches to its question —
  `label` (button text), optional `value` (the string actually submitted;
  defaults to the label), optional `description` (secondary hint). Bounded: max
  5 per task.
- **Human task**: existing entity; gains an optional list of answer options
  (null for all tasks predating the feature and all system-composed tasks).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can answer an option-carrying question with exactly two
  clicks (option + submit) — no typing.
- **SC-002**: 100% of tasks without options render and resolve exactly as before
  the feature (no visual or behavioral change).
- **SC-003**: Option-carrying asks round-trip end to end: for both intake
  surfaces, the offered options are visible in the queue and the chosen value
  lands verbatim (post-scrub) as the task's resolution and in the resumed run's
  question-answer handoff.
- **SC-004**: Zero changes to the resolution pipeline: resolve endpoint contract,
  resume behavior, and answer-triage behave byte-identically for option-chosen
  answers and typed answers.
- **SC-005**: Out-of-bounds option payloads (>5 items, oversized fields, unknown
  keys) are rejected at intake with a validation error and never reach storage.

## Assumptions

- The existing single-string `answer`/`resolution` model is sufficient — a
  clicked option is just a pre-filled string (user-confirmed decision).
- No validation that the submitted answer matches an offered option — the human
  may edit the filled value freely before submitting (deliberate v1 cut).
- Multi-select, editing options after creation, options on system-composed
  tasks, and interactive Jira buttons are out of scope (deliberate v1 cuts).
- Jira readers answer in the dashboard; the Jira mirror is informational only.
- Existing agents pick the feature up from the updated tool documentation alone;
  no stored agent instructions need editing.
