import { describe, it, expect } from 'vitest';
import { mountWithProviders, flush } from './mount';
import EnvVarsTable from '../src/components/EnvVarsTable/EnvVarsTable.vue';

/**
 * Feature 031 (US3): the shared env editor. Non-secret rows edit in place;
 * secret rows are masked with no reveal; reserved/malformed keys are rejected
 * inline using the same rules as the server.
 */
function mountTable(props: Record<string, unknown> = {}) {
  return mountWithProviders(EnvVarsTable, {
    props: { modelValue: {}, secretKeys: [], ...props },
  });
}

describe('EnvVarsTable', () => {
  it('renders non-secret rows with their values and secret rows masked', async () => {
    const w = mountTable({ modelValue: { PORT: '3100' }, secretKeys: ['DATABASE_URL'] });
    await flush();
    expect(w.find('[data-test="env-plain-PORT"]').exists()).toBe(true);
    const val = w.find('input[data-test="env-plain-value-PORT"]').element as HTMLInputElement;
    expect(val.value).toBe('3100');
    // Secret row shows the name + a masked placeholder, never a value/input.
    const secret = w.find('[data-test="env-secret-DATABASE_URL"]');
    expect(secret.exists()).toBe(true);
    expect(secret.find('input').exists()).toBe(false);
    expect(secret.text()).toContain('••••');
    expect(w.find('[data-test="env-secret-badge"]').exists()).toBe(true);
  });

  it('rejects a reserved key inline and disables Add', async () => {
    const w = mountTable();
    await flush();
    await w.find('input[data-test="env-add-key"]').setValue('ANTHROPIC_API_KEY');
    await flush();
    expect(w.find('[data-test="env-add-error"]').text()).toContain('reserved');
    expect((w.find('[data-test="env-add"]').element as HTMLButtonElement).disabled).toBe(true);
  });

  it('rejects a malformed key inline', async () => {
    const w = mountTable();
    await flush();
    await w.find('input[data-test="env-add-key"]').setValue('2FOO');
    await flush();
    expect(w.find('[data-test="env-add-error"]').text()).toContain('Invalid name');
  });

  it('emits update:modelValue when a non-secret row is added', async () => {
    const w = mountTable();
    await flush();
    await w.find('input[data-test="env-add-key"]').setValue('NODE_ENV');
    await w.find('input[data-test="env-add-value"]').setValue('test');
    await flush();
    await w.find('[data-test="env-add"]').trigger('click');
    const emitted = w.emitted('update:modelValue');
    expect(emitted?.[0]?.[0]).toEqual({ NODE_ENV: 'test' });
  });

  it('emits add-secret (not modelValue) when the secret flag is set', async () => {
    const w = mountTable();
    await flush();
    await w.find('input[data-test="env-add-key"]').setValue('API_TOKEN');
    await w.find('input[data-test="env-add-value"]').setValue('tok');
    await w.find('[data-test="env-add-secret-flag"] input').setValue(true);
    await flush();
    await w.find('[data-test="env-add"]').trigger('click');
    expect(w.emitted('add-secret')?.[0]).toEqual(['API_TOKEN', 'tok']);
    expect(w.emitted('update:modelValue')).toBeUndefined();
  });

  it('marks rows that override a lower layer', async () => {
    const w = mountTable({ modelValue: { NODE_ENV: 'e2e' }, inheritedKeys: ['NODE_ENV'] });
    await flush();
    expect(w.find('[data-test="env-override-badge"]').exists()).toBe(true);
  });
});
