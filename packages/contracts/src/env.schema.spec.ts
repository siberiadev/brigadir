import { describe, it, expect } from 'vitest';
import { EnvMapSchema } from './env.schema';
import {
  isReservedEnvKey,
  ENV_VALUE_MAX_BYTES,
  ENV_TOTAL_MAX_BYTES,
} from './env.constants';

describe('isReservedEnvKey', () => {
  it('flags exact reserved names and reserved prefixes', () => {
    expect(isReservedEnvKey('PATH')).toBe(true);
    expect(isReservedEnvKey('SSH_AUTH_SOCK')).toBe(true);
    expect(isReservedEnvKey('ANTHROPIC_API_KEY')).toBe(true);
    expect(isReservedEnvKey('AWS_SECRET_ACCESS_KEY')).toBe(true);
    expect(isReservedEnvKey('CLAUDE_CODE_USE_BEDROCK')).toBe(true);
    expect(isReservedEnvKey('FAKE_CLAUDE_FIXTURE')).toBe(true);
    expect(isReservedEnvKey('BRIGADIR_DASHBOARD_TOKEN')).toBe(true);
  });
  it('allows ordinary service keys', () => {
    expect(isReservedEnvKey('DATABASE_URL')).toBe(false);
    expect(isReservedEnvKey('PORT')).toBe(false);
    expect(isReservedEnvKey('NODE_ENV')).toBe(false);
  });
});

describe('EnvMapSchema', () => {
  it('accepts valid keys and values, including an empty value', () => {
    const r = EnvMapSchema.safeParse({ NODE_ENV: 'test', EMPTY: '', PORT: '3100' });
    expect(r.success).toBe(true);
  });

  it('rejects a malformed key and names it', () => {
    const r = EnvMapSchema.safeParse({ '2FOO': 'x' });
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain('2FOO');
  });

  it('rejects a reserved key and names it', () => {
    const r = EnvMapSchema.safeParse({ ANTHROPIC_API_KEY: 'x' });
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain('ANTHROPIC_API_KEY');
  });

  it('rejects a value over the per-value byte cap', () => {
    const r = EnvMapSchema.safeParse({ BLOB: 'a'.repeat(ENV_VALUE_MAX_BYTES + 1) });
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain('BLOB');
  });

  it('rejects a scope whose merged size exceeds the total cap', () => {
    const map: Record<string, string> = {};
    // ~10 values of ~8KB each ⇒ ~80KB > 64KB total.
    for (let i = 0; i < 10; i++) map[`K${i}`] = 'a'.repeat(ENV_VALUE_MAX_BYTES - 100);
    const r = EnvMapSchema.safeParse(map);
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain(String(ENV_TOTAL_MAX_BYTES));
  });
});
