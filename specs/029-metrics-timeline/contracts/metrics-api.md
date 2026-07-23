# Contracts: Metrics API (`GET /api/metrics/*`)

Пять read-only эндпоинтов за `DashboardTokenGuard` (тот же bearer, что у всего дашборда, FR-015). Тела ответов `snake_case`; деньги — СТРОКА (numeric round-trip), никогда float. Схемы живут в `packages/contracts/src/metrics.schema.ts` (единый типизированный источник для контроллера и композаблов), экспортируются из `index.ts`. Round-trip покрыт `metrics.schema.spec.ts`.

## Общие query-параметры (все 5 эндпоинтов)

| Параметр | Тип | Default | Примечание |
|---|---|---|---|
| `period` | `24h`\|`7d`\|`30d` | `7d` | `RunCostPeriodSchema.catch('7d')` — мусор → default, не 500 |
| `workspace_id` | uuid, опц. | — | отсутствует ⇒ все воркспейсы; невалидный/несуществующий ⇒ 200 с пустыми рядами (soft, M8), не 4xx |
| `executor_type` | string, опц. | — | отсутствует ⇒ все типы; мягкая валидация. **НЕ применяется** к эндпоинтам `/human` и к полю `open_human_tasks` в `/overview` (H1/FR-011a) — у `human_tasks` нет типа исполнителя |

Общая zod-схема: `MetricsFilterQuerySchema`. Общий тип ответа-ряда: `TimeBucketedSeriesSchema` (см. data-model §TimeBucketedSeries).

```
MetricsFilterQuerySchema = {
  period: RunCostPeriodSchema.catch('7d').default('7d'),
  workspace_id: z.string().uuid().optional(),
  executor_type: z.string().min(1).optional(),
}

MetricsGranularitySchema = z.enum(['hour','day'])

MetricsSeriesSchema = {
  key: z.string(),
  label: z.string().optional(),
  points: z.array(z.union([z.number(), z.string()])),  // строки для денег
}

TimeBucketedSeriesSchema = {
  granularity: MetricsGranularitySchema,
  buckets: z.array(z.string()),      // ISO bucket_start, плотный/zero-filled
  series: z.array(MetricsSeriesSchema),
}
```

---

## 1. `GET /api/metrics/overview` (US1)

Скаляры сводки за период (с учётом фильтров). НЕ ряды.

**Response** `MetricsOverviewResponseSchema`:
```
{
  period: '24h'|'7d'|'30d',
  total_cost_usd: string,                         // "0" при отсутствии
  run_count_by_status: {                          // все ключи присутствуют, 0 по умолчанию
    queued: number, running: number, awaiting_human: number,
    succeeded: number, failed: number, cancelled: number,
    timed_out: number, superseded: number
  },
  success_rate: number | null,                    // 0..1 (рендерится как %, L2); null если знаменатель 0
  median_duration_s: number | null,               // null если нет завершённых прогонов
  open_human_tasks: number                         // фильтр period+workspace_id; executor_type НЕ применяется (H1)
}
```

## 2. `GET /api/metrics/cost` (US2)

**Response** `MetricsCostResponseSchema`:
```
{
  cost_by_executor: TimeBucketedSeries,     // points — строки (деньги), серия на executor_type
  tokens_by_type:   TimeBucketedSeries,     // 4 серии: input|output|cache_read|cache_creation, points — числа
  tokens_by_executor: TimeBucketedSeries,   // суммарные токены (все типы), серия на executor_type, points — числа
  tokens_by_model:  TimeBucketedSeries,     // суммарные токены, серия на модель (из session-init log-события прогона; '__unknown__' если лога нет), points — числа
  cost_per_run:     TimeBucketedSeries,     // одна серия key='cost_per_run', points — строки
  top_workspaces_by_cost: Array<{           // топ-10 по расходу (M7); присутствует ТОЛЬКО когда workspace_id не задан; иначе []
    workspace_id: string, name: string, total_cost_usd: string
  }>
}
```

## 3. `GET /api/metrics/reliability` (US3)

**Response** `MetricsReliabilityResponseSchema`:
```
{
  runs_by_status:       TimeBucketedSeries,  // серия на статус, points — числа
  success_rate:         TimeBucketedSeries,  // одна серия key='success_rate', points — числа 0..1
  duration_median_s:    TimeBucketedSeries,  // одна серия, points — числа (секунды)
  duration_p95_s:       TimeBucketedSeries,  // одна серия, points — числа (секунды)
  retry_rate:           TimeBucketedSeries,  // одна серия key='retry_rate', points — 0..1
  failstats_by_executor: TimeBucketedSeries  // failed+timed_out, серия на executor_type
}
```

## 4. `GET /api/metrics/activity` (US4)

**Response** `MetricsActivityResponseSchema`:
```
{
  by_source:    TimeBucketedSeries,   // серия на trigger source (+ '__unknown__' при NULL)
  by_role:      TimeBucketedSeries,   // серия на agents.role (+ '__unknown__' при NULL)
  by_workspace: TimeBucketedSeries    // серия на workspace; label = имя воркспейса
}
```

## 5. `GET /api/metrics/human` (US5)

> Фильтры: `period` + `workspace_id` только. `executor_type` игнорируется (H1/FR-011a) — у `human_tasks` нет типа исполнителя.

**Response** `MetricsHumanResponseSchema`:
```
{
  latency_median_s: TimeBucketedSeries,  // якорь бакета = resolved_at, только резолвленные
  latency_p95_s:    TimeBucketedSeries,
  opened_by_kind:   TimeBucketedSeries,  // якорь created_at, серия на kind
  closed_by_kind:   TimeBucketedSeries,  // якорь resolved_at, серия на kind
  awaiting_human_share: TimeBucketedSeries // одна серия, points 0..1 (текущий status='awaiting_human')
}
```

## Ошибки / коды
- **401** — нет/битый bearer (DashboardTokenGuard), как везде на дашборде.
- **200 с пустыми рядами** — нет данных за фильтр: `buckets` плотный, `series` пустой или из нулей (не 4xx, FR-016).
- Невалидный `period` → тихий фолбэк на `7d` (`.catch`), не 4xx (конвенция cost-эндпоинта).
- Невалидный/несуществующий `workspace_id` → **200 с пустыми рядами** (мягко, консистентно с `.catch`-философией; M8 — решено, не «на выбор реализации»). Проверяется тестом.

## Инварианты (проверяются тестами)
- `points.length === buckets.length` в каждой серии каждого ряда.
- `buckets` строго возрастают, шаг = granularity, покрывают весь период (zero-fill).
- Деньги во всех `*cost*`-полях — строки, парсятся в число без потерь.
- Сумма `run_count_by_status` overview == сумма по всем сериям `runs_by_status` reliability за тот же фильтр (SC-003, консистентность разрезов).
- `granularity='hour'` только при `period='24h'`, иначе `'day'`.
