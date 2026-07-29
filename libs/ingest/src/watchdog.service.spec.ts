import { describe, it, expect } from 'vitest';
import { resolveMinutesSetting } from './watchdog.service';

// Feature 034: a malformed watchdog env value must degrade to the default
// WITH a malformed flag (the service warns), never to NaN — NaN inside the
// sweep's SQL interval makes the predicate NULL and silently disables the
// watchdog, the exact failure it exists to prevent.
describe('resolveMinutesSetting', () => {
  it.each([
    { raw: undefined, expected: { minutes: 5, malformed: false } },
    { raw: '7', expected: { minutes: 7, malformed: false } },
    { raw: '0', expected: { minutes: 0, malformed: false } },
    { raw: '2.5', expected: { minutes: 2.5, malformed: false } },
    { raw: 'abc', expected: { minutes: 5, malformed: true } },
    { raw: '-1', expected: { minutes: 5, malformed: true } },
    { raw: 'Infinity', expected: { minutes: 5, malformed: true } },
    { raw: 'NaN', expected: { minutes: 5, malformed: true } },
  ])('resolveMinutesSetting($raw) → $expected', ({ raw, expected }) => {
    expect(resolveMinutesSetting(raw, 5)).toEqual(expected);
  });

  it('empty string falls back as malformed (Number("") is 0 but the setting was not stated)', () => {
    // Number('') === 0 — a silently-zero grace from an accidentally empty env
    // var would make every running run instantly sweepable at timeout with no
    // buffer; treat it as malformed instead.
    expect(resolveMinutesSetting('', 5)).toEqual({ minutes: 5, malformed: true });
  });
});
