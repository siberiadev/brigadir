import { describe, it, expect } from 'vitest';
import { nextTick, ref } from 'vue';
import { usePagination } from '../src/composables/usePagination';

/**
 * Состояние пагинации (реш. 2026-07-15): дефолт 10; смена page_size или любого
 * фильтра из resetOn сбрасывает на страницу 1; bindTotal кламит страницу, когда
 * total ужался и текущая страница вышла за последнюю.
 */

describe('usePagination', () => {
  it('defaults to page 1 / page_size 10 and exposes them as params', () => {
    const { params } = usePagination();
    expect(params.value).toEqual({ page: 1, page_size: 10 });
  });

  it('resets to page 1 when the page size changes', async () => {
    const { page, pageSize } = usePagination();
    page.value = 5;
    pageSize.value = 100;
    await nextTick();
    expect(page.value).toBe(1);
  });

  it('resets to page 1 when a resetOn filter changes', async () => {
    const filter = ref('open');
    const { page } = usePagination({ resetOn: filter });
    page.value = 3;
    filter.value = 'closed';
    await nextTick();
    expect(page.value).toBe(1);
  });

  it('clamps the page when the bound total shrinks below the current page', async () => {
    const total = ref<number | undefined>(45);
    const { page, bindTotal } = usePagination();
    bindTotal(total);
    page.value = 5; // 45 элементов по 10 → 5 страниц, валидно.
    total.value = 12; // ужалось до 2 страниц.
    await nextTick();
    expect(page.value).toBe(2);
  });

  it('ignores an undefined total (query not resolved yet)', async () => {
    const total = ref<number | undefined>(undefined);
    const { page, bindTotal } = usePagination();
    bindTotal(total);
    page.value = 4;
    total.value = undefined;
    await nextTick();
    expect(page.value).toBe(4);
  });
});
