import { describe, it, expect } from 'vitest';
import { analyzeBashCommand, BASH_GUARD_PREFIX, MAX_SLEEP_SECONDS } from './bash-guard-logic';

describe('analyzeBashCommand', () => {
  describe('allow', () => {
    it('command without sleep', () => {
      expect(analyzeBashCommand('npm run lint 2>&1 | tail -60')).toEqual({ allow: true });
    });

    it('short sleep', () => {
      expect(analyzeBashCommand('sleep 5')).toEqual({ allow: true });
    });

    it('cumulative sleep at the boundary (=15s)', () => {
      expect(analyzeBashCommand('sleep 5 && sleep 10')).toEqual({ allow: true });
    });

    it('fractional sleep', () => {
      expect(analyzeBashCommand('sleep 0.5 && curl -sf localhost:3000/health')).toEqual({
        allow: true,
      });
    });

    it('loop without sleep', () => {
      expect(analyzeBashCommand('for f in src/*.ts; do npx eslint "$f"; done')).toEqual({
        allow: true,
      });
    });

    it('loop keyword in prose without `done` does not trip the loop rule', () => {
      expect(analyzeBashCommand('git commit -m "wait for review" && sleep 3')).toEqual({
        allow: true,
      });
    });
  });

  describe('deny: loop_sleep', () => {
    it('while-loop polling', () => {
      const result = analyzeBashCommand('while true; do curl -sf $URL && break; sleep 600; done');
      expect(result).toMatchObject({ deny: true, rule: 'loop_sleep' });
    });

    it('until-loop polling', () => {
      const result = analyzeBashCommand(
        'until git ls-remote origin refs/heads/main; do sleep 30; done',
      );
      expect(result).toMatchObject({ deny: true, rule: 'loop_sleep' });
    });

    it('for-loop with short sleeps still denies (aggregate wait)', () => {
      const result = analyzeBashCommand('for i in $(seq 1 100); do sleep 2; done');
      expect(result).toMatchObject({ deny: true, rule: 'loop_sleep' });
    });

    it('observed production pattern: counter until-loop', () => {
      const result = analyzeBashCommand(
        'i=0; until [ $i -ge 6 ]; do sleep 10; i=$((i+1)); done; echo done',
      );
      expect(result).toMatchObject({ deny: true, rule: 'loop_sleep' });
    });
  });

  describe('deny: cumulative_sleep', () => {
    it('just over the limit', () => {
      const result = analyzeBashCommand(`sleep ${MAX_SLEEP_SECONDS + 1}`);
      expect(result).toMatchObject({ deny: true, rule: 'cumulative_sleep' });
    });

    it('observed production pattern: sleep 600', () => {
      expect(analyzeBashCommand('sleep 600')).toMatchObject({
        deny: true,
        rule: 'cumulative_sleep',
      });
    });

    it('sum of short sleeps over the limit', () => {
      expect(analyzeBashCommand('sleep 10; sleep 6')).toMatchObject({
        deny: true,
        rule: 'cumulative_sleep',
      });
    });

    it('minute suffix', () => {
      expect(analyzeBashCommand('sleep 1m')).toMatchObject({
        deny: true,
        rule: 'cumulative_sleep',
      });
    });

    it('hour suffix', () => {
      expect(analyzeBashCommand('sleep 1h')).toMatchObject({
        deny: true,
        rule: 'cumulative_sleep',
      });
    });

    it('reason names the computed total', () => {
      const result = analyzeBashCommand('sleep 600');
      if (!('deny' in result)) throw new Error('expected deny');
      expect(result.reason).toContain('600s');
      expect(result.reason).toContain(`${MAX_SLEEP_SECONDS}s`);
    });
  });

  describe('deny: unparsable_sleep', () => {
    it('variable duration', () => {
      expect(analyzeBashCommand('sleep $DELAY')).toMatchObject({
        deny: true,
        rule: 'unparsable_sleep',
      });
    });

    it('quoted variable duration', () => {
      expect(analyzeBashCommand('sleep "$n"')).toMatchObject({
        deny: true,
        rule: 'unparsable_sleep',
      });
    });
  });

  describe('deny-reason contract (consumed by the stream parser)', () => {
    const denies = [
      'while true; do sleep 600; done',
      'sleep 600',
      'sleep $DELAY',
    ];

    it.each(denies)('reason starts with the stable prefix: %s', (cmd) => {
      const result = analyzeBashCommand(cmd);
      if (!('deny' in result)) throw new Error('expected deny');
      expect(result.reason.startsWith(BASH_GUARD_PREFIX)).toBe(true);
    });

    it.each(denies)('reason points to both session-ending tools: %s', (cmd) => {
      const result = analyzeBashCommand(cmd);
      if (!('deny' in result)) throw new Error('expected deny');
      expect(result.reason).toContain('mcp__brigadir__request_human');
      expect(result.reason).toContain('mcp__brigadir__complete_task');
    });

    it.each(denies)('reason never suggests ScheduleWakeup (it is disallowed): %s', (cmd) => {
      const result = analyzeBashCommand(cmd);
      if (!('deny' in result)) throw new Error('expected deny');
      expect(result.reason).not.toContain('ScheduleWakeup');
    });

    it('prefix literal matches what the stream parser greps for', () => {
      // Duplicated in libs/executors/src/claude-cli/stream-parser.ts — no
      // cross-package import by design; drift fails this test (and its twin).
      expect(BASH_GUARD_PREFIX).toBe('[brigadir-bash-guard]');
    });
  });

  describe('quoting edge cases (raw-string heuristic, no shell parsing)', () => {
    it('sleep directly after an opening quote is NOT matched (grep pattern passes)', () => {
      expect(analyzeBashCommand('grep -rn "sleep 600" src/')).toEqual({ allow: true });
    });

    it('accepted v1 false positive: space-preceded sleep inside prose is denied', () => {
      // The heuristic cannot tell quoted prose from a real command here —
      // pinned as the accepted v1 cost.
      expect(analyzeBashCommand('echo "will sleep 600 between retries"')).toMatchObject({
        deny: true,
        rule: 'cumulative_sleep',
      });
    });
  });
});
