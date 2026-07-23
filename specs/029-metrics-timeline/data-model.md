# Data Model: Страница /metrics

**Никаких изменений схемы БД.** Фича — read-only проекция существующих таблиц. Ниже — источники, производные (read-model) сущности и правила деривации. Схему `runs`/`human_tasks`/`agents`/`workspaces` НЕ трогаем (архитектура §3, конституция «схему не менять без обновления документа» — не применимо, т.к. изменений нет).

## Источники (existing, read-only)

### `runs`
| Колонка | Тип | Использование в метриках |
|---|---|---|
| `created_at` | timestamptz notNull | **Якорь бакета** для всех рядов активности/расходов/статусов (кроме ряда длительности — см. `finished_at`) |
| `started_at` / `finished_at` | timestamptz null | Длительность = `finished_at - started_at` (только когда оба NOT NULL, FR-012). `finished_at` — **якорь бакета ряда длительности** (FR-005a/M2) |
| `cost_usd` | numeric(10,4) null | Суммы расходов (сериализация строкой) |
| `usage` | jsonb null | Токены: `input_tokens`/`output_tokens`/`cache_read_input_tokens`/`cache_creation_input_tokens` |
| `status` | text notNull | Разбивка по статусам; success_rate; awaiting_human share |
| `executor_type` | text notNull | Стек расходов; фильтр; failed/timed_out by executor |
| `attempt` | int notNull | retry_rate = доля `attempt > 1` |
| `trigger_event` | jsonb null | `->>'source'` — разбивка активности по источнику |
| `workspace_id` | uuid notNull | Фильтр; разбивка по борде (через join workspaces) |
| `agent_id` | uuid notNull | Join agents → `role` для разбивки по роли |

### `human_tasks`
| Колонка | Использование |
|---|---|
| `kind` (`question`\|`blocker`\|`review`) | Разбивка opened/closed |
| `status` (`open`\|`resolved`\|`dismissed`) | Opened vs closed |
| `created_at` | Якорь бакета «открыто»; latency start |
| `resolved_at` (null) | Якорь бакета «закрыто»; latency end (только резолвленные) |

### `agents` / `workspaces`
- `agents.role` (nullable) — измерение «по роли»; NULL → `__unknown__` (FR-014).
- `workspaces.jira_board_id` / `jira_board_type` / `name` — измерение «по борде»; воркспейс без `jira_board_id` → `__unknown__`.

## Вокабуляры (из контрактов — переиспользуем, не дублируем)
- **RunStatus**: `queued|running|awaiting_human|succeeded|failed|cancelled|timed_out|superseded` (`RunStatusSchema`).
- **Период**: `24h|7d|30d` (`RunCostPeriodSchema`).
- **Trigger source**: `manual|webhook|poll|human-resume|triage|rework|answer-triage|workspace-setup` (`TRIGGER_SOURCES`).
- **Human task kind**: `question|blocker|review` (`HumanTaskKindSchema`).
- **Executor type**: `mock|claude_cli|kimi|deepseek_api` (свободный text в БД; фильтр валидируем мягко).

## Производные сущности (read-model, только в ответах API)

### Filters (общие query-параметры всех эндпоинтов)
- `period`: `24h|7d|30d` (default `7d`, `.catch('7d')` как в cost-эндпоинте).
- `workspace_id?`: uuid; отсутствует ⇒ все воркспейсы.
- `executor_type?`: string; отсутствует ⇒ все типы.
- **Деривация окна**: `from = now() - period_hours * interval '1 hour'`, `to = now()`.
- **Деривация гранулярности** (R2): `24h → 'hour'`, `7d|30d → 'day'`.
- **Таймзона** (M4): усечение бакетов ВСЕГДА явно в UTC — `date_trunc(gran, ts, 'UTC')` (PG16) или `date_trunc(gran, ts AT TIME ZONE 'UTC')`, не полагаясь на session TimeZone. То же UTC применяется к сетке `generate_series`.
- **Применимость фильтров** (H1): `period` и `workspace_id` применяются ко ВСЕМ метрикам. `executor_type` применяется ко всем метрикам, производным от `runs`, но НЕ к метрикам, производным от `human_tasks` (у сущности нет колонки типа исполнителя; связь `run_id` nullable) — см. §Human и §OverviewSummary.

### TimeBucketedSeries (форма всех временны́х рядов, R5)
```
{
  granularity: 'hour' | 'day',
  buckets: string[],                 // ISO bucket_start, плотный ряд (zero-filled, R3), возрастающий
  series: Array<{
    key: string,                     // категория: executor_type | status | source | role | board | token-type | '__unknown__'
    label?: string,                  // опц. человекочитаемый лейбл (напр. имя воркспейса для board)
    points: Array<number | string>   // длина == buckets.length; строки для денежных рядов, числа иначе
  }>
}
```
- **Инвариант**: `points.length === buckets.length` для каждой серии.
- **Zero-fill**: отсутствующий бакет → `0` (строка `"0"` для денег).
- **Категории**: только реально встретившиеся за период + при необходимости `__unknown__`.

### OverviewSummary (US1, скаляры — НЕ ряды)
```
{
  period: '24h'|'7d'|'30d',
  total_cost_usd: string,            // coalesce(sum(cost_usd),0)::text
  run_count_by_status: Record<RunStatus, number>,   // 0 для отсутствующих
  success_rate: number | null,       // succeeded / (succeeded+failed+timed_out+cancelled); null если знаменатель 0
  median_duration_s: number | null,  // percentile_cont(0.5), только завершённые; null если нет завершённых
  open_human_tasks: number           // human_tasks.status='open'; фильтр period+workspace_id, executor_type НЕ применяется (H1/FR-011a)
}
```

## Правила деривации метрик (по вкладкам)

### Cost & Usage
- **cost_by_executor**: `sum(cost_usd)` GROUP BY bucket, `executor_type` → series по executor. Деньги — строки.
- **tokens_by_type**: 4 серии (`input`/`output`/`cache_read`/`cache_creation`), `sum((usage->>'..')::bigint)` coalesce 0.
- **cost_per_run**: одна серия — `sum(cost_usd)/nullif(count(*),0)` на бакет (строка; null-бакет → `"0"`).
- **top_workspaces_by_cost**: НЕ ряд, а bar — `sum(cost_usd)` GROUP BY workspace ORDER BY sum DESC **LIMIT 10** (M7); отдаётся только когда `workspace_id` не задан (иначе одна борда — бессмысленно, FR-007/US2 AS3), при заданном `workspace_id` → пустой массив.

### Run Reliability
- **runs_by_status**: `count(*)` GROUP BY bucket, `status` → серия на статус (stacked area).
- **success_rate**: на бакет `count(status='succeeded') / nullif(count(status IN succeeded,failed,timed_out,cancelled),0)` (%). Незавершённые (queued/running/awaiting_human/superseded) вне знаменателя.
- **duration_median / duration_p95**: две серии, `percentile_cont(0.5|0.95)` по завершённым (R4), секунды. **Якорь бакета — `finished_at`** (день/час завершения, НЕ `created_at`): прогон, пересёкший границу суток, попадает в бакет завершения (FR-005a, M2). Это единственный ряд-исключение из общего правила «якорь = `created_at`».
- **retry_rate**: на бакет `count(attempt>1)/nullif(count(*),0)`.
- **failstats_by_executor**: `count(*)` где `status IN ('failed','timed_out')` GROUP BY bucket, executor.

### Activity & Triggers (три независимые разбивки одного счётчика прогонов)
- **by_source**: `count(*)` GROUP BY bucket, `coalesce(trigger_event->>'source','__unknown__')`.
- **by_role**: join agents; GROUP BY bucket, `coalesce(agents.role,'__unknown__')`.
- **by_workspace**: GROUP BY bucket, workspace; `label` = имя воркспейса; воркспейс без `jira_board_id` — обычный воркспейс (борда неизвестна) остаётся своей серией по имени; «__unknown__» тут не нужен (workspace_id notNull).

### Human-in-the-loop
> **Фильтры вкладки (H1/FR-011a)**: все метрики ниже фильтруются ТОЛЬКО `period` и `workspace_id`. `executor_type` НЕ применяется — `human_tasks` не имеет типа исполнителя, а join `run_id → runs.executor_type` нестабилен (`run_id` nullable, задачи без прогона выпали бы). На фронте при активном `executor_type` элемент фильтра на этой вкладке неактивен/помечен неприменимым.

- **latency_median / latency_p95**: по резолвленным задачам (`resolved_at NOT NULL`), якорь бакета = `resolved_at`, значение = `percentile_cont(..)` от `extract(epoch from resolved_at - created_at)`; секунды.
- **opened_by_kind**: `count(*)` GROUP BY bucket(`created_at`), `kind`.
- **closed_by_kind**: `count(*)` где `resolved_at NOT NULL` GROUP BY bucket(`resolved_at`), `kind`.
- **awaiting_human_share**: доля прогонов, у которых `status='awaiting_human'` (или когда-либо парковались — для v1 берём текущий `status='awaiting_human'` как приближение, задокументировать), на бакет `created_at`: `count(status='awaiting_human')/nullif(count(*),0)`.
  - *Примечание*: точная историческая доля «когда-либо уходил в awaiting_human» требует лог переходов, которого нет (см. spec §Assumptions/future). v1 использует текущий статус — честно помечаем в UI как «сейчас в ожидании», не «когда-либо».

## Валидация и граничные правила
- Пустой результат за фильтр → `buckets` заполнены (плотный ряд периода), `series: []` или серии со всеми нулями; фронт рисует empty-state (FR-016).
- `executor_type`/`workspace_id` без совпадений → тот же пустой-ряд-путь, не ошибка (Edge Case).
- Деньги никогда не float — только `::text` строки (существующая конвенция home/cost).
- Все временны́е границы и бакеты — UTC (Assumption).
