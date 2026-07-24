import { describe, it, expect, afterEach } from 'vitest';
import type { VueWrapper } from '@vue/test-utils';
import { mountWithProviders, flush } from './mount';
import BulkEnvEditor from '../src/components/BulkEnvEditor/BulkEnvEditor.vue';
import { SECRET_MASK } from '../src/components/BulkEnvEditor/bulk-env';

let active: VueWrapper | undefined;
afterEach(() => {
  active?.unmount();
  active = undefined;
  document.body.querySelectorAll('.el-overlay, .el-dialog__wrapper').forEach((n) => n.remove());
});

const bodyQ = (sel: string) => document.querySelector(`[data-test="${sel}"]`) as HTMLElement | null;

async function mountEditor(props: Record<string, unknown>) {
  const wrapper = mountWithProviders(BulkEnvEditor as never, {
    props: { modelValue: true, plainEnv: {}, secretKeys: [], ...props },
  });
  active = wrapper;
  await flush();
  return wrapper;
}

async function setTextarea(value: string) {
  const el = bodyQ('bulk-env-textarea') as HTMLTextAreaElement;
  el.value = value;
  el.dispatchEvent(new Event('input'));
  await flush();
}

describe('BulkEnvEditor', () => {
  it('seeds the textarea with plaintext values and masked secrets', async () => {
    await mountEditor({ plainEnv: { PORT: '3100' }, secretKeys: ['DATABASE_URL'] });
    const ta = bodyQ('bulk-env-textarea') as HTMLTextAreaElement;
    expect(ta.value).toBe(`PORT=3100\nDATABASE_URL=${SECRET_MASK}`);
  });

  it('applies a valid edit: emits the structured result and closes', async () => {
    const wrapper = await mountEditor({ plainEnv: { PORT: '3100' }, secretKeys: ['API_TOKEN'] });
    // Keep the secret masked, change PORT, add a new plaintext var.
    await setTextarea(`PORT=4000\nNEW_VAR=x\nAPI_TOKEN=${SECRET_MASK}`);
    (bodyQ('bulk-env-apply') as HTMLButtonElement).click();
    await flush();

    const applied = wrapper.emitted('apply')?.[0]?.[0] as {
      plainEnv: Record<string, string>;
      secretSet: Record<string, string>;
      secretDelete: string[];
    };
    expect(applied.plainEnv).toEqual({ PORT: '4000', NEW_VAR: 'x' });
    expect(applied.secretSet).toEqual({}); // mask untouched
    expect(applied.secretDelete).toEqual([]);
    // Closes on apply.
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toBe(false);
  });

  it('reports a re-sealed secret when its masked value is changed', async () => {
    const wrapper = await mountEditor({ plainEnv: {}, secretKeys: ['API_TOKEN'] });
    await setTextarea('API_TOKEN=rotated');
    (bodyQ('bulk-env-apply') as HTMLButtonElement).click();
    await flush();
    const applied = wrapper.emitted('apply')?.[0]?.[0] as { secretSet: Record<string, string> };
    expect(applied.secretSet).toEqual({ API_TOKEN: 'rotated' });
  });

  it('blocks apply on an invalid line and shows the error', async () => {
    const wrapper = await mountEditor({});
    await setTextarea('2BAD=x');
    expect(bodyQ('bulk-env-errors')?.textContent).toContain('2BAD');
    expect((bodyQ('bulk-env-apply') as HTMLButtonElement).disabled).toBe(true);
    (bodyQ('bulk-env-apply') as HTMLButtonElement).click();
    await flush();
    expect(wrapper.emitted('apply')).toBeUndefined();
  });
});
