import { z } from 'zod';

/**
 * Единая пагинация всех генеральных списков (реш. 2026-07-15, CLAUDE.md
 * «UI-конвенции»). Каждый list-эндпоинт принимает `page`/`page_size` и отвечает
 * конвертом `{ items, page, page_size, total }`, построенным ТОЛЬКО фабрикой
 * `makePaginatedResponseSchema`. Пагинированный запрос обязан иметь
 * детерминированный `ORDER BY` на стороне БД.
 */

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './pagination.constants';

export * from './pagination.constants';

/**
 * Query-параметры пагинации. `.catch()` — толерантность к мусору в query
 * string (`?page=abc` → 1), как исторически клампил runs.controller.
 */
export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).catch(1).default(1),
  page_size: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .catch(DEFAULT_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

/** Единственный способ объявить схему ответа list-эндпоинта. */
export function makePaginatedResponseSchema<T extends z.ZodTypeAny>(item: T) {
  return z
    .object({
      items: z.array(item),
      page: z.number().int(),
      page_size: z.number().int(),
      total: z.number().int(),
    })
    .strict();
}
