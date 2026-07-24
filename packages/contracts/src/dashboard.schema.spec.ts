import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AgentWriteRequestSchema,
  WorkspaceResponseSchema,
  WorkspaceSettingsRequestSchema,
  VerifyResponseSchema,
} from './dashboard.schema';

describe('dashboard schemas (T119)', () => {
  it('round-trips a valid agent create body', () => {
    const body = {
      workspace_id: 'ws-1',
      name: 'Implementer',
      instruction: 'Implement the ticket.',
      executor_id: 'ex-1',
      // NO model field — the executor profile's model is the single source of
      // truth (named runner profiles, 2026-07-14).
      trigger_status: 'Ready for Dev',
      trigger_jql: null,
      status_running: 'In Progress',
      status_success: 'In Review',
      status_failure: 'Blocked',
      status_ids: { trigger: '1', running: '2', success: '3', failure: '4' },
      timeout_minutes: 45,
      max_budget_usd: 5,
      max_attempts: 2,
      // repository lives in behavior now (platform-scoped executors, 2026-07-13)
      behavior: { allowed_tools: ['Read', 'Edit'], use_callback_channel: true, repository: 'api' },
    };
    const res = AgentWriteRequestSchema.safeParse(body);
    expect(res.success).toBe(true);
  });

  it('rejects a malformed agent body (missing status_success) with a path-qualified issue', () => {
    const res = AgentWriteRequestSchema.safeParse({
      workspace_id: 'ws-1',
      name: 'Implementer',
      instruction: 'x',
      executor_id: 'ex-1',
      trigger_status: 'Ready for Dev',
      status_failure: 'Blocked',
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.includes('status_success'))).toBe(true);
    }
  });

  it('parses a valid workspace response with the additive read-only fields (008/FR-014)', () => {
    const base = {
      id: 'ws-1',
      name: 'Acme',
      jira_site_url: 'https://acme.atlassian.net',
      project_key: 'BRIG',
      board_id: 42,
      board_type: 'kanban' as const,
      expires_at: '2027-07-12T00:00:00.000Z',
      credential_status: 'ok' as const,
      repositories: [],
      // Feature 031 additive fields (env defaults + names-only secret view).
      env: {},
      env_secret_keys: { workspace: [], repos: {}, agents: {} },
      bot_email: 'bot@acme.io',
      branch_prefix: 'feature',
      scope_jql: 'labels = ai',
      enabled: true,
      ticket_scoping: false,
      // Feature 030 additive fields (agent role-template source).
      agent_instructions: null,
      has_agent_instructions_token: false,
      effective_instructions_level: 'builtin' as const,
      created_at: '2026-07-12T00:00:00.000Z',
      updated_at: '2026-07-12T00:00:00.000Z',
    };
    const ok = WorkspaceResponseSchema.safeParse(base);
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.bot_email).toBe('bot@acme.io');
      expect(ok.data.branch_prefix).toBe('feature');
      expect(ok.data.scope_jql).toBe('labels = ai');
      // The shape has NO credential key (Principle V).
      expect('api_token' in ok.data).toBe(false);
      expect('jira_api_token' in ok.data).toBe(false);
    }

    // Legacy rows (created before prefix/scope were persisted, or an undecodable
    // credential blob) surface `null` for all three — never a default injection.
    const legacy = WorkspaceResponseSchema.safeParse({
      ...base,
      bot_email: null,
      branch_prefix: null,
      scope_jql: null,
    });
    expect(legacy.success).toBe(true);
  });


  it('ticket_scoping (feature 020, D2b): optional on the settings PUT, required boolean on the response', () => {
    // Absent ⇒ unchanged (merge-patch): the PUT body parses without the key.
    expect(WorkspaceSettingsRequestSchema.safeParse({}).success).toBe(true);
    const on = WorkspaceSettingsRequestSchema.safeParse({ ticket_scoping: true });
    expect(on.success).toBe(true);
    if (on.success) expect(on.data.ticket_scoping).toBe(true);
    // .strict() still rejects unknown keys.
    expect(WorkspaceSettingsRequestSchema.safeParse({ ticket_scopingg: true }).success).toBe(false);
    // Non-boolean rejected.
    expect(WorkspaceSettingsRequestSchema.safeParse({ ticket_scoping: 'yes' }).success).toBe(false);
  });

  it('the Workspace/Verify response schemas never expose credentials', () => {
    // Structural guarantee: parsing strips unknown keys / rejects extras.
    const ws = WorkspaceResponseSchema.safeParse({
      id: 'ws-1',
      name: 'Acme',
      jira_site_url: 'https://acme.atlassian.net',
      project_key: 'BRIG',
      board_id: 42,
      board_type: 'kanban',
      expires_at: '2027-07-12T00:00:00.000Z',
      credential_status: 'ok',
      repositories: [],
      created_at: '2026-07-12T00:00:00.000Z',
      updated_at: '2026-07-12T00:00:00.000Z',
      jira_api_token: 'leak', // strict() → must be rejected
    });
    expect(ws.success).toBe(false);
    expect(VerifyResponseSchema.safeParse({
      bot_display_name: 'Bot',
      project_key: 'BRIG',
      board_id: 42,
      board_type: 'kanban',
    }).success).toBe(true);
  });

  it('no response schema in dashboard.schema.ts references jira_credentials/api_token', () => {
    const src = readFileSync(join(__dirname, 'dashboard.schema.ts'), 'utf8');
    // Requests carry jira_api_token (write-only); assert no *Response* schema does.
    const responseBlocks = src
      .split('\n')
      .filter((l) => /Response/.test(l) && /Schema/.test(l));
    for (const line of responseBlocks) {
      expect(line.includes('api_token')).toBe(false);
      expect(line.includes('jira_credentials')).toBe(false);
    }
  });
});
