import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { AgentListResponse } from '@brigadir/contracts';
import { server } from './server';
import { mountWithProviders, flush } from './mount';
import { paginated, sampleAgent } from './handlers';
import ResumeAgentPicker from '../src/components/ResumeAgentPicker.vue';

/**
 * Answer-triage delta (FR-017/025): the blocking-resume agent picker lists the
 * workspace's enabled agents INCLUDING the orchestrator and preselects the
 * orchestrator; when the orchestrator is disabled/absent it falls back to the
 * original agent, preserving the pre-delta behavior.
 */

const worker = { ...sampleAgent, id: 'ag-worker', name: 'Implementer' };
const otherWorker = { ...sampleAgent, id: 'ag-other', name: 'Reviewer' };
const disabledWorker = { ...sampleAgent, id: 'ag-off', name: 'Sleeper', enabled: false };
const orchestrator = {
  ...sampleAgent,
  id: 'ag-brig',
  name: 'brigadir',
  is_orchestrator: true,
  status_running: null,
};

function useRoster(agents: (typeof sampleAgent)[]) {
  server.use(
    http.get('/api/agents', () => HttpResponse.json<AgentListResponse>(paginated(agents))),
  );
}

function mountPicker() {
  return mountWithProviders(ResumeAgentPicker, {
    props: {
      workspaceId: 'ws-1',
      originalAgentId: 'ag-worker',
      taskId: 'ht-1',
      modelValue: undefined,
      'onUpdate:modelValue': () => {},
    },
  });
}

describe('ResumeAgentPicker (answer-triage delta)', () => {
  it('preselects the orchestrator when present and enabled', async () => {
    useRoster([worker, orchestrator, otherWorker]);
    const wrapper = mountPicker();
    await flush();

    const emitted = wrapper.emitted('update:modelValue');
    expect(emitted?.at(-1)).toEqual(['ag-brig']);
  });

  it('lists enabled agents including the orchestrator with an "(orchestrator)" label, excluding disabled ones', async () => {
    useRoster([worker, orchestrator, disabledWorker]);
    const wrapper = mountPicker();
    await flush();

    const options = wrapper.findAllComponents({ name: 'ElOption' });
    const labels = options.map((o) => o.props('label'));
    expect(labels).toContain('Implementer');
    expect(labels).toContain('brigadir (orchestrator)');
    expect(labels).not.toContain('Sleeper');
  });

  it('falls back to the original agent when the orchestrator is disabled (off-switch preserved)', async () => {
    useRoster([worker, otherWorker, { ...orchestrator, enabled: false }]);
    const wrapper = mountPicker();
    await flush();

    const emitted = wrapper.emitted('update:modelValue');
    expect(emitted?.at(-1)).toEqual(['ag-worker']);
  });

  it('falls back to the first eligible agent when neither orchestrator nor original is available', async () => {
    useRoster([otherWorker]);
    const wrapper = mountPicker();
    await flush();

    const emitted = wrapper.emitted('update:modelValue');
    expect(emitted?.at(-1)).toEqual(['ag-other']);
  });
});
