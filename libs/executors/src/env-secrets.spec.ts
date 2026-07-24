import { describe, it, expect } from 'vitest';
import { SecretBoxError } from '@brigadir/jira';
import {
  sealEnvSecrets,
  openEnvSecrets,
  envSecretKeys,
  type EnvSecretsDocument,
} from './env-secrets';

// A deterministic 32-byte key so the codec never depends on host env.
const KEY = Buffer.alloc(32, 7);

describe('env-secrets codec (feature 031)', () => {
  it('round-trips a full three-scope document', () => {
    const doc: EnvSecretsDocument = {
      workspace: { WS_SECRET: 'a' },
      repos: { 'repo-1': { DATABASE_URL: 'postgres://u:p@h/db' } },
      agents: { 'agent-1': { QA_TOKEN: 'xyz' } },
    };
    const blob = sealEnvSecrets(doc, KEY);
    expect(openEnvSecrets(blob, KEY)).toEqual(doc);
  });

  it('opens an empty document to {}', () => {
    const blob = sealEnvSecrets({}, KEY);
    expect(openEnvSecrets(blob, KEY)).toEqual({});
  });

  it('throws SecretBoxError on tamper', () => {
    const blob = sealEnvSecrets({ workspace: { A: 'b' } }, KEY);
    blob[blob.length - 1] ^= 0xff;
    expect(() => openEnvSecrets(blob, KEY)).toThrow(SecretBoxError);
  });

  it('throws SecretBoxError on wrong key', () => {
    const blob = sealEnvSecrets({ workspace: { A: 'b' } }, KEY);
    expect(() => openEnvSecrets(blob, Buffer.alloc(32, 9))).toThrow(SecretBoxError);
  });

  it('projects names-only view without leaking values', () => {
    const doc: EnvSecretsDocument = {
      workspace: { WS: '1' },
      repos: { r1: { DB: 'secret', PORT_PW: 'secret' } },
      agents: { a1: { T: 'secret' } },
    };
    const keys = envSecretKeys(doc);
    expect(keys).toEqual({
      workspace: ['WS'],
      repos: { r1: ['DB', 'PORT_PW'] },
      agents: { a1: ['T'] },
    });
    expect(JSON.stringify(keys)).not.toContain('secret');
  });

  it('projects empty scopes to stable empty shapes', () => {
    expect(envSecretKeys({})).toEqual({ workspace: [], repos: {}, agents: {} });
  });
});
