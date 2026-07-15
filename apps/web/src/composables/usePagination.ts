import { computed, ref, toValue, watch, type MaybeRefOrGetter, type WatchSource } from 'vue';
import type { PaginationQuery } from '@brigadir/contracts';
// Runtime-константа — из dep-free source-модуля (алиас), не из CJS-барреля.
import { DEFAULT_PAGE_SIZE } from '@brigadir/contracts/pagination';

export interface UsePaginationOptions {
  /** Источники-фильтры: любое изменение сбрасывает на страницу 1. */
  resetOn?: WatchSource<unknown> | WatchSource<unknown>[];
}

/**
 * Состояние пагинации генерального списка (реш. 2026-07-15). `params` кладётся
 * в query key TanStack-запроса (вместе с `placeholderData: (prev) => prev`).
 * Смена `pageSize` или любого фильтра из `resetOn` сбрасывает на страницу 1
 * (оба ref меняются в одном тике с пересчётом query key — лишнего фетча нет).
 *
 * `bindTotal(total)` подключается ПОСЛЕ создания запроса (запросу нужны
 * `params`, а клампу нужен `total` из ответа — цикл разрывается явно):
 * если `total` уменьшился и текущая страница вышла за последнюю — страница
 * кламится автоматически.
 */
export function usePagination(options: UsePaginationOptions = {}) {
  const page = ref(1);
  const pageSize = ref<number>(DEFAULT_PAGE_SIZE);

  watch(pageSize, () => {
    page.value = 1;
  });

  if (options.resetOn) {
    watch(options.resetOn as WatchSource<unknown>, () => {
      page.value = 1;
    });
  }

  function bindTotal(total: MaybeRefOrGetter<number | undefined>) {
    watch(
      () => toValue(total),
      (value) => {
        if (value === undefined) return;
        const lastPage = Math.max(1, Math.ceil(value / pageSize.value));
        if (page.value > lastPage) page.value = lastPage;
      },
    );
  }

  const params = computed<PaginationQuery>(() => ({
    page: page.value,
    page_size: pageSize.value,
  }));

  return { page, pageSize, params, bindTotal };
}
