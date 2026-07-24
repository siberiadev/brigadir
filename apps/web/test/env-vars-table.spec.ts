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
  it('renders a non-secret row (editable value, enabled OFF switch)', async () => {
    const w = mountTable({ modelValue: { PORT: '3100' } });
    await flush();
    const val = w.find('input[data-test="env-plain-value-PORT"]').element as HTMLInputElement;
    expect(val.value).toBe('3100');
    expect(val.disabled).toBe(false);
    // The per-row secret switch is live: a plain var can be promoted to secret.
    const toggle = w.find('[data-test="env-plain-secret-PORT"]');
    expect(toggle.exists()).toBe(true);
    expect(toggle.classes()).not.toContain('is-disabled');
    expect(toggle.classes()).not.toContain('is-checked');
  });

  it('promotes a saved plain var to secret on toggle — deferred, no eager write', async () => {
    const w = mountTable({ modelValue: { API_KEY: 'plainval' } });
    await flush();
    const toggle = w.find('[data-test="env-plain-secret-API_KEY"]');
    await toggle.trigger('click');
    await flush();

    // Deferred: nothing sealed now, the key stays in modelValue; only the
    // promote model changes (the parent seals it on Save).
    expect(w.emitted('add-secret')).toBeUndefined();
    expect(w.emitted('update:promoteKeys')?.at(-1)?.[0]).toEqual(['API_KEY']);

    // The value masks + locks, and the switch is ON but still enabled (undo-able).
    const val = w.find('input[data-test="env-plain-value-API_KEY"]').element as HTMLInputElement;
    expect(val.value).toBe('••••••••');
    expect(val.disabled).toBe(true);
    expect(toggle.classes()).toContain('is-checked');
    expect(toggle.classes()).not.toContain('is-disabled');

    // Toggling back off clears the promotion and unmasks.
    await toggle.trigger('click');
    await flush();
    expect(w.emitted('update:promoteKeys')?.at(-1)?.[0]).toEqual([]);
    expect((w.find('input[data-test="env-plain-value-API_KEY"]').element as HTMLInputElement).value).toBe('plainval');
  });

  it('renders a promoted plain row distinct from a saved secret row', async () => {
    const w = mountTable({ modelValue: { X: 'v' }, secretKeys: ['S'] });
    await flush();
    await w.find('[data-test="env-plain-secret-X"]').trigger('click');
    await flush();
    // Promoted plain: checked + ENABLED (can flip back before save).
    const promoted = w.find('[data-test="env-plain-secret-X"]');
    expect(promoted.classes()).toContain('is-checked');
    expect(promoted.classes()).not.toContain('is-disabled');
    // Saved secret: checked + DISABLED (write-only; remove via trash).
    const saved = w.find('[data-test="env-secret-toggle-S"]');
    expect(saved.classes()).toContain('is-checked');
    expect(saved.classes()).toContain('is-disabled');
  });

  it('drops a promoted key from promoteKeys when it leaves the model (trash/bulk)', async () => {
    const w = mountTable({ modelValue: { API_KEY: 'v' } });
    await flush();
    await w.find('[data-test="env-plain-secret-API_KEY"]').trigger('click');
    await flush();
    expect(w.emitted('update:promoteKeys')?.at(-1)?.[0]).toEqual(['API_KEY']);
    // Simulate a trash-remove / bulk-Apply replacing the whole map.
    await w.setProps({ modelValue: {} });
    await flush();
    expect(w.emitted('update:promoteKeys')?.at(-1)?.[0]).toEqual([]);
  });

  it('disables the per-row secret switch when secrets are not enabled', async () => {
    const w = mountTable({ modelValue: { PORT: '3100' }, secretsEnabled: false });
    await flush();
    expect(w.find('[data-test="env-plain-secret-PORT"]').classes()).toContain('is-disabled');
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
