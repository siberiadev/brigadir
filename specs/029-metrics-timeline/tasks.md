# Tasks: Страница /metrics — кумулятивная статистика на графиках

**Input**: Design documents from `specs/029-metrics-timeline/` (spec.md, plan.md, research.md, data-model.md, contracts/metrics-api.md, quickstart.md)

**Tests**: Эта фича — read-only проекция (не pipeline-логика, конституция VI не требует тестов формально), но по правилу CLAUDE.md #4 («тесты — в той же итерации, что и функциональность») и по плану (plan.md §Testing) тесты включены: интеграционные против реального Postgres для агрегатов, contract round-trip для схем, лёгкое компонентное покрытие для UI.

**Organization**: Задачи сгруппированы по user story (US1–US5, приоритеты из spec.md). Каждая история — независимо тестируемый инкремент.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: можно выполнять параллельно (разные файлы, нет зависимости от незавершённых задач)
- **[Story]**: US1–US5, см. spec.md
- Пути — абсолютные относительно корня репозитория

---

## Phase 1: Setup

**Purpose**: Подготовка новой зависимости фронтенда.

- [X] T001 Добавить `echarts` и `vue-echarts` в `apps/web/package.json` (dependencies), выполнить `pnpm install` в корне монорепо — фиксирует lockfile для решения R1 (research.md)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Общая инфраструктура — контракты, бэкенд-хелперы, роутинг/фильтры фронтенда, необходимые ВСЕМ пяти вкладкам.

**⚠️ CRITICAL**: Ни одна user story не может начаться, пока эта фаза не завершена.

- [X] T002 [P] Создать `packages/contracts/src/metrics.schema.ts` с общими схемами: `MetricsFilterQuerySchema` (period/workspace_id?/executor_type?, см. contracts/metrics-api.md §Общие query-параметры), `MetricsGranularitySchema` (`hour`|`day`), `MetricsSeriesSchema`, `TimeBucketedSeriesSchema` — переиспользовать `RunStatusSchema`/`RunCostPeriodSchema` из `runs.schema.ts`
- [X] T003 Добавить `export * from './metrics.schema';` в `packages/contracts/src/index.ts` (зависит от T002)
- [X] T004 Создать `apps/backend/src/dashboard/metrics.helpers.ts`: `parseMetricsFilters()` (парсинг period/workspace_id/executor_type из query, `.catch('7d')` как у существующего cost-эндпоинта; невалидный `workspace_id` → пустой результат, не 4xx, M8), выбор гранулярности (`period==='24h' ? 'hour' : 'day'`, R2), SQL-хелпер плотной бакет-сетки через `generate_series` с **явным UTC-усечением** `date_trunc(gran, ts, 'UTC')` (не полагаться на session TimeZone, M4/R3), функция пивота long-строк БД в `TimeBucketedSeries` (`{buckets, series:[{key,points}]}`, R5), хелпер `coalesce(dimension, '__unknown__')` (R6)
- [X] T005 Создать каркас `apps/backend/src/dashboard/metrics.controller.ts`: `@Controller('api/metrics') @UseGuards(DashboardTokenGuard)` (импорт `DashboardTokenGuard` из локального `./dashboard-token.guard`, как в `home.controller.ts` — НЕ из `libs/app-config`, L3), конструктор с `@Inject(DRIZZLE)` — без эндпоинтов (методы добавляются в фазах US1–US5, один файл, не параллелится)
- [X] T006 Зарегистрировать `MetricsController` в `apps/backend/src/dashboard/dashboard.module.ts` (зависит от T005)
- [X] T007 [P] Создать `apps/web/src/charts/echarts.ts` — регистрация tree-shaken ECharts (`BarChart`, `LineChart`, `GridComponent`, `TooltipComponent`, `LegendComponent`, `CanvasRenderer` через `echarts/core`), функция построения базовой темы графика из `var(--el-color-*)` (реш. 2026-07-16) — зависит от T001
- [X] T008 [P] Создать каркас `apps/web/src/api/metrics.ts` — `metricsApi()` фабрика с базовым `client: ApiClient = apiClient` (по образцу `apps/web/src/api/home.ts`), без методов (добавляются в фазах US1–US5)
- [X] T009 [P] Создать `apps/web/src/components/Metrics/ChartCard.vue` — переиспользуемая обёртка графика: заголовок (slot), `<v-chart :option>` (из T007), `el-empty` для пустого состояния (FR-016), `v-loading` во время загрузки
- [X] T010 [P] Создать `apps/web/src/utils/executorCost.ts` — вынести `INDICATIVE_COST_PROVIDERS`, `costIsIndicative()`, `indicativeCostTip()` из inline-копий; учесть, что копий **ТРИ**, не две (M6): `Runs.vue` (функция `indicativeCostTip(row)`) и `RunCard.vue` (computed `INDICATIVE_COST_TIP`) — util должен покрыть оба паттерна с сохранением поведения каждого
- [X] T011 Обновить `apps/web/src/views/Runs.vue` **И** `apps/web/src/views/RunCard.vue`: заменить inline-копии `INDICATIVE_COST_PROVIDERS`/`costIsIndicative`/tip на импорт из `apps/web/src/utils/executorCost.ts` — поведение обоих не меняется (зависит от T010, M6)
- [X] T011b [P] Создать `apps/web/src/utils/metricsLabels.ts` — единый map человекочитаемых лейблов для статусов прогона, `trigger_event.source`, ролей и `__unknown__`→«не определено», переиспользуя существующие подписи дашборда (RunStatusTag и др.); все Metrics-компоненты берут подписи отсюда, а не переизобретают (FR-017, M5)
- [X] T012 Создать `apps/web/src/components/Metrics/MetricsFilters.vue` — общие фильтры: `el-radio-group` период 24h/7d/30d (по образцу `apps/web/src/views/Runs.vue`), пикер воркспейса (переиспользовать `useWorkspaces` с `MAX_PAGE_SIZE`, конвенция «потребитель всего списка не листает»), пикер executor_type (переиспользовать `useExecutors`), `clearable` для «все». Компонент принимает проп/сигнал активной вкладки: на вкладке «Люди в контуре» пикер `executor_type` ДОЛЖЕН быть `disabled` с тултипом «неприменимо к задачам на людях» (H1/FR-011a)
- [X] T013 Создать каркас `apps/web/src/views/MetricsPage.vue` — `el-tabs` с 5 лениво монтируемыми панелями (Обзор/Расходы и токены/Здоровье прогонов/Активность и триггеры/Люди в контуре), монтирует `MetricsFilters.vue` (T012), reactive-объект фильтров передаётся панелям пропсом, синхронизация активной вкладки и фильтров с query-string URL (`?tab=&period=&workspace=&executor=`, R11) — панели пока заглушки, наполняются в фазах US1–US5
- [X] T014 Добавить маршрут `/metrics` → `MetricsPage.vue` в `apps/web/src/router/index.ts` (зависит от T013)
- [X] T015 Добавить пункт «Metrics» (иконка `BarChart3` из `lucide-vue-next`, без hover-анимации вне сайдбара) в `navItems` компонента `apps/web/src/components/AppSidebar.vue`, `isActive: (path) => path === '/metrics'`

**Checkpoint**: Инфраструктура готова — можно параллельно (по историям, не по задачам внутри истории) начинать US1–US5.

---

## Phase 3: User Story 1 - Обзор состояния системы одним взглядом (Priority: P1) 🎯 MVP

**Goal**: Вкладка «Обзор» — сводные карточки за период, открыта по умолчанию (FR-002, FR-006).

**Independent Test**: Открыть `/metrics` без доп. действий — вкладка «Обзор» показывает непустые/явно нулевые карточки по всем пяти метрикам за период по умолчанию (spec.md US1).

- [X] T016 [US1] Создать `test/integration/metrics.spec.ts` (базовый файл, дополняется в US2–US5): гарнесс по образцу `test/integration/runs-global.spec.ts` (`startDatabase`, `seedPipeline`/ручной сид, `TEST_DASHBOARD_TOKEN`); тест-кейсы для `GET /api/metrics/overview` — сид прогонов с разными `status`/`created_at`/`finished_at` (в т.ч. незавершённые) + `human_tasks` (open + resolved): проверить `run_count_by_status` (все 8 ключей, 0 по умолчанию), `success_rate` (исключая queued/running/awaiting_human/superseded из знаменателя, null при 0), `median_duration_s` (незавершённые прогоны НЕ искажают, FR-012), `open_human_tasks`, `total_cost_usd` как строка; **кейс H1**: с фильтром `executor_type` карточка `open_human_tasks` не меняется (executor не применяется); **кейс M4**: явная UTC-граница бакетов не зависит от session TimeZone (прогон у границы суток попадает в ожидаемый UTC-бакет); отдельный кейс — `401` без токена (DashboardTokenGuard)
- [X] T017 [US1] Добавить `MetricsOverviewResponseSchema` в `packages/contracts/src/metrics.schema.ts` (см. contracts/metrics-api.md §1)
- [X] T018 [US1] [P] Добавить round-trip тест `MetricsOverviewResponseSchema` в `packages/contracts/src/metrics.schema.spec.ts` (по образцу `home.schema.spec.ts`)
- [X] T019 [US1] Реализовать `GET api/metrics/overview` в `apps/backend/src/dashboard/metrics.controller.ts`: `total_cost_usd` (`coalesce(sum(cost_usd),0)::text`), `run_count_by_status` (GROUP BY status, все статусы с 0-дефолтом), `success_rate` (succeeded/(succeeded+failed+timed_out+cancelled), null при 0), `median_duration_s` (`percentile_cont(0.5)` только по прогонам с `started_at`/`finished_at` NOT NULL, R4), `open_human_tasks` (`human_tasks.status='open'`, фильтр `period`+`workspace_id`, **`executor_type` НЕ применять** — H1/FR-011a) — использует `metrics.helpers.ts` (T004) для парсинга фильтров
- [X] T020 [US1] Добавить метод `overview()` в `apps/web/src/api/metrics.ts`
- [X] T021 [US1] Создать `apps/web/src/composables/useMetrics.ts` с `useMetricsOverview()` (TanStack Query, `queryKey` по фильтрам, `placeholderData: (prev) => prev`, по образцу `useRunsCost` в `apps/web/src/composables/useRuns.ts`)
- [X] T022 [US1] Создать `apps/web/src/components/Metrics/MetricsOverview.vue`: 5 компактных карточек (расход, прогоны по статусам, success rate, медианная длительность, открытые human tasks) поверх `ChartCard.vue`/обычных `el-card`, пустое состояние при отсутствии данных (FR-016)
- [X] T023 [US1] Смонтировать `MetricsOverview.vue` как первую (дефолтную) панель в `apps/web/src/views/MetricsPage.vue` (FR-002)
- [X] T024 [US1] [P] Компонентный тест `apps/web/src/components/Metrics/__tests__/MetricsOverview.spec.ts` (msw-мок ответа, рендер карточек, пустое состояние, пересчёт при смене периода)

**Checkpoint**: US1 самостоятельно демонстрируем — `/metrics` открывается на «Обзоре» с реальными данными. MVP.

---

## Phase 4: User Story 2 - Анализ расходов и токенов по провайдерам (Priority: P1)

**Goal**: Вкладка «Расходы и токены» — динамика расхода/токенов по дням, срез по executor_type и воркспейсам.

**Independent Test**: Вкладка с периодом 7d без фильтра по воркспейсу показывает стек расхода по executor_type и топ воркспейсов (spec.md US2).

- [X] T025 [US2] Добавить `MetricsCostResponseSchema` в `metrics.schema.ts` (`cost_by_executor`, `tokens_by_type`, `cost_per_run`, `top_workspaces_by_cost` — contracts/metrics-api.md §2)
- [X] T026 [US2] [P] Round-trip тест `MetricsCostResponseSchema` в `metrics.schema.spec.ts`
- [X] T027 [US2] Дополнить `test/integration/metrics.spec.ts` кейсами для `GET /api/metrics/cost`: сид прогонов с разными `executor_type` (в т.ч. kimi/deepseek_api) и `usage` jsonb (все 4 типа токенов) в нескольких воркспейсах — проверить стек `cost_by_executor`, суммы `tokens_by_type` (R8, coalesce 0 при отсутствующем ключе), `cost_per_run`, `top_workspaces_by_cost` присутствует ТОЛЬКО без `workspace_id`-фильтра (пуст при фильтре, US2 AS3), инвариант `points.length === buckets.length`, zero-fill (R3)
- [X] T028 [US2] Реализовать `GET api/metrics/cost` в `metrics.controller.ts` через хелперы `metrics.helpers.ts` (генерация бакетов, пивот, `__unknown__` не нужен — executor_type notNull); `top_workspaces_by_cost` — `ORDER BY sum DESC LIMIT 10` (M7), пустой массив при заданном `workspace_id`
- [X] T029 [US2] Добавить метод `cost()` в `apps/web/src/api/metrics.ts`
- [X] T030 [US2] Добавить `useMetricsCost()` в `apps/web/src/composables/useMetrics.ts`
- [X] T031 [US2] Создать `apps/web/src/components/Metrics/MetricsCost.vue`: стек расхода по executor_type (индикативная пометка kimi/deepseek_api через `utils/executorCost.ts`, T010, FR-008), график токенов (4 линии), cost-per-run, бар топ-воркспейсов
- [X] T032 [US2] Смонтировать `MetricsCost.vue` как вторую панель в `MetricsPage.vue`
- [X] T033 [US2] [P] Компонентный тест `apps/web/src/components/Metrics/__tests__/MetricsCost.spec.ts`: рендер индикативной пометки, скрытие/пустота топ-воркспейсов при выбранном фильтре воркспейса

**Checkpoint**: US1+US2 — обе P1-истории готовы независимо.

---

## Phase 5: User Story 3 - Оценка надёжности прогонов во времени (Priority: P2)

**Goal**: Вкладка «Здоровье прогонов» — статусы/success rate/длительность/retry по дням.

**Independent Test**: Период 30d показывает график прогонов по статусу, success rate и медианную/p95 длительность по дням (spec.md US3).

- [X] T034 [US3] Добавить `MetricsReliabilityResponseSchema` в `metrics.schema.ts` (contracts/metrics-api.md §3)
- [X] T035 [US3] [P] Round-trip тест `MetricsReliabilityResponseSchema`
- [X] T036 [US3] Дополнить `metrics.spec.ts` кейсами для `GET /api/metrics/reliability`: сид прогонов во всех статусах (несколько дней, разные `executor_type`, часть с `attempt>1`) — проверить `runs_by_status` (нулевые сегменты в дни без статуса, не разрыв, FR-005/R3), `success_rate` по бакету, `duration_median_s`/`duration_p95_s` (`percentile_cont`, только завершённые, незавершённые НЕ искажают — FR-012/R4), **кейс M2**: прогон с `created_at` в один день и `finished_at` в следующий попадает в бакет длительности по дню ЗАВЕРШЕНИЯ (`finished_at`, FR-005a), а не создания; `retry_rate`, `failstats_by_executor`
- [X] T037 [US3] Реализовать `GET api/metrics/reliability` в `metrics.controller.ts`
- [X] T038 [US3] Добавить метод `reliability()` в `apps/web/src/api/metrics.ts`
- [X] T039 [US3] Добавить `useMetricsReliability()` в `useMetrics.ts`
- [X] T040 [US3] Создать `apps/web/src/components/Metrics/MetricsReliability.vue`: stacked area по статусам, линия success rate, линии median/p95 длительности, линия retry rate, стек failed/timed_out по executor_type
- [X] T041 [US3] Смонтировать `MetricsReliability.vue` как третью панель в `MetricsPage.vue`
- [X] T042 [US3] [P] Компонентный тест `MetricsReliability.spec.ts`

**Checkpoint**: P1+P2 истории готовы.

---

## Phase 6: User Story 4 - Понимание источников активности и распределения по агентам/бордам (Priority: P3)

**Goal**: Вкладка «Активность и триггеры» — три независимые разбивки количества прогонов.

**Independent Test**: Видны три графика — по `trigger_event.source`, по роли агента, по воркспейсу/борде (spec.md US4).

- [X] T043 [US4] Добавить `MetricsActivityResponseSchema` в `metrics.schema.ts` (contracts/metrics-api.md §4)
- [X] T044 [US4] [P] Round-trip тест `MetricsActivityResponseSchema`
- [X] T045 [US4] Дополнить `metrics.spec.ts` кейсами для `GET /api/metrics/activity`: сид прогонов с разными `trigger_event.source` (включая NULL), разными ролями агента (включая агента с `role IS NULL`), несколькими воркспейсами — проверить категорию `__unknown__` при NULL источнике/роли (FR-014, R6, счётчик не теряется из общей суммы), `by_workspace` с человекочитаемым `label`
- [X] T046 [US4] Реализовать `GET api/metrics/activity` в `metrics.controller.ts`
- [X] T047 [US4] Добавить метод `activity()` в `apps/web/src/api/metrics.ts`
- [X] T048 [US4] Добавить `useMetricsActivity()` в `useMetrics.ts`
- [X] T049 [US4] Создать `apps/web/src/components/Metrics/MetricsActivity.vue`: три графика (источник/роль/воркспейс), `__unknown__` подписан как «не определено» (согласовано с FR-017 — единая терминология с остальным дашбордом)
- [X] T050 [US4] Смонтировать `MetricsActivity.vue` как четвёртую панель в `MetricsPage.vue`
- [X] T051 [US4] [P] Компонентный тест `MetricsActivity.spec.ts`

**Checkpoint**: 4 из 5 вкладок готовы.

---

## Phase 7: User Story 5 - Мониторинг задач с участием людей (Priority: P3)

**Goal**: Вкладка «Люди в контуре» — латентность резолюции, открытые/закрытые задачи, доля awaiting_human.

**Independent Test**: Видны латентность резолюции (медиана/p95), открытые/закрытые задачи по дням, доля прогонов в ожидании человека (spec.md US5).

- [X] T052 [US5] Добавить `MetricsHumanResponseSchema` в `metrics.schema.ts` (contracts/metrics-api.md §5)
- [X] T053 [US5] [P] Round-trip тест `MetricsHumanResponseSchema`
- [X] T054 [US5] Дополнить `metrics.spec.ts` кейсами для `GET /api/metrics/human`: сид `human_tasks` разных `kind`, часть с `resolved_at` (разная латентность), часть ещё открытых — проверить, что в медиану/p95 латентности попадают ТОЛЬКО резолвленные (spec.md US5 AS1), `opened_by_kind`/`closed_by_kind` по разным якорным датам (`created_at`/`resolved_at`), `awaiting_human_share` по прогонам с текущим `status='awaiting_human'`; **кейс H1**: передача `executor_type` в query НЕ влияет на результат `/human` (фильтр игнорируется)
- [X] T055 [US5] Реализовать `GET api/metrics/human` в `metrics.controller.ts` — фильтры `period`+`workspace_id` только, `executor_type` игнорируется (H1/FR-011a)
- [X] T056 [US5] Добавить метод `human()` в `apps/web/src/api/metrics.ts`
- [X] T057 [US5] Добавить `useMetricsHuman()` в `useMetrics.ts`
- [X] T058 [US5] Создать `apps/web/src/components/Metrics/MetricsHuman.vue`: линии латентности (median/p95), бары opened/closed by kind, линия доли awaiting_human (подпись «сейчас в ожидании» — data-model.md примечание про отсутствие лога переходов)
- [X] T059 [US5] Смонтировать `MetricsHuman.vue` как пятую панель в `MetricsPage.vue`
- [X] T060 [US5] [P] Компонентный тест `MetricsHuman.spec.ts`

**Checkpoint**: Все 5 вкладок реализованы и независимо протестированы.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Сквозные проверки, не привязанные к одной истории.

- [X] T061 [P] Компонентный тест `apps/web/src/views/__tests__/MetricsPage.spec.ts`: переключение вкладок без потери фильтров (query-string, R11/SC-002), ленивая загрузка панелей (переключение до догрузки данных предыдущей вкладки не блокирует, edge case из spec.md), корректность иконки/пункта сайдбара
- [X] T062 [P] Прогнать `pnpm typecheck && pnpm lint && pnpm test` в корне — устранить расхождения по всем пакетам (contracts/backend/web)
- [X] T063 Прогнать `pnpm test:integration` (testcontainers) — весь `test/integration/metrics.spec.ts` зелёный, включая инварианты из contracts/metrics-api.md §Инварианты (`points.length===buckets.length`, консистентность overview↔reliability по `run_count_by_status`, SC-003)
- [X] T063b [P] Добавить в `metrics.spec.ts` smoke-ассерт предагрегации (FR-013/SC-004, M9): при существенно разном числе засеянных прогонов за один и тот же период размер ответа/число бакетов ряда НЕ растёт (число `buckets` определяется периодом+гранулярностью, а не количеством строк) — доказывает, что ответ не построчный
- [X] T064 Пройти чек-лист `quickstart.md` вручную (curl-проверки API п.1–8 + UI-чеклист п.1–11) — приложить результат к PR
- [X] T065 [P] Добавить запись итерации в `docs/progress.md` (конвенция проекта: «новые итерации дописываются туда») — фича 029, дата, краткое summary решений (5 эндпоинтов, ECharts, без миграций)

---

## Dependencies & Execution Order

- **Phase 1 (Setup)** → блокирует T007 (нужен установленный `echarts`).
- **Phase 2 (Foundational)** → блокирует ВСЕ user-story фазы (T016–T060). Внутри Phase 2: T003 зависит от T002; T006 зависит от T005; T011 зависит от T010; T014 зависит от T013; T012 используется T013 (смонтирован туда).
- **User Story фазы (3–7)** — каждая независима от других (разные эндпоинты, разные Vue-компоненты); общий файл `metrics.controller.ts` и `metrics.schema.ts`/`metrics.spec.ts`/`useMetrics.ts`/`MetricsPage.vue` редактируются последовательно каждой историей (не параллельны МЕЖДУ историями на уровне файла, хотя истории логически независимы) — при параллельном запуске нескольких историй разными агентами эти файлы станут точкой конфликта, см. ниже.
- **Внутри каждой user-story фазы**: тест данных (Txxx integration case) и схема (Txxx contract schema) можно писать параллельно ([P] на round-trip тесте), реализация эндпоинта — после схемы; фронтенд api/composable/component — после реализации эндпоинта (нужна форма ответа); монтаж в `MetricsPage.vue` — последний шаг истории.
- **Phase 8 (Polish)** → после ВСЕХ пяти историй.

## Parallel Execution Examples

- **Phase 2**: T002, T007, T008, T009, T010 — разные файлы, без взаимных зависимостей → запускать параллельно. T003/T006/T011/T014 — зависимы, строго после соответствующей предпосылки.
- **Между историями**: если несколько агентов работают параллельно, КАЖДЫЙ должен получить отдельную историю целиком (не смешивать T0xx из разных фаз в одном коммите) и координировать правки в общих файлах (`metrics.controller.ts`, `metrics.schema.ts`, `metrics.spec.ts`, `useMetrics.ts`, `MetricsPage.vue`) — на практике для этой фичи (один PR по конвенции проекта) рекомендуется **последовательная реализация историй одним потоком** (см. рекомендацию в разговоре с пользователем), а не параллельный фан-аут.
- **Round-trip тесты** (T018, T026, T035, T044, T053) — независимы друг от друга и от integration-теста своей истории → [P].

## Implementation Strategy

**MVP = Phase 1 + Phase 2 + Phase 3 (US1)**: страница `/metrics` открывается, показывает вкладку «Обзор» с реальными данными за период. Дальше — инкрементально по приоритету: US2 (вторая P1-история) → US3 (P2) → US4/US5 (P3, порядок между собой не важен, обе независимы). Каждый чекпоинт — самостоятельно демонстрируемый инкремент.

**Итого**: 67 задач · US1: 9 · US2: 9 · US3: 9 · US4: 9 · US5: 9 · Setup: 1 · Foundational: 15 (добавлена T011b label-map, M5) · Polish: 6 (добавлена T063b perf-smoke, M9). Правки после `/speckit-analyze`: H1 (executor_type N/A для human — T012/T016/T019/T054/T055), M2 (якорь длительности — T036), M4 (UTC — T004/T016), M6 (RunCard в T010/T011), M7 (top-N=10 — T028), M8 (invalid workspace — T004), L3 (импорт guard — T005).
