import { describe, it, expect } from 'vitest';
import { serializeBulkEnv, computeBulkResult, SECRET_MASK } from '../src/components/BulkEnvEditor/bulk-env';

describe('serializeBulkEnv', () => {
  it('writes plaintext KEY=value lines then masked secret lines', () => {
    const text = serializeBulkEnv({ PORT: '3100', NODE_ENV: 'test' }, ['DATABASE_URL']);
    expect(text).toBe(`PORT=3100\nNODE_ENV=test\nDATABASE_URL=${SECRET_MASK}`);
  });

  it('quotes values with spaces so they round-trip', () => {
    const text = serializeBulkEnv({ MSG: 'hello world' }, []);
    expect(text).toBe('MSG="hello world"');
    expect(computeBulkResult(text, []).plainEnv.MSG).toBe('hello world');
  });
});

describe('computeBulkResult — plaintext', () => {
  it('parses KEY=value, comments, blank lines and export prefix', () => {
    const r = computeBulkResult('# comment\n\nexport PORT=3100\nNODE_ENV=test\n', []);
    expect(r.errors).toEqual([]);
    expect(r.plainEnv).toEqual({ PORT: '3100', NODE_ENV: 'test' });
  });

  it('strips one matching quote layer', () => {
    const r = computeBulkResult(`A="quoted"\nB='single'`, []);
    expect(r.plainEnv).toEqual({ A: 'quoted', B: 'single' });
  });

  it('last value wins on a duplicate key', () => {
    expect(computeBulkResult('K=1\nK=2', []).plainEnv).toEqual({ K: '2' });
  });

  it('reports a line for a missing =, an invalid name, and a reserved key', () => {
    const r = computeBulkResult('NOEQUALS\n2BAD=x\nPATH=/evil', []);
    expect(r.errors.map((e) => e.line)).toEqual([1, 2, 3]);
    expect(r.errors[2].message).toContain('PATH');
    expect(r.plainEnv).toEqual({}); // nothing valid landed
  });

  it('rejects an oversized value with a line number', () => {
    const r = computeBulkResult(`BIG=${'a'.repeat(8 * 1024 + 1)}`, []);
    expect(r.errors[0].message).toContain('8 KB');
  });
});

describe('computeBulkResult — secrets (DigitalOcean-style mask round-trip)', () => {
  it('keeps an untouched masked secret (no op)', () => {
    const r = computeBulkResult(`API_TOKEN=${SECRET_MASK}`, ['API_TOKEN']);
    expect(r.secretSet).toEqual({});
    expect(r.secretDelete).toEqual([]);
    expect(r.plainEnv).toEqual({});
  });

  it('re-seals a secret whose masked value was changed', () => {
    const r = computeBulkResult('API_TOKEN=new-value', ['API_TOKEN']);
    expect(r.secretSet).toEqual({ API_TOKEN: 'new-value' });
    expect(r.secretDelete).toEqual([]);
  });

  it('deletes a secret whose line was removed', () => {
    const r = computeBulkResult('PORT=3100', ['API_TOKEN']);
    expect(r.secretDelete).toEqual(['API_TOKEN']);
    expect(r.plainEnv).toEqual({ PORT: '3100' });
  });

  it('handles a mixed edit: keep one secret, change another, add plaintext, drop a plaintext', () => {
    const text = [
      `KEEP=${SECRET_MASK}`, // unchanged secret
      'ROTATE=fresh', // changed secret
      'PORT=3100', // new plaintext
    ].join('\n');
    const r = computeBulkResult(text, ['KEEP', 'ROTATE', 'GONE']);
    expect(r.secretSet).toEqual({ ROTATE: 'fresh' });
    expect(r.secretDelete).toEqual(['GONE']);
    expect(r.plainEnv).toEqual({ PORT: '3100' });
    expect(r.errors).toEqual([]);
  });
});
