import { describe, it, expect, vi } from 'vitest';
import { sanitizeToolInput } from './tool-input-sanitizer';

/**
 * Unit contract for the tool_call input sanitizer (feature 026,
 * contracts/tool-call-payload.md). `scrub` is injected so tests can assert it
 * ran without depending on the real regex/entropy scrubber.
 */

const identity = (s: string): string => s;

describe('sanitizeToolInput', () => {
  it('keeps human-authored text in full (never truncated), scrubbed', () => {
    const details = 'x'.repeat(5000);
    const { input, truncated } = sanitizeToolInput(
      'mcp__brigadir__request_human',
      { kind: 'question', title: 'A title', details, blocking: true },
      identity,
    );
    expect(input.details).toBe(details); // full length, not cut
    expect(input.title).toBe('A title');
    expect(input.blocking).toBe(true);
    expect(truncated).toBe(false);
  });

  it('replaces file-content fields with a size placeholder and does not set truncated', () => {
    const { input, truncated } = sanitizeToolInput(
      'Write',
      { file_path: '/a/b.ts', content: 'x'.repeat(34 * 1024) },
      identity,
    );
    expect(input.file_path).toBe('/a/b.ts');
    expect(input.content).toBe('<file content, 34 KB>');
    expect(truncated).toBe(false);
  });

  it('placeholders Edit old_string / new_string too', () => {
    const { input } = sanitizeToolInput(
      'Edit',
      { file_path: '/a.ts', old_string: 'y'.repeat(3000), new_string: 'z'.repeat(9000) },
      identity,
    );
    expect(input.old_string).toBe('<file content, 3 KB>');
    expect(input.new_string).toBe('<file content, 9 KB>');
  });

  it('caps a generic string field at 2000 chars and sets truncated', () => {
    const { input, truncated } = sanitizeToolInput('Grep', { query: 'q'.repeat(5000) }, identity);
    expect((input.query as string).length).toBe(2000);
    expect(truncated).toBe(true);
  });

  it('leaves a short generic field unchanged and truncated=false', () => {
    const { input, truncated } = sanitizeToolInput('Bash', { command: 'pnpm test' }, identity);
    expect(input.command).toBe('pnpm test');
    expect(truncated).toBe(false);
  });

  it('passes non-string leaves through unchanged', () => {
    const { input } = sanitizeToolInput('X', { n: 42, b: false, z: null }, identity);
    expect(input).toMatchObject({ n: 42, b: false, z: null });
  });

  it('recurses into nested arrays/objects and scrubs+caps nested strings (C1 guard)', () => {
    const scrub = vi.fn((s: string) => s.replace(/SECRET/g, '[redacted]'));
    const { input, truncated } = sanitizeToolInput(
      'mcp__brigadir__complete_task',
      {
        schema_version: 1,
        outcome: 'success',
        summary: 'Done SECRET', // human text: full, scrubbed
        checks: [{ name: 'tests', status: 'pass', reason: `SECRET ${'r'.repeat(5000)}` }],
        artifacts: { branch: 'feat/SECRET', commits: ['SECRET-abc'] },
      },
      scrub,
    );
    const checks = input.checks as { reason: string }[];
    expect(checks[0].reason.startsWith('[redacted] ')).toBe(true); // scrubbed
    expect(checks[0].reason.length).toBe(2000); // nested generic capped
    expect(truncated).toBe(true);
    expect((input.artifacts as { branch: string }).branch).toBe('feat/[redacted]');
    expect((input.artifacts as { commits: string[] }).commits[0]).toBe('[redacted]-abc');
    expect(input.summary).toBe('Done [redacted]'); // human text scrubbed, not cut
    // scrub ran for every retained string (summary, reason, branch, commit) — not file content
    expect(scrub).toHaveBeenCalled();
  });

  it('does NOT scrub placeholdered file content', () => {
    const scrub = vi.fn((s: string) => s);
    sanitizeToolInput('Write', { content: 'x'.repeat(2048) }, scrub);
    expect(scrub).not.toHaveBeenCalledWith(expect.stringContaining('x'.repeat(100)));
  });

  it('coerces non-object / array / empty input to {} and never throws', () => {
    expect(sanitizeToolInput('X', undefined, identity)).toEqual({ input: {}, truncated: false });
    expect(sanitizeToolInput('X', 'a string', identity)).toEqual({ input: {}, truncated: false });
    expect(sanitizeToolInput('X', [1, 2, 3], identity)).toEqual({ input: {}, truncated: false });
    expect(sanitizeToolInput('X', {}, identity)).toEqual({ input: {}, truncated: false });
  });

  it('is cycle-safe', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => sanitizeToolInput('X', cyclic, identity)).not.toThrow();
  });
});
