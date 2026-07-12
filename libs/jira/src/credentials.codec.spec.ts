import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encodeJiraCredentials, decodeJiraCredentials } from './credentials.codec';
import { CredentialsKeyMissingError } from './credentials-key.provider';
import { JiraAuthError } from './jira.errors';

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
const creds = { email: 'bot@acme.com', api_token: 'super-secret-token-value' };

describe('credentials codec — AES-256-GCM (T124)', () => {
  const savedEnv = process.env.BRIGADIR_CREDENTIALS_KEY;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.BRIGADIR_CREDENTIALS_KEY;
    else process.env.BRIGADIR_CREDENTIALS_KEY = savedEnv;
  });

  it('round-trips: decode(encode(c)) === c', () => {
    const blob = encodeJiraCredentials(creds, KEY);
    expect(decodeJiraCredentials(blob, KEY)).toEqual(creds);
  });

  it('envelope: starts 0x01, length >= 29, and is not human-readable', () => {
    const blob = encodeJiraCredentials(creds, KEY);
    expect(blob[0]).toBe(0x01);
    expect(blob.length).toBeGreaterThanOrEqual(1 + 12 + 16);
    const asText = blob.toString('utf8');
    expect(asText.includes('bot@acme.com')).toBe(false);
    expect(asText.includes('super-secret-token-value')).toBe(false);
  });

  it('tamper: flipping one ciphertext byte → decrypt throws', () => {
    const blob = encodeJiraCredentials(creds, KEY);
    blob[blob.length - 1] ^= 0xff; // last ciphertext byte
    expect(() => decodeJiraCredentials(blob, KEY)).toThrow(JiraAuthError);
  });

  it('wrong key: decrypt with a different 32-byte key throws', () => {
    const blob = encodeJiraCredentials(creds, KEY);
    expect(() => decodeJiraCredentials(blob, OTHER_KEY)).toThrow(JiraAuthError);
  });

  it('format-sniff: a legacy plaintext {…} blob decodes WITHOUT a key, re-encode → 0x01', () => {
    const legacy = Buffer.from(JSON.stringify(creds), 'utf8');
    expect(legacy[0]).toBe(0x7b); // '{'
    // No key needed on the legacy path (env unset to prove it).
    delete process.env.BRIGADIR_CREDENTIALS_KEY;
    expect(decodeJiraCredentials(legacy)).toEqual(creds);
    const reencoded = encodeJiraCredentials(creds, KEY);
    expect(reencoded[0]).toBe(0x01);
  });

  it('missing-key fail-fast: encode + encrypted-decode with the key unset throw CredentialsKeyMissingError', () => {
    delete process.env.BRIGADIR_CREDENTIALS_KEY;
    expect(() => encodeJiraCredentials(creds)).toThrow(CredentialsKeyMissingError);
    const blob = encodeJiraCredentials(creds, KEY); // encrypt with explicit key
    expect(() => decodeJiraCredentials(blob)).toThrow(CredentialsKeyMissingError);
  });

  it('placeholder: the iteration-1 placeholder bytes still throw JiraAuthError', () => {
    const placeholder = Buffer.from('placeholder-jira-credentials');
    expect(() => decodeJiraCredentials(placeholder, KEY)).toThrow(JiraAuthError);
  });
});
