import { z } from 'zod';

/**
 * Suggested answer options on human tasks (feature 013) — the ONE home of the
 * option shape, reused by both intake surfaces (`RequestHumanSchema`,
 * `ReportHumanTaskSchema`) and the queue API (`HumanQueueItemSchema`) so the
 * contract stays byte-identical across them (research D1).
 *
 * `value` defaults to `label` at CLICK time in the UI — the schema deliberately
 * does NOT materialize the default, so storage shows exactly what the agent
 * sent (research D2). All three fields are free text and pass the secret
 * scrubber at intake (Constitution V).
 */

export const AnswerOptionSchema = z
  .object({
    label: z
      .string()
      .min(1)
      .max(80)
      .describe('Button text — the human-facing name of this choice.'),
    value: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe(
        'The exact string submitted as the answer when this option is chosen. ' +
          'Defaults to `label` when omitted.',
      ),
    description: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Secondary hint shown with the button (one short sentence).'),
  })
  .strict();

/**
 * 1–5 options; "no options" is expressed by OMITTING the field — an empty
 * array is rejected so NULL stays the single no-options representation
 * (research D3).
 */
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
