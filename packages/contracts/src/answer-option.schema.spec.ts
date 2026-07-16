import { describe, it, expect } from 'vitest';
import { AnswerOptionSchema, AnswerOptionsSchema } from './answer-option.schema';
import { HumanQueueItemSchema } from './human-queue.schema';

describe('AnswerOptionSchema (feature 013)', () => {
  it('accepts a full option and a label-only option', () => {
    expect(
      AnswerOptionSchema.safeParse({
        label: 'Migrate config format',
        value: 'migrate',
        description: 'Breaking, needs a major bump',
      }).success,
    ).toBe(true);
    expect(AnswerOptionSchema.safeParse({ label: 'Keep compat' }).success).toBe(true);
  });

  it('enforces the field bounds (label 80 / value 500 / description 200)', () => {
    expect(AnswerOptionSchema.safeParse({ label: 'a'.repeat(80) }).success).toBe(true);
    expect(AnswerOptionSchema.safeParse({ label: 'a'.repeat(81) }).success).toBe(false);
    expect(
      AnswerOptionSchema.safeParse({ label: 'x', value: 'v'.repeat(500) }).success,
    ).toBe(true);
    expect(
      AnswerOptionSchema.safeParse({ label: 'x', value: 'v'.repeat(501) }).success,
    ).toBe(false);
    expect(
      AnswerOptionSchema.safeParse({ label: 'x', description: 'd'.repeat(200) }).success,
    ).toBe(true);
    expect(
      AnswerOptionSchema.safeParse({ label: 'x', description: 'd'.repeat(201) }).success,
    ).toBe(false);
  });

  it('rejects empty strings on every field', () => {
    expect(AnswerOptionSchema.safeParse({ label: '' }).success).toBe(false);
    expect(AnswerOptionSchema.safeParse({ label: 'x', value: '' }).success).toBe(false);
    expect(AnswerOptionSchema.safeParse({ label: 'x', description: '' }).success).toBe(false);
  });

  it('is strict — an unknown key is rejected', () => {
    expect(
      AnswerOptionSchema.safeParse({ label: 'x', icon: 'sparkles' }).success,
    ).toBe(false);
  });
});

describe('AnswerOptionsSchema (feature 013)', () => {
  it('accepts 1 to 5 options', () => {
    expect(AnswerOptionsSchema.safeParse([{ label: 'only' }]).success).toBe(true);
    expect(
      AnswerOptionsSchema.safeParse(
        Array.from({ length: 5 }, (_, i) => ({ label: `option ${i}` })),
      ).success,
    ).toBe(true);
  });

  it('rejects an empty array — "no options" is expressed by omitting the field', () => {
    expect(AnswerOptionsSchema.safeParse([]).success).toBe(false);
  });

  it('rejects a sixth option', () => {
    expect(
      AnswerOptionsSchema.safeParse(
        Array.from({ length: 6 }, (_, i) => ({ label: `option ${i}` })),
      ).success,
    ).toBe(false);
  });
});

describe('HumanQueueItemSchema.options (feature 013)', () => {
  const baseItem = {
    id: 'ht-1',
    kind: 'question',
    title: 'Which strategy?',
    details: null,
    blocking: true,
    ticket: null,
    agent: null,
    workspace: { id: 'ws-1', name: 'WS' },
    run_id: null,
    created_at: '2026-07-16T00:00:00.000Z',
  };

  it('requires the options field (nullable, not optional)', () => {
    expect(HumanQueueItemSchema.safeParse(baseItem).success).toBe(false);
    expect(HumanQueueItemSchema.safeParse({ ...baseItem, options: null }).success).toBe(true);
    expect(
      HumanQueueItemSchema.safeParse({
        ...baseItem,
        options: [{ label: 'Minimal team', description: 'Just a developer' }],
      }).success,
    ).toBe(true);
  });
});
