import { describe, it, expect } from 'vitest';
import { TriggerEventSchema, TRIGGER_SOURCES, MOCK_SCENARIOS } from './trigger-event.schema';

describe('TriggerEventSchema', () => {
  it('defaults mock_scenario to "success" and source to "manual" when absent', () => {
    const res = TriggerEventSchema.safeParse({});
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.mock_scenario).toBe('success');
      expect(res.data.source).toBe('manual');
    }
  });

  it('accepts every mock scenario (incl. "routed")', () => {
    for (const s of MOCK_SCENARIOS) {
      expect(TriggerEventSchema.safeParse({ mock_scenario: s }).success).toBe(true);
    }
    expect(MOCK_SCENARIOS).toContain('routed');
    // feature 011 (D15): the setup-loop scenarios.
    expect(MOCK_SCENARIOS).toContain('team');
    expect(MOCK_SCENARIOS).toContain('team_invalid');
  });

  it('rejects an unknown mock scenario', () => {
    expect(TriggerEventSchema.safeParse({ mock_scenario: 'explode' }).success).toBe(false);
  });

  describe('source vocabulary (FR-023/D8 + answer-triage delta)', () => {
    it('accepts exactly the eight known sources', () => {
      expect([...TRIGGER_SOURCES]).toEqual([
        'manual',
        'webhook',
        'poll',
        'human-resume',
        'triage',
        'rework',
        'answer-triage',
        'workspace-setup',
      ]);
      for (const s of TRIGGER_SOURCES) {
        expect(TriggerEventSchema.safeParse({ source: s }).success).toBe(true);
      }
    });

    it('validates an answer-triage trigger stored by resume.service.ts (FR-025)', () => {
      const res = TriggerEventSchema.safeParse({
        source: 'answer-triage',
        failing_run_id: '11111111-1111-4111-8111-111111111111',
        human_task_id: '33333333-3333-4333-8333-333333333333',
        resolution: 'Option 1 — the formula is authoritative.',
        mock_scenario: 'routed',
        target_agent: 'Developer',
      });
      expect(res.success).toBe(true);
    });

    it('rejects the old bug value "human_resume" (underscore)', () => {
      expect(TriggerEventSchema.safeParse({ source: 'human_resume' }).success).toBe(false);
    });

    it('validates a resumed mock run stored by resume.service.ts (regression, FR-023)', () => {
      // Before the fix this exact payload crashed validation because the enum
      // lacked 'human-resume' — the run then hung in `queued`.
      const res = TriggerEventSchema.safeParse({
        source: 'human-resume',
        mock_scenario: 'success',
        resolution: 'Use the staging DB URL.',
      });
      expect(res.success).toBe(true);
    });
  });

  describe('handoff fields (D7/D8)', () => {
    it('round-trips typed handoff references', () => {
      const failingRunId = '11111111-1111-4111-8111-111111111111';
      const decidingRunId = '22222222-2222-4222-8222-222222222222';
      const humanTaskId = '33333333-3333-4333-8333-333333333333';
      const res = TriggerEventSchema.safeParse({
        source: 'rework',
        failing_run_id: failingRunId,
        deciding_run_id: decidingRunId,
        human_task_id: humanTaskId,
        target_agent: 'Developer',
        task: 'Fix the failing lint step and re-run.',
      });
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.failing_run_id).toBe(failingRunId);
        expect(res.data.deciding_run_id).toBe(decidingRunId);
        expect(res.data.human_task_id).toBe(humanTaskId);
        expect(res.data.target_agent).toBe('Developer');
        expect(res.data.task).toBe('Fix the failing lint step and re-run.');
      }
    });

    it('rejects a non-UUID handoff id', () => {
      expect(TriggerEventSchema.safeParse({ failing_run_id: 'not-a-uuid' }).success).toBe(false);
    });
  });
});
