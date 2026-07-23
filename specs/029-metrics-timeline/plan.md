# Implementation Plan: Страница /metrics — кумулятивная статистика на графиках

**Branch**: `029-metrics-timeline` | **Date**: 2026-07-22 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/029-metrics-timeline/spec.md`

## Summary

Новая страница дашборда `/metrics` с пятью вкладками (Обзор, Расходы и токены, Здоровье прогонов, Активность и триггеры, Люди в контуре) и общими фильтрами сверху (период 24h/7d/30d, воркспейс/борда, executor_type). Все графики — временны́е ряды, предагрегированные на бэкенде по бакетам времени (FR-013): это первый в кодовой базе набор `date_trunc`/`generate_series`/`percentile_cont`-агрегатов. Данные читаются только из существующих таблиц (`runs`, `human_tasks`, `agents`, `workspaces`) — **без новых таблиц и миграций** (Assumption). Бэкенд — новый read-only `MetricsController` (5 эндпоинтов `GET /api/metrics/*` за `DashboardTokenGuard`), контракты — новый `packages/contracts/src/metrics.schema.ts`. Фронтенд — новая графическая библиотека (**ECharts** через tree-shaken `echarts/core` + `vue-echarts`), страница `MetricsPage.vue` с `el-tabs` и пятью панелями, композаблы поверх TanStack Query.

## Technical Context

**Language/Version**: TypeScript 5.7 (strict, весь монорепозиторий)

**Primary Dependencies**: Backend — NestJS 11, Drizzle ORM (raw `sql` для агрегатов), Postgres 16. Frontend — Vue 3.5, TanStack Vue Query 5, Element Plus 2.9, **echarts 5 + vue-echarts 7 (новая зависимость `apps/web`)**. Контракты — zod в `packages/contracts`.

**Storage**: Postgres 16 — существующие таблицы `runs` (created_at/started_at/finished_at/cost_usd/usage jsonb/status/executor_type/attempt/trigger_event jsonb/workspace_id/ticket_id/agent_id), `human_tasks` (kind/status/created_at/resolved_at), `agents` (role), `workspaces` (jira_board_id/jira_board_type/name). Схема НЕ меняется.

**Testing**: Backend — vitest + testcontainers (реальный Postgres) для агрегирующих эндпоинтов; `*.schema.spec.ts` (zod round-trip) для контрактов. Frontend — vitest + @vue/test-utils (msw) для страницы и панелей, облегчённое покрытие (конституция VI: UI — lighter coverage).

**Target Platform**: Self-hosted веб-дашборд (Linux backend + браузер).

**Project Type**: Web (pnpm-монорепо: `apps/backend` NestJS, `apps/web` Vue, `packages/contracts` общие схемы, `libs/database` Drizzle).

**Performance Goals**: Отклик страницы не растёт линейно с общим числом прогонов (FR-013, SC-004): ответы предагрегированы (≤~31 бакет × ≤~8 категорий на ряд), не построчные. Смена фильтра — единицы секунд при периоде 30d.

**Constraints**: Деньги сериализуются СТРОКОЙ (numeric round-trip, не float) — существующая конвенция. Незавершённые прогоны не искажают длительность (FR-012). Пропуски в рядах заполняются нулями (FR-005). Прогоны без применимого измерения → явная категория «не определено» (FR-014). Единая таймзона агрегации (UTC/сервер, Assumption).

**Scale/Scope**: Внутренний инструмент, одна команда; объёмы `runs` умеренные. 5 эндпоинтов, 1 страница, 5 панелей, ~13 графиков/карточек суммарно.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Проверено против `.specify/memory/constitution.md` v1.2.0:

- **I. Dual Source of Truth** — ✅ Фича только читает Postgres (система записи run-истории); Jira не трогается, новый источник правды не вводится. `tickets.last_seen_*` не используется как авторитет (борда как измерение берётся из `workspaces.jira_board_*`).
- **II. Idempotency at Three Levels** — ✅ N/A: нет ни одного run-triggering-пути; страница read-only.
- **III. System-Only Jira Writes** — ✅ Ноль записей в Jira; агенты не участвуют.
- **IV. Run Completion Contract** — ✅ Не затрагивается; фича не финализирует прогоны.
- **V. Secret Isolation & Output Scrubbing** — ✅ `DashboardTokenGuard` как у остального дашборда (FR-015); в SELECT не попадают креды (только числа/статусы/токены/стоимость); отдаваемые агрегаты не содержат свободного текста агентов → скраббер не требуется, но ни одно поле с сырьём отчёта наружу не выводится.
- **VI. Test-Mandatory Pipeline Logic** — ✅ Это НЕ pipeline-логика (нет ingest/dedup/state-machine/callback/transition). Тем не менее по правилу CLAUDE.md #4 («тесты в той же итерации») агрегирующие эндпоинты покрываются интеграционными тестами против реального Postgres, а контракты — round-trip-тестами.
- **Технологические ограничения** — ✅ TS strict; NestJS-контроллер; Drizzle `sql`; Vue + TanStack Query; общие типы в `packages/contracts`; ленивое разрешение ресурсов не затрагивается (новых `@Module()`-аргументов с side-effect нет). Новая зависимость `echarts`/`vue-echarts` — фронтенд-библиотека в рамках Vue-приложения, не смена фиксированного стека (backend/queue/db/framework неизменны) → амендмент конституции НЕ требуется.

**Итог гейта: PASS. Нарушений нет — Complexity Tracking пуст.**

## Project Structure

### Documentation (this feature)

```text
specs/029-metrics-timeline/
├── plan.md              # This file
├── research.md          # Phase 0 output — решения (chart lib, бакетинг, median, zero-fill)
├── data-model.md        # Phase 1 output — read-model (Bucket/Series/OverviewSummary) + источники и правила деривации
├── quickstart.md        # Phase 1 output — как проверить фичу end-to-end
├── contracts/
│   └── metrics-api.md    # Phase 1 output — 5 эндпоинтов + формы ответов
└── checklists/
    └── requirements.md   # уже создан на этапе /speckit-specify
```

### Source Code (repository root)

```text
packages/contracts/src/
├── metrics.schema.ts          # НОВЫЙ — query-параметры (период/воркспейс/executor_type) + response-схемы 5 эндпоинтов; переиспользует RunStatusSchema/RunCostPeriodSchema/TriggerEventSource
├── metrics.schema.spec.ts     # НОВЫЙ — zod round-trip (по образцу home.schema.spec.ts)
└── index.ts                   # ПРАВКА — добавить `export * from './metrics.schema'`

apps/backend/src/dashboard/
├── metrics.controller.ts      # НОВЫЙ — @Controller('api/metrics') @UseGuards(DashboardTokenGuard); 5 GET-методов; общий парсинг фильтров + сборка WHERE
├── metrics.helpers.ts         # НОВЫЙ — parseMetricsFilters, выбор гранулярности бакета, generate_series-хелпер, пивот long→wide
└── dashboard.module.ts        # ПРАВКА — зарегистрировать MetricsController

apps/web/src/
├── api/metrics.ts             # НОВЫЙ — metricsApi(): 5 client.get врапперов
├── composables/useMetrics.ts  # НОВЫЙ — useMetricsOverview/Cost/Reliability/Activity/Human (TanStack Query, ключ по фильтрам, placeholderData)
├── views/MetricsPage.vue      # НОВЫЙ — общие фильтры + el-tabs с 5 панелями
├── components/Metrics/
│   ├── MetricsFilters.vue     # НОВЫЙ — период (el-radio-group как в Runs) + воркспейс-пикер + executor-пикер
│   ├── MetricsOverview.vue    # НОВЫЙ — компактные карточки/мини-чарты (US1)
│   ├── MetricsCost.vue        # НОВЫЙ — US2
│   ├── MetricsReliability.vue # НОВЫЙ — US3
│   ├── MetricsActivity.vue    # НОВЫЙ — US4
│   ├── MetricsHuman.vue       # НОВЫЙ — US5
│   └── ChartCard.vue          # НОВЫЙ — обёртка: заголовок + <v-chart> + empty-state (el-empty) + theme-aware опции
├── charts/echarts.ts          # НОВЫЙ — регистрация tree-shaken echarts (Bar/Line/Bar-stack, Grid/Tooltip/Legend), общая тема через var(--el-color-*)
├── utils/executorCost.ts      # НОВЫЙ — вынести INDICATIVE_COST_PROVIDERS/costIsIndicative из Runs.vue (DRY), переиспользовать в MetricsCost и Runs.vue
├── router/index.ts            # ПРАВКА — route `/metrics` → MetricsPage.vue
└── components/AppSidebar.vue   # ПРАВКА — пункт «Metrics» (lucide BarChart3), isActive `/metrics`-prefix

apps/web/src/views/Runs.vue    # ПРАВКА (мелкий рефактор) — импорт costIsIndicative из utils/executorCost вместо inline-копии

test/integration/
└── metrics.spec.ts            # НОВЫЙ — сид прогонов/human-tasks по дням/статусам/executor'ам → проверка бакетинга, zero-fill, median/p95, «не определено», фильтров, DashboardTokenGuard(401)

apps/web/src/components/Metrics/__tests__/  (или рядом *.spec.ts)
└── MetricsPage.spec.ts        # НОВЫЙ — вкладки, проводка фильтров, пустые состояния, индикативная пометка
```

**Structure Decision**: Web-монорепо (backend NestJS + frontend Vue + общий пакет контрактов). Следуем сложившемуся паттерну dashboard-фич (017 home): контракт-схема в `packages/contracts` → тонкий read-only контроллер в `apps/backend/src/dashboard` → `api/` враппер + `composables/` (TanStack Query) + `views/`/`components/` во фронтенде. Новизна фичи (агрегаты `date_trunc`/`generate_series`/`percentile_cont` и графическая библиотека) изолирована в `metrics.helpers.ts` (бэкенд) и `charts/`+`components/Metrics/` (фронтенд), не размазана по существующим модулям.

## Complexity Tracking

> Нет нарушений конституции — таблица не заполняется.
