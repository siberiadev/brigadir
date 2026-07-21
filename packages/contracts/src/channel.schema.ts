import { z } from 'zod';

/**
 * Callback-channel resilience (feature 027).
 *
 * Три контракта одного сюжета «канал упал — оператор это видит»:
 *  1. `ChannelBreadcrumbRecordSchema` — строка JSONL-файла
 *     `<configRoot>/.brigadir-channel/<runId>.jsonl`, которую tool-сервер
 *     (packages/mcp-server) пишет при исчерпании ретраев доставки callback'а.
 *     Писатель зависимостей не имеет и схему не импортирует — валидация
 *     выполняется ЧИТАТЕЛЕМ (worker) построчно; неизвестные ключи толерантны
 *     (additive-совместимость протокола).
 *  2. `ChannelFailureEventPayloadSchema` — payload run_events-строки
 *     `type='channel_failure'`, в которую worker переливает breadcrumb.
 *  3. `ChannelHealthResponseSchema` — ответ дашборд-эндпоинта
 *     GET /api/channel-health (строгий, как все dashboard-контракты).
 *
 * Протокол файла: specs/027-callback-channel-resilience/contracts/channel-breadcrumbs.md.
 */

/** Какой retry-бюджет исчерпался: network — fetch кидал, http — 5xx-ответы. */
export const ChannelBreadcrumbKindSchema = z.enum(['network', 'http']);
export type ChannelBreadcrumbKind = z.infer<typeof ChannelBreadcrumbKindSchema>;

/**
 * Одна запись «доставка callback'а сдалась». `target` — только host:port,
 * никогда полный URL/заголовки/токены (Constitution V). Не-strict: писатель
 * может добавлять поля, старый читатель их игнорирует.
 */
export const ChannelBreadcrumbRecordSchema = z.object({
  ts: z.string().datetime({ offset: true }),
  tool: z.string().min(1),
  kind: ChannelBreadcrumbKindSchema,
  attempts: z.number().int().min(1),
  error: z.object({ name: z.string(), message: z.string() }).passthrough(),
  status: z.number().int().optional(),
  target: z.string().min(1),
});
export type ChannelBreadcrumbRecord = z.infer<typeof ChannelBreadcrumbRecordSchema>;

/** Каким путём ingestion выиграл claim файла. */
export const ChannelFailureSourceSchema = z.enum(['exit', 'reconcile']);
export type ChannelFailureSource = z.infer<typeof ChannelFailureSourceSchema>;

/**
 * Payload run_events `type='channel_failure'`: breadcrumb + метаданные
 * ingestion'а. `occurred_at` = `ts` записи (момент отказа доставки);
 * `created_at` строки — момент ingestion'а (лаг ≤ каденса реконсайлера).
 */
export const ChannelFailureEventPayloadSchema = ChannelBreadcrumbRecordSchema.extend({
  occurred_at: z.string().datetime({ offset: true }),
  source: ChannelFailureSourceSchema,
});
export type ChannelFailureEventPayload = z.infer<typeof ChannelFailureEventPayloadSchema>;

/** Вердикт deployment guard'а в составе health-агрегата. */
export const ChannelHealthGuardSchema = z
  .object({
    ok: z.boolean(),
    reason: z.enum(['missing', 'stale']).nullable(),
  })
  .strict();

export const ChannelHealthAffectedRunSchema = z
  .object({
    run_id: z.string().uuid(),
    ticket_key: z.string().nullable(),
    last_event_at: z.string(),
  })
  .strict();
export type ChannelHealthAffectedRun = z.infer<typeof ChannelHealthAffectedRunSchema>;

/** Жёсткий cap списка затронутых прогонов — часть контракта, UI пишет «top 20». */
export const CHANNEL_HEALTH_AFFECTED_RUNS_CAP = 20;

/**
 * GET /api/channel-health. degraded ⇔ probe_failures ≥ 1 ИЛИ
 * channel_failures ≥ failure_threshold ИЛИ !deployment_guard.ok.
 * Агрегат derived-on-demand, нигде не хранится.
 */
export const ChannelHealthResponseSchema = z
  .object({
    status: z.enum(['healthy', 'degraded']),
    generated_at: z.string(),
    window_ms: z.number().int().positive(),
    failure_threshold: z.number().int().positive(),
    last_successful_callback_at: z.string().nullable(),
    channel_failures_in_window: z.number().int().min(0),
    probe_failures_in_window: z.number().int().min(0),
    deployment_guard: ChannelHealthGuardSchema,
    affected_runs: z.array(ChannelHealthAffectedRunSchema).max(CHANNEL_HEALTH_AFFECTED_RUNS_CAP),
  })
  .strict();
export type ChannelHealthResponse = z.infer<typeof ChannelHealthResponseSchema>;
