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

  it('truncates an oversized snippet to snippetMaxChars', () => {
    const parser = new ClaudeStreamParser({ snippetMaxChars: 10 });
    const parsed = parser.parseLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'x'.repeat(100) }] },
      }),
    );
    expect(parsed[0].kind).toBe('run_event');
    if (parsed[0].kind === 'run_event') {
      expect((parsed[0].event.payload.message as string).length).toBe(10);
    }
  });
});
