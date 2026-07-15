import { describe, it, expect } from 'vitest';
import { PAGE_SIZE_OPTIONS } from '@brigadir/contracts/pagination';
import { mountWithProviders } from './mount';
import ListPagination from '../src/components/ListPagination.vue';

/**
 * Единый пагинатор (реш. 2026-07-15). Правило видимости: total ≤ 10 (дефолт)
 * → скрыт целиком; total > 10 → показывается всегда, даже когда выбранный
 * page_size больше total (одна страница, селектор доступен).
 */

function mountPagination(props: { total: number; page?: number; pageSize?: number }) {
  return mountWithProviders(ListPagination, {
    props: { page: 1, pageSize: 10, ...props },
  });
}

describe('ListPagination — visibility rule', () => {
  it('renders nothing when total ≤ 10 (fits the default page)', () => {
    const wrapper = mountPagination({ total: 10 });
    expect(wrapper.find('[data-test="list-pagination"]').exists()).toBe(false);
  });

  it('renders the pager AND the size selector when total > 10', () => {
    const wrapper = mountPagination({ total: 11 });
    const pagination = wrapper.find('[data-test="list-pagination"]');
    expect(pagination.exists()).toBe(true);
    expect(pagination.find('.el-pagination__sizes').exists()).toBe(true);
    expect(pagination.find('.el-pager').exists()).toBe(true);
  });

  it('stays visible with a single page when the selected page_size exceeds total', () => {
    const wrapper = mountPagination({ total: 15, pageSize: 50 });
    const pagination = wrapper.find('[data-test="list-pagination"]');
    expect(pagination.exists()).toBe(true);
    // 15 элементов при page_size=50 → ровно одна страница в пейджере.
    expect(pagination.findAll('.el-pager .number')).toHaveLength(1);
    // Селектор размера остаётся доступным.
    expect(pagination.find('.el-pagination__sizes').exists()).toBe(true);
  });
});

describe('ListPagination — options + events', () => {
  it('offers exactly the standard size options 10/20/50/100', () => {
    const wrapper = mountPagination({ total: 25 });
    const el = wrapper.findComponent({ name: 'ElPagination' });
    expect(el.props('pageSizes')).toEqual(PAGE_SIZE_OPTIONS);
    expect(PAGE_SIZE_OPTIONS).toEqual([10, 20, 50, 100]);
  });

  it('emits update:page / update:pageSize (v-model contract)', async () => {
    const wrapper = mountPagination({ total: 45 });
    const el = wrapper.findComponent({ name: 'ElPagination' });
    el.vm.$emit('current-change', 3);
    el.vm.$emit('size-change', 50);
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted('update:page')).toEqual([[3]]);
    expect(wrapper.emitted('update:pageSize')).toEqual([[50]]);
  });
});
