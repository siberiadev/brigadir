import { z } from 'zod';

/**
 * Дашборд-контракты реконсайл-цикла (Jira-синхронизация, из которой стартуют
 * прогоны). Источник данных — BullMQ job scheduler `reconcile` в Redis, а не
 * env воркера: backend отдаёт то расписание, которое реально апсертнул воркер.
 */

/**
 * GET /api/reconcile/status. `scheduled:false` + null-поля — воркер ещё не
 * регистрировал шедулер (или Redis пуст); `last_run_at` — момент взятия в
 * работу последнего тика (processedOn), null пока ни один не исполнялся.
 */
export const ReconcileStatusResponseSchema = z
  .object({
    scheduled: z.boolean(),
    every_ms: z.number().int().positive().nullable(),
    next_run_at: z.string().nullable(),
    last_run_at: z.string().nullable(),
    generated_at: z.string(),
  })
  .strict();
export type ReconcileStatusResponse = z.infer<typeof ReconcileStatusResponseSchema>;

/**
 * POST /api/reconcile/trigger. `deduplicated:true` — ручной тик уже ждёт в
 * очереди или исполняется, новый job не добавлен.
 */
export const ReconcileTriggerResponseSchema = z
  .object({
    ok: z.literal(true),
    deduplicated: z.boolean(),
  })
  .strict();
export type ReconcileTriggerResponse = z.infer<typeof ReconcileTriggerResponseSchema>;
