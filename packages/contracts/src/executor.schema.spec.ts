import { describe, it, expect } from 'vitest';
import {
  ExecutorApiConfigSchema as ExecutorConfigSchema,
  ExecutorCreateRequestSchema,
  ExecutorUpdateRequestSchema,
  CLI_HARNESS_API_EXECUTOR_TYPES,
  API_KEY_ONLY_EXECUTOR_TYPES,
  isCliHarnessApiExecutorType,
  isApiKeyOnlyExecutorType,
} from './executor.schema';

/**
 * T004 (Constitution VI — typed-config validation is pipeline logic). The
 * discriminated union is the shared authority for backend validation and the
 * Vue form, so its accept/reject behavior is unit-pinned here.
 */
describe('ExecutorConfigSchema (executor typed config union)', () => {
  it('accepts a valid mock config (concurrency only)', () => {
    const parsed = ExecutorConfigSchema.safeParse({ type: 'mock', max_parallel_runs: 2 });
    expect(parsed.success).toBe(true);
  });

  it('accepts a valid claude_cli config (all fields)', () => {
    const parsed = ExecutorConfigSchema.safeParse({
      type: 'claude_cli',
      model: 'claude-opus-4-8',
      cli_path: 'claude',
      use_callback_channel: true,
      keep_failed_worktrees: false,
      max_turns: 40,
      max_parallel_runs: 2,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects repository on claude_cli — it moved to agents.behavior (platform-scoped executors)', () => {
    const parsed = ExecutorConfigSchema.safeParse({
      type: 'claude_cli',
      model: 'claude-opus-4-8',
      cli_path: 'claude',
      repository: 'api',
      use_callback_channel: true,
      keep_failed_worktrees: false,
      max_turns: 40,
      max_parallel_runs: 2,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a foreign field (mock carrying max_turns)', () => {
    const parsed = ExecutorConfigSchema.safeParse({
      type: 'mock',
      max_parallel_runs: 2,
      max_turns: 40,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects missing required claude_cli fields', () => {
    const parsed = ExecutorConfigSchema.safeParse({
      type: 'claude_cli',
      model: 'claude-opus-4-8',
      max_parallel_runs: 2,
      // cli_path, use_callback_channel, keep_failed_worktrees, max_turns missing
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown executor type', () => {
    const parsed = ExecutorConfigSchema.safeParse({ type: 'anthropic_api', max_parallel_runs: 2 });
    expect(parsed.success).toBe(false);
  });
});

/**
 * Feature 018 (T004) — auth-mode matrix from contracts/executor-auth.md.
 * The same branch drives backend 422s and the Vue form, so the per-mode
 * accept/reject behavior and the ISSUE PATHS (the form's field anchors) are
 * pinned here.
 */
describe('claude_cli auth modes (feature 018)', () => {
  const claudeConfig = (overrides: Record<string, unknown> = {}) => ({
    type: 'claude_cli',
    model: 'claude-opus-4-8',
    cli_path: 'claude',
    use_callback_channel: true,
    keep_failed_worktrees: false,
    max_turns: 40,
    max_parallel_runs: 2,
    ...overrides,
  });
  const issuePaths = (parsed: { error?: { issues: { path: PropertyKey[] }[] } }) =>
    (parsed.error?.issues ?? []).map((i) => i.path.join('.'));

  it('legacy payload without auth still validates (additive wire — SC-002)', () => {
    expect(ExecutorConfigSchema.safeParse(claudeConfig()).success).toBe(true);
    expect(ExecutorConfigSchema.safeParse(claudeConfig({ api_key: 'sk-legacy' })).success).toBe(true);
  });

  it('accepts a full bedrock config (contract example)', () => {
    const parsed = ExecutorConfigSchema.safeParse(
      claudeConfig({
        model: 'eu.anthropic.claude-opus-4-8',
        auth: 'bedrock',
        aws_region: 'eu-west-1',
        aws_profile: 'corp-dev',
        ca_bundle_path: '/etc/ssl/corp/ca-bundle.pem',
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it('accepts a region-only bedrock config (aws_profile/ca_bundle_path optional)', () => {
    const parsed = ExecutorConfigSchema.safeParse(
      claudeConfig({ auth: 'bedrock', aws_region: 'us-east-1' }),
    );
    expect(parsed.success).toBe(true);
  });

  it('bedrock without aws_region → issue at aws_region', () => {
    const parsed = ExecutorConfigSchema.safeParse(claudeConfig({ auth: 'bedrock' }));
    expect(parsed.success).toBe(false);
    expect(issuePaths(parsed)).toContain('aws_region');
  });

  it('bedrock fields are foreign to host_subscription/api_key modes and legacy payloads', () => {
    for (const auth of ['host_subscription', 'api_key', undefined] as const) {
      const base = auth === 'api_key' ? { auth, api_key: 'sk-x' } : auth ? { auth } : {};
      const parsed = ExecutorConfigSchema.safeParse(
        claudeConfig({ ...base, aws_region: 'eu-west-1' }),
      );
      expect(parsed.success).toBe(false);
      expect(issuePaths(parsed)).toContain('aws_region');
    }
  });

  it('api_key STRING is foreign to bedrock and host_subscription; null (clear) stays legal', () => {
    for (const cfg of [
      claudeConfig({ auth: 'bedrock', aws_region: 'eu-west-1', api_key: 'sk-x' }),
      claudeConfig({ auth: 'host_subscription', api_key: 'sk-x' }),
    ]) {
      const parsed = ExecutorConfigSchema.safeParse(cfg);
      expect(parsed.success).toBe(false);
      expect(issuePaths(parsed)).toContain('api_key');
    }
    expect(
      ExecutorConfigSchema.safeParse(
        claudeConfig({ auth: 'bedrock', aws_region: 'eu-west-1', api_key: null }),
      ).success,
    ).toBe(true);
    expect(
      ExecutorConfigSchema.safeParse(claudeConfig({ auth: 'host_subscription', api_key: null }))
        .success,
    ).toBe(true);
  });

  it('unknown auth value is rejected', () => {
    expect(ExecutorConfigSchema.safeParse(claudeConfig({ auth: 'iam' })).success).toBe(false);
  });

  it('CREATE with auth "api_key" requires an api_key string; UPDATE does not (stored key may exist)', () => {
    const body = { ...claudeConfig({ auth: 'api_key' }), name: 'p1' };
    const created = ExecutorCreateRequestSchema.safeParse(body);
    expect(created.success).toBe(false);
    expect(issuePaths(created)).toContain('api_key');
    expect(
      ExecutorCreateRequestSchema.safeParse({ ...body, api_key: null }).success,
    ).toBe(false);
    expect(
      ExecutorCreateRequestSchema.safeParse({ ...body, api_key: 'sk-new' }).success,
    ).toBe(true);
    // Update: omitted key keeps the stored blob (controller enforces
    // provided-OR-stored); explicit null in api_key mode is the controller's
    // 422, not the schema's.
    expect(ExecutorUpdateRequestSchema.safeParse(body).success).toBe(true);
  });

  it('bedrock create request (the portability shape) validates end-to-end', () => {
    const parsed = ExecutorCreateRequestSchema.safeParse({
      ...claudeConfig({
        model: 'eu.anthropic.claude-opus-4-8',
        auth: 'bedrock',
        aws_region: 'eu-west-1',
        aws_profile: 'corp-dev',
        ca_bundle_path: '/etc/ssl/corp/ca-bundle.pem',
      }),
      name: 'corp-bedrock',
    });
    expect(parsed.success).toBe(true);
  });
});

/**
 * Feature 025 (T006) — the kimi accept/reject matrix from
 * specs/025-kimi-executor/contracts/kimi-executor-api.md. kimi is implicitly
 * api_key-only: no auth selector, no AWS fields, no base-URL field — all
 * foreign by `.strict()`; the key is required on create.
 */
describe('kimi executor branch (feature 025)', () => {
  const kimiConfig = (overrides: Record<string, unknown> = {}) => ({
    type: 'kimi',
    model: 'kimi-k3',
    cli_path: 'claude',
    use_callback_channel: true,
    keep_failed_worktrees: false,
    max_turns: 40,
    max_parallel_runs: 2,
    ...overrides,
  });
  const issuePaths = (parsed: { error?: { issues: { path: PropertyKey[] }[] } }) =>
    (parsed.error?.issues ?? []).map((i) => i.path.join('.'));

  it('accepts a valid kimi config (harness knobs + optional write-only api_key)', () => {
    expect(ExecutorConfigSchema.safeParse(kimiConfig()).success).toBe(true);
    expect(ExecutorConfigSchema.safeParse(kimiConfig({ api_key: 'sk-moonshot' })).success).toBe(
      true,
    );
    expect(ExecutorConfigSchema.safeParse(kimiConfig({ api_key: null })).success).toBe(true);
  });

  it('rejects an auth selector — kimi has no auth modes', () => {
    for (const auth of ['api_key', 'host_subscription', 'bedrock']) {
      expect(ExecutorConfigSchema.safeParse(kimiConfig({ auth })).success).toBe(false);
    }
  });

  it('rejects the AWS/bedrock fields as foreign', () => {
    for (const field of ['aws_region', 'aws_profile', 'ca_bundle_path']) {
      expect(ExecutorConfigSchema.safeParse(kimiConfig({ [field]: 'x' })).success).toBe(false);
    }
  });

  it('rejects any base-URL-shaped field — the endpoint is a code constant, never config', () => {
    for (const field of ['base_url', 'anthropic_base_url', 'endpoint', 'url']) {
      expect(ExecutorConfigSchema.safeParse(kimiConfig({ [field]: 'https://x' })).success).toBe(
        false,
      );
    }
  });

  it('rejects repository on kimi — same platform-scoped rule as claude_cli', () => {
    expect(ExecutorConfigSchema.safeParse(kimiConfig({ repository: 'api' })).success).toBe(false);
  });

  it('CREATE requires an api_key string (omitted and null both rejected at api_key)', () => {
    const body = { ...kimiConfig(), name: 'kimi-1' };
    const omitted = ExecutorCreateRequestSchema.safeParse(body);
    expect(omitted.success).toBe(false);
    expect(issuePaths(omitted)).toContain('api_key');
    const cleared = ExecutorCreateRequestSchema.safeParse({ ...body, api_key: null });
    expect(cleared.success).toBe(false);
    expect(issuePaths(cleared)).toContain('api_key');
    expect(
      ExecutorCreateRequestSchema.safeParse({ ...body, api_key: 'sk-moonshot' }).success,
    ).toBe(true);
  });

  it('UPDATE accepts an omitted key (stored key retained; clear-to-keyless is the controller 422)', () => {
    const body = { ...kimiConfig(), name: 'kimi-1' };
    expect(ExecutorUpdateRequestSchema.safeParse(body).success).toBe(true);
    expect(ExecutorUpdateRequestSchema.safeParse({ ...body, api_key: null }).success).toBe(true);
  });
});

/**
 * Feature 028 (T004) — the deepseek_api accept/reject matrix from
 * specs/028-deepseek-executor/contracts/deepseek-executor-api.md. Same shape
 * as the kimi branch: implicitly api_key-only, no auth selector, no AWS
 * fields, no base-URL field — all foreign by `.strict()`; key required on
 * create. Plus the FR-016 shared type-set constants.
 */
describe('deepseek_api executor branch (feature 028)', () => {
  const deepseekConfig = (overrides: Record<string, unknown> = {}) => ({
    type: 'deepseek_api',
    model: 'deepseek-v4-flash',
    cli_path: 'claude',
    use_callback_channel: true,
    keep_failed_worktrees: false,
    max_turns: 40,
    max_parallel_runs: 2,
    ...overrides,
  });
  const issuePaths = (parsed: { error?: { issues: { path: PropertyKey[] }[] } }) =>
    (parsed.error?.issues ?? []).map((i) => i.path.join('.'));

  it('accepts a valid deepseek_api config (harness knobs + optional write-only api_key)', () => {
    expect(ExecutorConfigSchema.safeParse(deepseekConfig()).success).toBe(true);
    expect(ExecutorConfigSchema.safeParse(deepseekConfig({ api_key: 'sk-deepseek' })).success).toBe(
      true,
    );
    expect(ExecutorConfigSchema.safeParse(deepseekConfig({ api_key: null })).success).toBe(true);
  });

  it('rejects an auth selector — deepseek_api has no auth modes', () => {
    for (const auth of ['api_key', 'host_subscription', 'bedrock']) {
      expect(ExecutorConfigSchema.safeParse(deepseekConfig({ auth })).success).toBe(false);
    }
  });

  it('rejects the AWS/bedrock fields as foreign to deepseek_api', () => {
    for (const field of ['aws_region', 'aws_profile', 'ca_bundle_path']) {
      expect(ExecutorConfigSchema.safeParse(deepseekConfig({ [field]: 'x' })).success).toBe(false);
    }
  });

  it('rejects any base-URL-shaped field — the endpoint is a code constant, never config', () => {
    for (const field of ['base_url', 'anthropic_base_url', 'endpoint', 'url']) {
      expect(
        ExecutorConfigSchema.safeParse(deepseekConfig({ [field]: 'https://x' })).success,
      ).toBe(false);
    }
  });

  it('rejects repository on deepseek_api — same platform-scoped rule as claude_cli', () => {
    expect(ExecutorConfigSchema.safeParse(deepseekConfig({ repository: 'api' })).success).toBe(
      false,
    );
  });

  it('CREATE requires an api_key string (omitted and null both rejected at api_key)', () => {
    const body = { ...deepseekConfig(), name: 'deepseek-1' };
    const omitted = ExecutorCreateRequestSchema.safeParse(body);
    expect(omitted.success).toBe(false);
    expect(issuePaths(omitted)).toContain('api_key');
    const cleared = ExecutorCreateRequestSchema.safeParse({ ...body, api_key: null });
    expect(cleared.success).toBe(false);
    expect(issuePaths(cleared)).toContain('api_key');
    expect(
      ExecutorCreateRequestSchema.safeParse({ ...body, api_key: 'sk-deepseek' }).success,
    ).toBe(true);
  });

  it('UPDATE accepts an omitted key (stored key retained; clear-to-keyless is the controller 422)', () => {
    const body = { ...deepseekConfig(), name: 'deepseek-1' };
    expect(ExecutorUpdateRequestSchema.safeParse(body).success).toBe(true);
    expect(ExecutorUpdateRequestSchema.safeParse({ ...body, api_key: null }).success).toBe(true);
  });

  it('FR-016: the shared type-set constants carry exactly the documented membership', () => {
    expect([...CLI_HARNESS_API_EXECUTOR_TYPES]).toEqual(['claude_cli', 'kimi', 'deepseek_api']);
    expect([...API_KEY_ONLY_EXECUTOR_TYPES]).toEqual(['kimi', 'deepseek_api']);
    expect(isCliHarnessApiExecutorType('deepseek_api')).toBe(true);
    expect(isCliHarnessApiExecutorType('mock')).toBe(false);
    expect(isApiKeyOnlyExecutorType('deepseek_api')).toBe(true);
    expect(isApiKeyOnlyExecutorType('claude_cli')).toBe(false);
  });
});
