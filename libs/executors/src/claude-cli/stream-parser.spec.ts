import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeStreamParser, type ParsedLine } from './stream-parser';

const FIXTURES_DIR = join(process.cwd(), 'test', 'fixtures', 'claude-cli');

function readFixtureLines(name: string): string[] {
  return readFileSync(join(FIXTURES_DIR, `${name}.ndjson`), 'utf8').trim().split('\n');
}

function parseAll(parser: ClaudeStreamParser, lines: string[]): ParsedLine[] {
  return lines.flatMap((line) => parser.parseLine(line));
}

describe('ClaudeStreamParser (T079)', () => {
  it('stream-success: maps log → tool_call → progress → progress → terminal, in order', () => {
    const parser = new ClaudeStreamParser();
    const parsed = parseAll(parser, readFixtureLines('stream-success'));
    const kinds = parsed.map((p) => (p.kind === 'run_event' ? p.event.type : p.kind));
    expect(kinds).toEqual(['log', 'external_ref', 'tool_call', 'progress', 'progress', 'terminal']);

    const terminal = parsed.find((p) => p.kind === 'terminal');
    expect(terminal?.kind).toBe('terminal');
    if (terminal?.kind === 'terminal') {
      expect(terminal.result.totalCostUsd).toBe(0.0123);
      expect(terminal.result.isError).toBe(false);
      expect((terminal.result.structuredOutput as { outcome: string }).outcome).toBe('success');
    }

    const externalRef = parsed.find((p) => p.kind === 'external_ref');
    expect(externalRef?.kind).toBe('external_ref');
    if (externalRef?.kind === 'external_ref') {
      expect(externalRef.sessionId).toBe('sess-success-1');
    }
  });

  it('stream-rate-limit: yields the api_retry run_event + the rate-limit signal, no terminal capture', () => {
    const parser = new ClaudeStreamParser();
    const parsed = parseAll(parser, readFixtureLines('stream-rate-limit'));
    const kinds = parsed.map((p) => (p.kind === 'run_event' ? p.event.type : p.kind));
    expect(kinds).toEqual(['log', 'external_ref', 'api_retry', 'rate_limit']);

    const rateLimit = parsed.find((p) => p.kind === 'rate_limit');
    expect(rateLimit?.kind).toBe('rate_limit');
    if (rateLimit?.kind === 'rate_limit') {
      expect(rateLimit.retryDelayMs).toBe(900000);
      expect(rateLimit.attempt).toBe(1);
    }

    expect(parsed.some((p) => p.kind === 'terminal')).toBe(false);
  });

  it('stream-no-report: terminal capture has no structuredOutput', () => {
    const parser = new ClaudeStreamParser();
    const parsed = parseAll(parser, readFixtureLines('stream-no-report'));
    const terminal = parsed.find((p) => p.kind === 'terminal');
    expect(terminal?.kind).toBe('terminal');
    if (terminal?.kind === 'terminal') {
      expect(terminal.result.structuredOutput).toBeUndefined();
    }
  });

  it('stream-budget-exceeded: no USD figure appears before the terminal event', () => {
    const parser = new ClaudeStreamParser();
    const lines = readFixtureLines('stream-budget-exceeded');
    const nonTerminalLines = lines.slice(0, -1);
    for (const line of nonTerminalLines) {
      const parsedLine = JSON.parse(line);
      expect(parsedLine.total_cost_usd).toBeUndefined();
    }
    const parsed = parseAll(parser, lines);
    const terminal = parsed.find((p) => p.kind === 'terminal');
    expect(terminal?.kind).toBe('terminal');
    if (terminal?.kind === 'terminal') {
      expect(terminal.result.totalCostUsd).toBe(0.12);
    }
  });

  it('a malformed line mid-stream is skipped without throwing and without breaking the rest', () => {
    const parser = new ClaudeStreamParser();
    const lines = readFixtureLines('stream-success');
    const withGarbage = [lines[0], '{ this is not valid json', ...lines.slice(1)];

    let parsed: ParsedLine[] = [];
    expect(() => {
      parsed = parseAll(parser, withGarbage);
    }).not.toThrow();

    const kinds = parsed.map((p) => (p.kind === 'run_event' ? p.event.type : p.kind));
    expect(kinds).toEqual(['log', 'external_ref', 'tool_call', 'progress', 'progress', 'terminal']);
  });

  it('an api_retry with a non-rate-limit error is not persisted and does not signal rate-limit', () => {
    const parser = new ClaudeStreamParser();
    const parsed = parser.parseLine(
      JSON.stringify({ type: 'system', subtype: 'api_retry', error: 'overloaded', retry_delay_ms: 500 }),
    );
    expect(parsed).toEqual([]);
  });

  it('progress sampling caps at maxProgressEvents', () => {
    const parser = new ClaudeStreamParser({ maxProgressEvents: 1 });
    const line = (text: string) =>
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    const first = parser.parseLine(line('first'));
    const second = parser.parseLine(line('second'));
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it('progress sampling honors minProgressIntervalMs via an injectable clock', () => {
    let now = 0;
    const parser = new ClaudeStreamParser({ minProgressIntervalMs: 1000, now: () => now });
    const line = (text: string) =>
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

    expect(parser.parseLine(line('a'))).toHaveLength(1);
    now = 500;
    expect(parser.parseLine(line('b'))).toHaveLength(0); // too soon
    now = 1500;
    expect(parser.parseLine(line('c'))).toHaveLength(1); // interval elapsed
  });

  it('persists assistant text in full — never truncated (feature 026, FR-003)', () => {
    const parser = new ClaudeStreamParser();
    const text = 'x'.repeat(5000);
    const parsed = parser.parseLine(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }),
    );
    expect(parsed[0].kind).toBe('run_event');
    if (parsed[0].kind === 'run_event') {
      expect(parsed[0].event.payload.message).toBe(text);
    }
  });

  it('samples progress at the raised default cap of ~100 rows (feature 026, FR-007)', () => {
    const parser = new ClaudeStreamParser();
    const line = (i: number) =>
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `t${i}` }] } });
    let kept = 0;
    for (let i = 0; i < 150; i++) kept += parser.parseLine(line(i)).length;
    expect(kept).toBe(100); // 101st..150th dropped
  });
});

describe('ClaudeStreamParser — structured tool_call payload (feature 026)', () => {
  const toolLine = (name: string, input: unknown) =>
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });

  function toolPayload(parser: ClaudeStreamParser, name: string, input: unknown) {
    const parsed = parser.parseLine(toolLine(name, input));
    expect(parsed[0].kind).toBe('run_event');
    if (parsed[0].kind !== 'run_event') throw new Error('expected run_event');
    return parsed[0].event.payload as { name: string; input: Record<string, unknown>; truncated: boolean };
  }

  it('persists input as a structured object with a truncated flag, not a JSON string', () => {
    const p = toolPayload(new ClaudeStreamParser(), 'Bash', { command: 'pnpm test', description: 'run' });
    expect(typeof p.input).toBe('object');
    expect(p.input).toMatchObject({ command: 'pnpm test', description: 'run' });
    expect(p.truncated).toBe(false);
  });

  it('elides a Write file body to a size placeholder', () => {
    const p = toolPayload(new ClaudeStreamParser(), 'Write', {
      file_path: '/a/b.ts',
      content: 'x'.repeat(34 * 1024),
    });
    expect(p.input.content).toBe('<file content, 34 KB>');
    expect(p.input.file_path).toBe('/a/b.ts');
  });

  it('keeps a human-authored details field in full and scrubs every retained string', () => {
    const scrub = (s: string) => s.replace(/SECRET/g, '[redacted]');
    const details = `SECRET ${'d'.repeat(6000)}`;
    const p = toolPayload(new ClaudeStreamParser({ scrub }), 'mcp__brigadir__request_human', {
      kind: 'question',
      title: 'T',
      details,
      blocking: true,
    });
    expect(p.input.details).toBe(`[redacted] ${'d'.repeat(6000)}`); // full, scrubbed, not cut
    expect(p.truncated).toBe(false);
  });

  it('caps a long generic field and flags truncation', () => {
    const p = toolPayload(new ClaudeStreamParser(), 'Grep', { pattern: 'p'.repeat(5000) });
    expect((p.input.pattern as string).length).toBe(2000);
    expect(p.truncated).toBe(true);
  });
});

// Token-spend problem 1: bash-guard denials (PreToolUse hook) surface as
// `user` tool_result blocks carrying the stable prefix — they become
// `tool_denied` run events; every other user/tool_result stays dropped.
describe('ClaudeStreamParser — tool_denied (bash-guard)', () => {
  // Pinned literal — must match BASH_GUARD_PREFIX in
  // packages/mcp-server/src/bash-guard-logic.ts (its spec pins it too).
  const PREFIX = '[brigadir-bash-guard]';
  const DENY_TEXT = `${PREFIX} Denied: cumulative sleep of 600s exceeds the 15s limit. …`;

  const toolUseLine = (id: string, command: string) =>
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
    });
  const toolResultLine = (id: string, content: unknown) =>
    JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content }] },
    });

  function deniedPayload(parser: ClaudeStreamParser, line: string) {
    const parsed = parser.parseLine(line);
    expect(parsed).toHaveLength(1);
    if (parsed[0].kind !== 'run_event') throw new Error('expected run_event');
    expect(parsed[0].event.type).toBe('tool_denied');
    return parsed[0].event.payload as Record<string, unknown>;
  }

  it('a denied Bash call becomes one tool_denied event carrying the command', () => {
    const parser = new ClaudeStreamParser();
    parser.parseLine(toolUseLine('tu-1', 'sleep 600'));
    const payload = deniedPayload(parser, toolResultLine('tu-1', DENY_TEXT));
    expect(payload).toMatchObject({ name: 'Bash', command: 'sleep 600', truncated: false });
    expect(String(payload.reason)).toContain(PREFIX);
  });

  it('handles tool_result content as an array of text blocks', () => {
    const parser = new ClaudeStreamParser();
    parser.parseLine(toolUseLine('tu-1', 'sleep 600'));
    const payload = deniedPayload(
      parser,
      toolResultLine('tu-1', [{ type: 'text', text: DENY_TEXT }]),
    );
    expect(payload).toMatchObject({ name: 'Bash', command: 'sleep 600' });
  });

  it('an ordinary Bash error result (no prefix) emits nothing', () => {
    const parser = new ClaudeStreamParser();
    parser.parseLine(toolUseLine('tu-1', 'exit 1'));
    expect(parser.parseLine(toolResultLine('tu-1', 'command failed: exit 1'))).toEqual([]);
  });

  it('a denial for an unknown tool_use_id still emits, without the command', () => {
    const parser = new ClaudeStreamParser();
    const payload = deniedPayload(parser, toolResultLine('tu-unknown', DENY_TEXT));
    expect(payload.name).toBe('Bash');
    expect(payload).not.toHaveProperty('command');
  });

  it('caps and scrubs the retained command, flagging truncation', () => {
    const scrub = (s: string) => s.replace(/SECRET/g, '[redacted]');
    const parser = new ClaudeStreamParser({ scrub });
    parser.parseLine(toolUseLine('tu-1', `SECRET ${'c'.repeat(5000)}`));
    const payload = deniedPayload(parser, toolResultLine('tu-1', DENY_TEXT));
    expect(String(payload.command).startsWith('[redacted]')).toBe(true);
    expect(String(payload.command).length).toBe(2000);
    expect(payload.truncated).toBe(true);
  });

  it('bounds the pending tool_use map — an evicted id loses only its command', () => {
    const parser = new ClaudeStreamParser();
    for (let i = 0; i < 60; i++) parser.parseLine(toolUseLine(`tu-${i}`, `echo ${i}`));
    const payload = deniedPayload(parser, toolResultLine('tu-0', DENY_TEXT));
    expect(payload).not.toHaveProperty('command');
  });

  it('malformed user events yield [] and never throw', () => {
    const parser = new ClaudeStreamParser();
    expect(parser.parseLine(JSON.stringify({ type: 'user' }))).toEqual([]);
    expect(parser.parseLine(JSON.stringify({ type: 'user', message: { content: 'x' } }))).toEqual([]);
    expect(
      parser.parseLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } })),
    ).toEqual([]);
  });
});
