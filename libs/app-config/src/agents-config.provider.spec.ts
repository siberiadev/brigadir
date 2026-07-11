import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { loadAgentsConfig, AgentsConfigError } from './agents-config.provider';

const FIX = (name: string): string => join(process.cwd(), 'test', 'fixtures', name);

describe('loadAgentsConfig — fail-fast provider (T015)', () => {
  it('loads and validates a good config, applying schema defaults', () => {
    const cfg = loadAgentsConfig(FIX('agents.valid.yaml'));
    expect(cfg.workspace.project_key).toBe('BRIG');
    expect(cfg.executors['mock-exec'].type).toBe('mock');
    expect(cfg.agents).toHaveLength(1);
    // schema default applied
    expect(cfg.agents[0].timeout_minutes).toBe(45);
    expect(cfg.agents[0].max_attempts).toBe(2);
  });

  it('throws naming the file path when the file is missing', () => {
    let err: unknown;
    try {
      loadAgentsConfig(FIX('does-not-exist.yaml'));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AgentsConfigError);
    expect((err as Error).message).toContain('does-not-exist.yaml');
  });

  it('throws with the offending field path on a missing required field', () => {
    const run = (): void => void loadAgentsConfig(FIX('broken-missing-field.yaml'));
    expect(run).toThrow(AgentsConfigError);
    expect(run).toThrow(/broken-missing-field\.yaml/);
    expect(run).toThrow(/agents\.0\.status_success/);
  });

  it('throws with the offending field path on a wrong-type field', () => {
    const run = (): void => void loadAgentsConfig(FIX('broken-wrong-type.yaml'));
    expect(run).toThrow(/broken-wrong-type\.yaml/);
    expect(run).toThrow(/executors\.mock-exec\.concurrency/);
  });

  it('throws with the cross-ref path on a dangling executor reference', () => {
    const run = (): void => void loadAgentsConfig(FIX('broken-dangling-executor.yaml'));
    expect(run).toThrow(/broken-dangling-executor\.yaml/);
    expect(run).toThrow(/agents\.0\.executor/);
    expect(run).toThrow(/unknown executor "clod-sub"/);
  });

  it('throws a YAML parse error naming the file on an unparseable config', () => {
    const run = (): void => void loadAgentsConfig(FIX('broken-unparseable.yaml'));
    expect(run).toThrow(AgentsConfigError);
    expect(run).toThrow(/broken-unparseable\.yaml/);
    expect(run).toThrow(/not valid YAML/);
  });
});
