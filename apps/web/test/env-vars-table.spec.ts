import { describe, it, expect } from 'vitest';
import { mountWithProviders, flush } from './mount';
import EnvVarsTable from '../src/components/EnvVarsTable/EnvVarsTable.vue';

/**
 * Feature 031: the shared env editor. Uniform rows [key][value][secret][remove];
 * saved vars have a disabled secret switch (a saved secret shows its value
 * masked), and only the add row can choose/mask secret-ness. Reserved/malformed
 * keys are rejected inline with the same rules as the server.
 */
function mountTable(props: Record<string, unknown> = {}) {
  return mountWithProviders(EnvVarsTable, {
    props: { modelValue: {}, secretKeys: [], ...props },
  });
}

describe('EnvVarsTable', () => {
  it('renders a non-secret row (editable value, disabled OFF switch)', async () => {
    const w = mountTable({ modelValue: { PORT: '3100' } });
    await flush();
    const val = w.find('input[data-test="env-plain-value-PORT"]').element as HTMLInputElement;
    expect(val.value).toBe('3100');
    expect(val.disabled).toBe(false);
    // The per-row secret switch exists but is disabled (secret-ness is fixed once saved).
    const toggle = w.find('[data-test="env-plain-secret-PORT"]');
    expect(toggle.exists()).toBe(true);
    expect(toggle.classes()).toContain('is-disabled');
    expect(toggle.classes()).not.toContain('is-checked');
  });

  it('renders a saved secret row: masked, disabled value input + disabled ON switch', async () => {
    const w = mountTable({ secretKeys: ['DATABASE_URL'] });
    await flush();
    const val = w.find('input[data-test="env-secret-value-DATABASE_URL"]').element as HTMLInputElement;
    expect(val.value).toBe('••••••••');
    expect(val.disabled).toBe(true);
    const toggle = w.find('[data-test="env-secret-toggle-DATABASE_URL"]');
    expect(toggle.classes()).toContain('is-disabled');
    expect(toggle.classes()).toContain('is-checked');
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
    expect(w.emitted('update:modelValue')?.[0]?.[0]).toEqual({ NODE_ENV: 'test' });
  });

  it('masks the value input and emits add-secret when the add-row switch is on', async () => {
    const w = mountTable();
    await flush();
    await w.find('input[data-test="env-add-key"]').setValue('API_TOKEN');
    await w.find('input[data-test="env-add-value"]').setValue('tok');
    await w.find('[data-test="env-add-secret-flag"]').trigger('click'); // toggle the el-switch
    await flush();
    // The value input becomes a password field once secret is on.
    expect((w.find('input[data-test="env-add-value"]').element as HTMLInputElement).type).toBe('password');
    await w.find('[data-test="env-add"]').trigger('click');
    expect(w.emitted('add-secret')?.[0]).toEqual(['API_TOKEN', 'tok']);
    expect(w.emitted('update:modelValue')).toBeUndefined();
  });

  it('hides the add-row secret switch when secrets are not enabled yet', async () => {
    const w = mountTable({ modelValue: { PORT: '3100' }, secretsEnabled: false });
    await flush();
    expect(w.find('[data-test="env-add-secret-flag"]').exists()).toBe(false);
  });

  it('marks rows that override a lower layer', async () => {
    const w = mountTable({ modelValue: { NODE_ENV: 'e2e' }, inheritedKeys: ['NODE_ENV'] });
    await flush();
    expect(w.find('[data-test="env-override-badge"]').exists()).toBe(true);
  });
});
