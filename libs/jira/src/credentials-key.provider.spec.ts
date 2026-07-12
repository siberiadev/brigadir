import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { resolveCredentialsKey, CredentialsKeyMissingError } from './credentials-key.provider';

describe('resolveCredentialsKey (T122)', () => {
  it('resolves a 32-byte base64 value to a 32-byte Buffer', () => {
    const b64 = randomBytes(32).toString('base64');
    const key = resolveCredentialsKey(b64);
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });

  it('resolves a 64-char hex value to a 32-byte Buffer', () => {
    const hex = randomBytes(32).toString('hex');
    expect(resolveCredentialsKey(hex).length).toBe(32);
  });

  it('throws for a 16-byte value', () => {
    const short = randomBytes(16).toString('base64');
    expect(() => resolveCredentialsKey(short)).toThrow(CredentialsKeyMissingError);
  });

  it('throws CredentialsKeyMissingError for an absent value', () => {
    expect(() => resolveCredentialsKey(undefined)).toThrow(CredentialsKeyMissingError);
    expect(() => resolveCredentialsKey('')).toThrow(CredentialsKeyMissingError);
  });
});
