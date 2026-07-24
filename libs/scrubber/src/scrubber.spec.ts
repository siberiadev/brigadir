import { describe, it, expect } from 'vitest';
import { scrub, makeScrub, REDACTED } from './scrubber';

describe('scrub (T098, FR-024)', () => {
  it('redacts an ANTHROPIC_API_KEY-shaped secret', () => {
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    const out = scrub(`Set ANTHROPIC_API_KEY=${secret} before running.`);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  it('redacts a ghp_-shaped GitHub token', () => {
    const secret = 'ghp_' + 'a'.repeat(36) + '1234';
    const out = scrub(`token: ${secret}`);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  it('redacts an AWS-access-key-id-shaped string', () => {
    const secret = 'AKIAABCDEFGHIJKLMNOP';
    const out = scrub(`aws key is ${secret} in the config`);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  it('redacts a random 40-char high-entropy string via the entropy heuristic', () => {
    const secret = 'Xk9mPqR7vT2wZ5bN8cL4hJ6yU1gF3aQdEsWnMoIp';
    const out = scrub(`leaked value: ${secret} end`);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  it('redacts a JWT-shaped bearer token', () => {
    const secret =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJydW4tMSIsImV4cCI6MTIzfQ.c2lnbmF0dXJlLWJ5dGVzLWhlcmU';
    const out = scrub(`Authorization: Bearer ${secret}`);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  it('leaves ordinary prose intact', () => {
    const text = 'Implemented the OAuth login flow and wired the handler to the new endpoint.';
    expect(scrub(text)).toBe(text);
  });

  it('leaves code identifiers intact', () => {
    const text = 'Renamed resolveClaudeCliConfig to buildRuntimeConfigFromExecutorRow across the module.';
    expect(scrub(text)).toBe(text);
  });

  it('does not false-positive redact a URL without a secret', () => {
    const text = 'See https://example.com/BRIG-123 for details.';
    expect(scrub(text)).toBe(text);
  });

  it('scrubs multiple planted secrets in one corpus with zero leaks', () => {
    const apiKey = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    const ghToken = 'ghp_' + 'b'.repeat(40);
    const awsKey = 'AKIAZZZZZZZZZZZZZZZZ';
    const entropyBlob = 'Qw8eRt3yUiOp5aSdFgHj7kLzXcVbNm2QwErTyUiOpAsDf';
    const corpus = [
      `summary: fixed auth using ${apiKey}`,
      `reason: pushed with token ${ghToken}`,
      `details: rotate ${awsKey} and this blob ${entropyBlob}`,
      'Ordinary sentence describing the change with no secrets at all.',
    ].join('\n');

    const out = scrub(corpus);
    for (const secret of [apiKey, ghToken, awsKey, entropyBlob]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('Ordinary sentence describing the change with no secrets at all.');
  });
});

describe('makeScrub (feature 031 — per-run literal redaction)', () => {
  it('redacts a short low-entropy secret the global scrubber would miss', () => {
    const password = 's3cretpw';
    // The global scrubber leaves this dictionary-ish value alone...
    expect(scrub(`connecting with ${password}`)).toContain(password);
    // ...but a run-scoped scrub built from the actual value redacts it.
    const runScrub = makeScrub([password]);
    const out = runScrub(`connecting with ${password} now`);
    expect(out).not.toContain(password);
    expect(out).toContain(REDACTED);
    expect(out).toContain('connecting with');
  });

  it('redacts a value embedded inside a connection string', () => {
    const secret = 'p@ss w:rd/123';
    const runScrub = makeScrub([secret]);
    const out = runScrub(`DATABASE_URL=postgres://user:${secret}@host:5432/db`);
    expect(out).not.toContain(secret);
  });

  it('still delegates to the global scrubber for pattern/entropy secrets', () => {
    const apiKey = 'sk-ant-api03-' + 'z'.repeat(40);
    const runScrub = makeScrub(['unrelated']);
    expect(runScrub(`key ${apiKey}`)).not.toContain(apiKey);
  });

  it('ignores literals shorter than 4 chars (too collision-prone)', () => {
    const runScrub = makeScrub(['ab', '']);
    expect(runScrub('ab cd ab')).toBe('ab cd ab');
  });

  it('returns the global scrub function when there are no usable literals', () => {
    expect(makeScrub([])).toBe(scrub);
    expect(makeScrub(['xy'])).toBe(scrub); // all filtered out
  });

  it('fully masks a secret that contains a shorter secret as a substring', () => {
    const shortS = 'token123';
    const longS = 'token1234567';
    const runScrub = makeScrub([shortS, longS]);
    const out = runScrub(`a=${longS} b=${shortS}`);
    expect(out).not.toContain(shortS);
    expect(out).not.toContain(longS);
  });
});
