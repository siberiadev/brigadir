<script setup lang="ts">
// Runtime-константы — из dep-free source-модуля (алиас), не из CJS-барреля.
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS } from '@brigadir/contracts/pagination';

/**
 * Единый пагинатор всех генеральных списков (реш. 2026-07-15, CLAUDE.md
 * «UI-конвенции»). Правило видимости: `total ≤ 10` (константа дефолта, НЕ
 * текущий выбор) → компонент скрыт целиком; `total > 10` → показывается
 * всегда, даже когда выбранный `page_size` больше `total` — одна страница в
 * пейджере, селектор размера остаётся доступным. Сброс на страницу 1 при
 * смене размера/фильтров — обязанность `usePagination`, не компонента.
 */
defineProps<{ total: number; page: number; pageSize: number }>();
const emit = defineEmits<{ 'update:page': [value: number]; 'update:pageSize': [value: number] }>();
</script>

<template>
  <el-pagination
    v-if="total > DEFAULT_PAGE_SIZE"
    class="list-pagination"
    data-test="list-pagination"
    layout="total, sizes, prev, pager, next"
    :total="total"
    :current-page="page"
    :page-size="pageSize"
    :page-sizes="PAGE_SIZE_OPTIONS"
    @current-change="emit('update:page', $event)"
    @size-change="emit('update:pageSize', $event)"
  />
</template>

<style scoped>
.list-pagination {
  margin-top: 12px;
}
</style>
