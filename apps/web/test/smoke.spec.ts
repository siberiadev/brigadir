import { describe, it, expect } from 'vitest';
import { mountWithProviders, flush } from './mount';
import WorkspaceList from '../src/views/WorkspaceList.vue';

// T148 smoke test: the harness mounts a component that reads a faked
// `/api/workspaces` response through the full Query + Pinia + Element Plus stack.
describe('test harness', () => {
  it('mounts a component and reads a faked /api/workspaces response via msw', async () => {
    const wrapper = mountWithProviders(WorkspaceList);
    await flush();
    expect(wrapper.text()).toContain('Acme');
  });
});
