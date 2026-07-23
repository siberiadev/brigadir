# Research: Страница /metrics — кумулятивная статистика

Фаза 0. Разрешение технических неизвестных из Technical Context. Все решения опираются на уже существующие паттерны кодовой базы (feature 017 home, feature 006 cost) и схему `runs`/`human_tasks`.

## R1. Графическая библиотека фронтенда

- **Decision**: **ECharts 5** через tree-shaken `echarts/core` + обёртка `vue-echarts`. Регистрируем только нужные модули: `BarChart`, `LineChart`, `GridComponent`, `TooltipComponent`, `LegendComponent`, `CanvasRenderer`. Единая обёртка `components/Metrics/ChartCard.vue` + `charts/echarts.ts` (тема из `var(--el-color-*)`).
- **Rationale**: ECharts хорошо сочетается с Element Plus (упомянуто в постановке), из коробки даёт stacked area/bar, tooltip, легенду, percentile-совместимые линии; tree-shaking держит бандл под контролем (импортируем 2 типа чартов, а не весь пакет). `vue-echarts` даёт реактивный `<v-chart :option>` с авто-resize.
- **Alternatives considered**:
  - *Chart.js + vue-chartjs* — легче, но слабее по стек-área/легенде/зумy и хуже темизируется под наши CSS-переменные.
  - *Свой SVG на d3-scale* — минимальная зависимость, но переизобретаем tooltip/легенду/resize; не оправдано для ~13 графиков.
  - *ECharts целиком (не tree-shaken)* — отклонено ради размера бандла.
- **Convention compliance**: цвета серий берём из брендовых `--el-color-primary/success/warning/danger/info` и их `light-*`-оттенков (`_theme.scss`), НЕ хардкодим (реш. 2026-07-16). Иконки страницы — lucide (`BarChart3`), без hover-анимации вне сайдбара (реш. 2026-07-15).

## R2. Гранулярность бакета vs период

- **Decision**: Адаптивная гранулярность: **24h → почасовые бакеты**, **7d и 30d → посуточные**. Ответ несёт поле `granularity` (`hour`|`day`) и массив бакетов с `bucket_start` (ISO). Фронтенд подписывает ось по `granularity`.
- **Rationale**: FR-005 требует «по дням», но при периоде 24h суточный бакет вырождается в 1–2 точки и график бесполезен. Почасовой бакет для 24h сохраняет читаемость таймлайна — это уточнение в духе интента (читаемая динамика), а не отклонение. Для 7d/30d — ровно суточные бакеты, как в спеке.
- **Alternatives considered**: жёстко суточные для всех периодов (отклонено — вырожденный 24h-график); произвольная гранулярность-параметр (избыточно для v1, период и так фиксирован тремя вариантами).
- **Spec impact**: явно зафиксировать в data-model как правило деривации; это сужение FR-005, не противоречие (для 7d/30d поведение буквально «по дням»).

## R3. Заполнение пропусков нулями (zero-fill) — SQL-паттерн

- **Decision**: `generate_series(date_trunc(granularity, :from), date_trunc(granularity, :to), :interval)` как левая сторона, `LEFT JOIN` агрегата, сгруппированного по `date_trunc(granularity, created_at)`. Отсутствующие бакеты → `coalesce(..., 0)`.
- **Rationale**: FR-005 — дни без данных должны быть нулевыми точками, а не разрывами. `generate_series` — канонический PG-приём для плотного таймлайна; держит формирование сетки бакетов на БД, фронтенд не достраивает пропуски.
- **Alternatives considered**: достраивать нули на фронте (отклонено — дублирование логики границ периода и таймзоны в двух местах); оконные функции (избыточно).
- **Timezone**: агрегируем **явно в UTC**, НЕ полагаясь на session TimeZone контейнера. Используем 3-аргументный `date_trunc('day', created_at, 'UTC')` (Postgres 16) либо `date_trunc('day', created_at AT TIME ZONE 'UTC')`. Это критично: testcontainers по умолчанию UTC и замаскирует баг, а прод-контейнер с non-UTC TZ сдвинет все бакеты и zero-fill (M4). Границы `:from`/`:to` считаем от `now()` в тех же терминах, что уже делает cost-эндпоинт (`now() - (:hours * interval '1 hour')`), и то же UTC-усечение применяем к сетке `generate_series`. Интеграционный тест ПРОВЕРЯЕТ явную UTC-границу (не полагается на дефолт контейнера).

## R4. Медиана и p95 длительности

- **Decision**: `percentile_cont(0.5) WITHIN GROUP (ORDER BY dur)` и `percentile_cont(0.95) WITHIN GROUP (ORDER BY dur)`, где `dur = extract(epoch from (finished_at - started_at))` только для прогонов с `finished_at IS NOT NULL AND started_at IS NOT NULL` (FR-012). Значение в ответе — в миллисекундах (как `duration_ms` в остальном API) или секундах; выбираем **секунды (float)** для percentile, фронт форматирует `formatDuration`.
- **Rationale**: `percentile_cont` — стандартный агрегат PG для медианы/квантилей, без доп. расширений. Исключение незавершённых прогонов из выборки длительности прямо выполняет FR-012 (они всё равно считаются в разбивке по статусам queued/running).
- **Alternatives considered**: приблизительные `percentile_disc` (даёт существующее значение из набора — для длительности `_cont` честнее); расчёт в приложении (отклонено — тянуть все длительности на бэкенд противоречит FR-013).

## R5. Группировка по динамическому измерению (executor_type / status / trigger source / role) → форма ответа

- **Decision**: SQL `GROUP BY bucket, <dimension>`, затем пивот в контроллере в компактную форму:
  ```
  { granularity, buckets: [iso, ...], series: [ { key: 'claude_cli', points: [n0, n1, ...] }, ... ] }
  ```
  где длина `points` равна длине `buckets` (уже zero-filled). Категории — только реально встретившиеся за период (плюс «не определено», см. R6). Деньги в `points` для cost-рядов — строки.
- **Rationale**: набор мал (≤31 бакет × ≤8 категорий); пивот на бэкенде даёт фронтенду готовый к ECharts-стеку формат (одна серия = один `points[]`). `buckets` выносим один раз, не повторяем в каждой точке.
- **Alternatives considered**: long-form строки `{bucket, key, value}` и пивот на фронте (отклонено — дублирует логику категорий/нулей); отдельный эндпоинт на каждый график (отклонено — слишком дробно, см. R7).

## R6. Категория «не определено» (FR-014)

- **Decision**: Прогоны без применимого измерения попадают в явный ключ `"__unknown__"` (лейбл на фронте «не определено»): `agents.role IS NULL` при разбивке по роли; `trigger_event->>'source' IS NULL` при разбивке по источнику; `workspace_id`, у прогона всегда есть (`notNull`), поэтому в разбивке по борде «не определено» = воркспейс без `jira_board_id`. `coalesce(dimension, '__unknown__')` в `GROUP BY`.
- **Rationale**: FR-014 запрещает молчаливое исключение из сумм — суммирование по категориям должно давать общий счётчик.
- **Alternatives considered**: отбрасывать такие строки (нарушает FR-014); отдельная метрика-счётчик (избыточно, лишает контекста ряда).

## R7. Гранулярность эндпоинтов: один на вкладку

- **Decision**: **5 эндпоинтов, по одному на содержательную вкладку**, все с общими query-параметрами `period`, `workspace_id?`, `executor_type?`:
  - `GET /api/metrics/overview` — скаляры сводки (US1): total cost (строка), run_count по статусам, success_rate, median_duration_s, open_human_tasks.
  - `GET /api/metrics/cost` — ряды: cost by executor_type, tokens by type (input/output/cache_read/cache_creation), cost_per_run; плюс top workspaces by cost (bar, только когда `workspace_id` не задан).
  - `GET /api/metrics/reliability` — ряды: runs by status, success_rate, median/p95 duration, retry_rate; плюс failed/timed_out by executor_type.
  - `GET /api/metrics/activity` — ряды: by trigger source, by agent role, by workspace.
  - `GET /api/metrics/human` — ряды: resolution latency median/p95, opened/closed by kind, awaiting_human share.
- **Rationale**: вкладки грузятся независимо (edge case: переключение до догрузки) — по эндпоинту на вкладку даёт естественную ленивую загрузку и изоляцию кэша TanStack Query по ключу-фильтру. Overview дешёвый и отдельный (только скаляры), не тянет полные ряды остальных вкладок.
- **Alternatives considered**: один «жирный» `/api/metrics` со всем (отклонено — грузит невидимые вкладки, раздувает ответ, ломает ленивость); эндпоинт на каждый график (отклонено — 13 запросов, оверхед).

## R8. Токены из `runs.usage` (jsonb)

- **Decision**: `sum((usage->>'input_tokens')::bigint)` и аналогично для `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, с `coalesce(...,0)`. Значения — целые (числа), не деньги.
- **Rationale**: `usage` — это сохранённый CLI `result.usage` (единственный писатель — recordCostUsage). Ключи стабильны для claude_cli; kimi/deepseek проходят через тот же CLI-harness и нормализуются в ту же форму. Отсутствующий ключ → 0 через coalesce.
- **Alternatives considered**: типизировать `usage` в Drizzle (вне объёма фичи); суммировать на бэкенде в JS (отклонено — FR-013).
- **Risk/mitigation**: если у части прогонов `usage` пуст/иной формы — coalesce в 0, ряд остаётся консистентным; тест сидирует смешанные usage.

## R9. Индикативная (небиллинговая) стоимость (FR-008)

- **Decision**: На фронте помечаем сегменты kimi/deepseek_api оценочными той же формулировкой, что в Runs.vue. Существующую inline-константу `INDICATIVE_COST_PROVIDERS` + `costIsIndicative`/`indicativeCostTip` вынести в `apps/web/src/utils/executorCost.ts` и переиспользовать в `MetricsCost.vue`, **`Runs.vue` И `RunCard.vue`** (мелкий DRY-рефактор, поведение обоих не меняется).
- **Rationale**: FR-017 — согласованность подписей с остальным дашбордом; FR-008 — явная пометка оценочности.
- **Факт-уточнение (M6)**: inline-копия существует в **ТРЁХ** местах, не двух — `Runs.vue` (`indicativeCostTip(row)`-функция), `RunCard.vue` (там `INDICATIVE_COST_TIP` как computed, не функция) и будущий `MetricsCost.vue`. Рефактор ОБЯЗАН включить RunCard.vue, иначе он останется расходящимся и обесценит саму цель выноса (риск рассинхрона при добавлении 4-го провайдера). Оба вызова-паттерна свести к общему util с сохранением поведения каждого.
- **Alternatives considered**: продублировать константу (отклонено — тот самый риск рассинхрона); держать список в контрактах (возможно позже; для v1 это чисто UI-лейблинг, оставляем во фронтенде).

## R10. Индексы / производительность без миграции

- **Decision**: v1 **не добавляет индексов и миграций**. Агрегаты сканируют `runs` по окну `created_at >= :from`. Для среза по воркспейсу помогает существующий `runs_workspace_created (workspace_id, created_at desc)`. Для среза по всем воркспейсам — seq scan умеренной таблицы, приемлемо для внутреннего инструмента при 30d.
- **Rationale**: Assumption «без новых таблиц/миграций для v1»; объёмы данных внутренней команды малы. FR-013/SC-004 выполняются самим фактом предагрегации (ответ не растёт с числом строк), а не индексом.
- **Alternatives considered**: добавить `runs(created_at)` btree — отложено как будущая оптимизация (зафиксировать в quickstart/notes), вводится, если появится замер деградации; сейчас нарушило бы «no migration» без доказанной нужды.

## R11. Проводка вкладок и фильтров на фронте

- **Decision**: Один маршрут `/metrics` → `MetricsPage.vue`, внутри `el-tabs` (5 панелей). Общие фильтры живут в `MetricsPage` как reactive-объект и передаются панелям пропсом; активная вкладка и фильтры синхронизируются в query-string URL (`?tab=cost&period=7d&workspace=...&executor=...`) для дип-линка и сохранения при переключении вкладок. Каждая панель запускает свой `useMetrics*`-композабл с ключом по фильтрам; неактивные панели `el-tabs` монтирует лениво — запрос вкладки стартует при её открытии (edge case «переключение до догрузки» решается независимостью запросов).
- **Rationale**: повторяет паттерн Runs.vue (период — `el-radio-group`) и WorkspacePage (вкладки), но без 5 route-детей — проще, при этом дип-линк сохранён через query. Фильтры в URL → переживают переключение вкладок и перезагрузку (SC-002).
- **Alternatives considered**: 5 router-детей как в WorkspacePage (больше бойлерплейта, выигрыша нет); хранить фильтры в Pinia (избыточно — URL самодостаточен и шарится).

## Сводка решений

| # | Тема | Решение |
|---|------|---------|
| R1 | Chart lib | ECharts (tree-shaken) + vue-echarts, тема из `--el-color-*` |
| R2 | Бакеты | 24h→час, 7d/30d→день; `granularity` в ответе |
| R3 | Zero-fill | `generate_series` LEFT JOIN, нули на БД, UTC |
| R4 | Median/p95 | `percentile_cont` по завершённым прогонам |
| R5 | Форма рядов | пивот в `{buckets, series:[{key,points}]}` |
| R6 | «Не определено» | `coalesce(dim,'__unknown__')` (FR-014) |
| R7 | Эндпоинты | 5 штук, по вкладке, общие фильтры |
| R8 | Токены | `sum((usage->>'..')::bigint)` + coalesce |
| R9 | Индикативная цена | вынести util из Runs.vue, переиспользовать |
| R10 | Индексы | нет миграций в v1; future: `runs(created_at)` |
| R11 | Вкладки/фильтры | `/metrics`+el-tabs, фильтры и tab в query-string |

Все NEEDS CLARIFICATION из Technical Context разрешены. Готово к Phase 1.
