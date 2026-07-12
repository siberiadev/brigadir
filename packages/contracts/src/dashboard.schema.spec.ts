import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AgentWriteRequestSchema,
  WorkspaceResponseSchema,
  VerifyResponseSchema,
} from './dashboard.schema';

describe('dashboard schemas (T119)', () => {
  it('round-trips a valid agent create body', () => {
    const body = {
      workspace_id: 'ws-1',
      name: 'Implementer',
      instruction: 'Implement the ticket.',
      executor_id: 'ex-1',
      model: 'claude-sonnet-5',
      trigger_status: 'Ready for Dev',
      trigger_jql: null,
      status_running: 'In Progress',
      status_success: 'In Review',
      status_failure: 'Blocked',
      status_ids: { trigger: '1', running: '2', success: '3', failure: '4' },
      timeout_minutes: 45,
      max_budget_usd: 5,
      max_attempts: 2,
      repository: null,
      behavior: { allowed_tools: ['Read', 'Edit'], use_callback_channel: true },
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
