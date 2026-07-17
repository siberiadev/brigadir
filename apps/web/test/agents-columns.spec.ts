import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './server';
import { mountWithProviders, flush } from './mount';
import { paginated, sampleAgent, sampleAgentWithRole, sampleExecutors } from './handlers';
import AgentsList from '../src/views/AgentsList.vue';

/**
 * Feature 016 (US3/US4) — Agents table columns. The Name column carries the
 * persona name alone (the "Name (role)" suffix is gone); the role moved into
 * its own tagged column; the new Executor column resolves `executor_id` to the
 * executor PROFILE NAME via the platform executors list, never showing the raw
 * id. Absent role / unresolvable executor → genuinely empty cells.
 */

async function mountAgents() {
  server.use(
    http.get('/api/agents', () =>
      // Vera: role 'reviewer' + resolvable executor 'ex-claude' (named 'claude').
      // Implementer: no role + dangling executor_id 'ex-1' (matches no profile).
      HttpResponse.json(paginated([sampleAgentWithRole, sampleAgent])),
    ),
  );
  const wrapper = mountWithProviders(AgentsList, { props: { id: 'ws-1' } });
  await flush();
  return wrapper;
}

function tableCells(wrapper: Awaited<ReturnType<typeof mountAgents>>) {
  const headers = wrapper.findAll('[data-test="agents-table"] th').map((th) => th.text());
  const rows = wrapper.findAll('[data-test="agents-table"] .el-table__row');
  return {
    headers,
    cell: (row: number, label: string) => rows[row].findAll('td')[headers.indexOf(label)],
    rows,
  };
}

describe('AgentsList — Name/Role split + Executor column', () => {
  it('shows the persona name alone and the role as a separate tag column', async () => {
    const wrapper = await mountAgents();
    const { headers, cell } = tableCells(wrapper);

    expect(headers).toContain('Role');
    // The Name cell is exactly the persona name — no "(reviewer)" suffix.
    expect(cell(0, 'Name').text().trim()).toBe('Vera');
    const tag = cell(0, 'Role').find('.el-tag');
    expect(tag.exists()).toBe(true);
    expect(tag.text()).toBe('reviewer');
  });

  it('a role-less agent gets an empty Role cell — no tag, no placeholder', async () => {
    const wrapper = await mountAgents();
    const { cell } = tableCells(wrapper);

    expect(cell(1, 'Name').text().trim()).toBe('Implementer');
    expect(cell(1, 'Role').find('.el-tag').exists()).toBe(false);
    expect(cell(1, 'Role').text().trim()).toBe('');
  });

  it('keeps the Key column as is', async () => {
    const wrapper = await mountAgents();
    const { cell } = tableCells(wrapper);

    expect(cell(0, 'Key').find('[data-test="agent-key"]').text()).toBe('reviewer');
    expect(cell(1, 'Key').find('[data-test="agent-key"]').text()).toBe('implementer');
  });

  it('resolves executor_id to the executor profile name, never the raw id', async () => {
    const wrapper = await mountAgents();
    const { headers, cell } = tableCells(wrapper);

    expect(headers).toContain('Executor');
    const claude = sampleExecutors.find((e) => e.id === sampleAgentWithRole.executor_id)!;
    expect(cell(0, 'Executor').text().trim()).toBe(claude.name);
    // The raw executor UUID/id never appears anywhere in the table.
    expect(wrapper.find('[data-test="agents-table"]').text()).not.toContain('ex-claude');
  });

  it('an unresolvable executor_id yields an empty Executor cell while the row still renders', async () => {
    const wrapper = await mountAgents();
    const { cell } = tableCells(wrapper);

    // 'ex-1' matches no executor profile fixture.
    expect(cell(1, 'Executor').text().trim()).toBe('');
    expect(cell(1, 'Name').text().trim()).toBe('Implementer');
    expect(wrapper.find('[data-test="agents-table"]').text()).not.toContain('ex-1');
  });

  it('renders all Executor cells empty when the executors lookup fails, without breaking the table', async () => {
    server.use(http.get('/api/executors', () => HttpResponse.error()));
    const wrapper = await mountAgents();
    const { cell, rows } = tableCells(wrapper);

    expect(rows).toHaveLength(2);
    expect(cell(0, 'Executor').text().trim()).toBe('');
    expect(cell(0, 'Name').text().trim()).toBe('Vera');
  });
});
