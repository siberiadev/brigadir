/**
 * Константы единой пагинации (реш. 2026-07-15). ОТДЕЛЬНЫЙ модуль без
 * runtime-зависимостей (ни zod, ни node:*): web-приложение импортирует его из
 * TS-источника через алиас `@brigadir/contracts/pagination` — как agent-linter
 * — чтобы не тащить CJS-баррель (и node:crypto из run-token) в браузерный
 * бандл. Схемы живут рядом в `pagination.schema.ts`.
 */

export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 100;
/** Опции селектора размера страницы в `<ListPagination>`. */
export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];
