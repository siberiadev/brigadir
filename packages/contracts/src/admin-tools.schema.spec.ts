import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AdminTools, CreateTeamInputSchema, CreateWorkspaceResultSchema } from './admin-tools.schema';
import { TeamAgentSchema } from './report.schema';

/**
 * Contract tests for the admin MCP tool schemas (feature 012). Every tool
 * declares an input AND an output schema; both must convert cleanly to draft-07
 * JSON Schema (the wire dialect fed to MCP clients) and carry the descriptions
 * the model relies on. Cross-field rules live in the backend (422), so we assert
 * only shape/convertibility here — not runtime refinements.
 */
describe('AdminTools schemas (feature 012)', () => {
  const names = Object.keys(AdminTools) as (keyof typeof AdminTools)[];

  it('exposes the admin tools (v1 nine + feature 030 source setter)', () => {
    expect(names.sort()).toEqual(
      [
        'create_agent',
        'create_team',
        'create_workspace',
        'generate_agents',
        'get_board_statuses',
        'get_workspace',
        'list_agents',
        'list_executors',
        'list_workspaces',
        'update_agent',
        'set_agent_instructions_source',
      ].sort(),
    );
  });

  it('every input and output schema converts to draft-07 JSON Schema without throwing', () => {
    for (const name of names) {
      const { input, output } = AdminTools[name];
      const inJson = z.toJSONSchema(input, { target: 'draft-7' }) as Record<string, unknown>;
      const outJson = z.toJSONSchema(output, { target: 'draft-7' }) as Record<string, unknown>;
      expect(inJson).toBeTypeOf('object');
      expect(outJson).toBeTypeOf('object');
      // draft-07 object schemas
      expect(inJson.type).toBe('object');
      expect(outJson.type).toBe('object');
    }
  });

  it('every tool carries a non-empty human description', () => {
    for (const name of names) {
      expect(AdminTools[name].description.length).toBeGreaterThan(20);
    }
  });

  it('create_workspace/create_team input schemas are strict (reject foreign fields)', () => {
    const badWs = AdminTools.create_workspace.input.safeParse({
      name: 'x',
      jira_site_url: 'https://acme.atlassian.net',
      board: '42',
      expires_at: '2027-07-12T00:00:00.000Z',
      // secrets must NOT be accepted as tool arguments (Principle V):
      jira_api_token: 'attacker-supplied',
    });
    expect(badWs.success).toBe(false);
  });

  it('create_team input reuses TeamAgentSchema and bounds the roster 1..20', () => {
    // A single valid agent parses.
    const agent = {
      name: 'Developer',
      description: 'Implements tickets.',
      instruction: 'You are Developer.',
      trigger_status: 'Ready for Dev',
      status_success: 'Code Review',
      status_failure: 'Blocked',
      executor: 'mock',
    };
    expect(TeamAgentSchema.safeParse(agent).success).toBe(true);
    expect(CreateTeamInputSchema.safeParse({ workspace_id: crypto.randomUUID(), agents: [agent] }).success).toBe(true);
    // Empty roster is rejected (min 1).
    expect(CreateTeamInputSchema.safeParse({ workspace_id: crypto.randomUUID(), agents: [] }).success).toBe(false);
    // 21 agents is rejected (max 20).
    const many = Array.from({ length: 21 }, (_, i) => ({ ...agent, name: `A${i}` }));
    expect(CreateTeamInputSchema.safeParse({ workspace_id: crypto.randomUUID(), agents: many }).success).toBe(false);
  });

  it('create_workspace output pins enabled to literal false (workspaces are created paused)', () => {
    expect(CreateWorkspaceResultSchema.safeParse({ workspace_id: 'w', project_key: 'BRIG', board_type: 'kanban', enabled: false }).success).toBe(true);
    expect(CreateWorkspaceResultSchema.safeParse({ workspace_id: 'w', project_key: 'BRIG', board_type: 'kanban', enabled: true }).success).toBe(false);
    // The JSON Schema encodes the constant too.
    const json = z.toJSONSchema(CreateWorkspaceResultSchema, { target: 'draft-7' }) as {
      properties: { enabled: { const?: unknown; enum?: unknown[] } };
    };
    const enabled = json.properties.enabled;
    expect(enabled.const === false || (Array.isArray(enabled.enum) && enabled.enum.length === 1 && enabled.enum[0] === false)).toBe(true);
  });

  it('input schemas carry field descriptions (surfaced to the model)', () => {
    const json = z.toJSONSchema(AdminTools.create_workspace.input, { target: 'draft-7' }) as {
      properties: Record<string, { description?: string }>;
    };
    expect(json.properties.board.description).toBeTruthy();
    expect(json.properties.expires_at.description).toContain('Jira');
  });
});
