# Contract — Answer Options across the ask surfaces (013)

## 1. Shared schema (`packages/contracts/src/answer-option.schema.ts`)

```ts
export const AnswerOptionSchema = z
  .object({
    label: z.string().min(1).max(80).describe('Button text — the human-facing name of this choice.'),
    value: z.string().min(1).max(500).optional()
      .describe('The exact string submitted as the answer when this option is chosen. Defaults to `label` when omitted.'),
    description: z.string().min(1).max(200).optional()
      .describe('Secondary hint shown with the button (one short sentence).'),
  })
  .strict();

export const AnswerOptionsSchema = z
  .array(AnswerOptionSchema)
  .min(1)
  .max(5)
  .describe(
    'Suggested answers rendered as one-click buttons in the human queue. ' +
      'Offer options whenever the answer is a choice, not an essay. ' +
      'The human can always type a custom answer instead.',
  );

export type AnswerOption = z.infer<typeof AnswerOptionSchema>;
```

## 2. Intake surfaces (both gain `options: AnswerOptionsSchema.optional()`)

### `request_human` (callback tool, `POST /api/callbacks/runs/:runId/human`)

```jsonc
{
  "kind": "question",
  "title": "Which migration strategy?",
  "details": "…markdown…",
  "blocking": true,
  "options": [                                   // NEW, optional, 1–5 items
    { "label": "Migrate config format", "description": "Breaking, needs a major bump" },
    { "label": "Keep backward compat", "value": "compat", "description": "Slower but safe" }
  ]
}
```

### `complete_task` with `outcome=needs_human` (`human_task` payload)

```jsonc
{
  "schema_version": 1,
  "outcome": "needs_human",
  "summary": "…",
  "checks": [],
  "human_task": {
    "kind": "question",
    "title": "Which migration strategy?",
    "options": [ { "label": "Migrate" }, { "label": "Keep compat" } ]   // NEW, optional
  }
}
```

**Validation** (both surfaces, 422 + run untouched on violation):
- \>5 items, empty array, label >80 / value >500 / description >200, empty
  strings, unknown keys ⇒ rejected.
- `schema_version` stays `1` — the extension is additive-optional (old agents
  validate unchanged).

**Scrubbing**: `label`/`value`/`description` pass `scrub()` in
`CallbackService.human()` / `scrubReport()` BEFORE persistence — identical
guarantee to `title`/`details` (Constitution V).

## 3. Queue API (`GET /api/human-tasks`, global and `?workspace=<id>`)

`HumanQueueItem` gains:

```ts
options: z.array(AnswerOptionSchema).nullable(),   // null ⇒ no options
```

Served on every item (open and closed) by the one shared select in
`human-tasks.controller.ts`. **`GET /api/human-tasks/count` unchanged.**

## 4. Resolve endpoint — UNCHANGED (by design)

`POST /api/human-tasks/:id/resolve` keeps `ResolveHumanTaskSchema` byte-for-byte.
A clicked option submits `value ?? label` through the existing `answer` string
(≤4000 — a ≤500 value always fits). Resume, handoff Q&A rendering, and
answer-triage change zero lines.

## 5. Jira mirror (`buildHumanTaskComment`)

With options, the ADF question comment appends after the details paragraph:

```jsonc
{ "type": "paragraph", "content": [{ "type": "text", "text": "Suggested answers:" }] },
{ "type": "bulletList", "content": [
  { "type": "listItem", "content": [{ "type": "paragraph", "content": [
    { "type": "text", "text": "Migrate config format — Breaking, needs a major bump" }
  ]}]},
  …
]}
```

- One `listItem` per option: `label`, plus ` — description` when present;
  `value` is never rendered (research D6).
- Without options the document is byte-identical to today (snapshot-asserted).
- Deterministic — no ids, no timestamps.

## 6. Agent-facing prose (`callbackToolsSection`)

One sentence added to the `request_human` bullet (wording final at
implementation, content fixed): options may be attached as
`options: [{label, value?, description?}]` (max 5, value defaults to label),
also accepted inside `complete_task`'s `human_task`; offer them whenever the
answer is a choice, not an essay. `structuredOutputSection()` stays
byte-for-byte (Phase-0 contract).
