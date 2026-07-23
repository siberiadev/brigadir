# Quickstart: Проверка страницы /metrics

Валидация фичи end-to-end. Детали контрактов — в [contracts/metrics-api.md](./contracts/metrics-api.md), правила деривации — в [data-model.md](./data-model.md).

## Предпосылки
- Поднятый стек: `docker compose up --build` (postgres, redis, backend, worker) ИЛИ dev-режим (`docs/local-setup.md`).
- В `apps/web` добавлена зависимость `echarts` + `vue-echarts` (см. plan §Source Code). После добавления — `pnpm install` в корне.
- Есть `BRIGADIR_DASHBOARD_TOKEN` (из `.env`) для прямых запросов к API.
- Немного данных: минимум несколько прогонов за последние 7 дней с разными `status`/`executor_type`/`trigger_event.source` и хотя бы одна `human_task` (открытая и резолвленная). Для пустого-состояния — свежий воркспейс без прогонов.

## Проверка бэкенда (API)

```bash
TOKEN="$BRIGADIR_DASHBOARD_TOKEN"
BASE="http://localhost:3000/api/metrics"

# 1. Overview за 7 дней (скаляры)
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/overview?period=7d" | jq
# ожидаемо: { period:"7d", total_cost_usd:"…", run_count_by_status:{…8 ключей…}, success_rate, median_duration_s, open_human_tasks }

# 2. Cost за 30 дней — суточные бакеты, стек по executor_type
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/cost?period=30d" | jq '.cost_by_executor | {granularity, n_buckets:(.buckets|length), series:[.series[].key]}'
# ожидаемо: granularity:"day", n_buckets≈30, series содержит встречавшиеся executor_type

# 3. 24h — ПОЧАСОВЫЕ бакеты (R2)
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/reliability?period=24h" | jq '.runs_by_status.granularity'
# ожидаемо: "hour"

# 4. Zero-fill: длина points каждой серии == длине buckets
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/activity?period=7d" \
  | jq '.by_source as $s | ($s.buckets|length) as $n | [$s.series[] | (.points|length)==$n] | all'
# ожидаемо: true

# 5. Фильтр по воркспейсу — top_workspaces_by_cost схлопывается
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/cost?period=7d&workspace_id=<WS_UUID>" | jq '.top_workspaces_by_cost | length'
# ожидаемо: 0 (список бессмысленен при выбранном одном воркспейсе)

# 6. Human-in-the-loop
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/human?period=30d" | jq 'keys'
# ожидаемо: latency_median_s, latency_p95_s, opened_by_kind, closed_by_kind, awaiting_human_share

# 7. Guard: без токена — 401
curl -s -o /dev/null -w "%{http_code}\n" "$BASE/overview"
# ожидаемо: 401

# 8. Пустой фильтр (несуществующий executor) — 200 с плотными buckets и пустыми/нулевыми series
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/cost?period=7d&executor_type=does_not_exist" | jq '.cost_by_executor.series | length'
# ожидаемо: 0 (не ошибка)
```

## Проверка фронтенда (UI)

1. Открыть `http://localhost:5173/metrics` (dev) — сработал пункт «Metrics» в сайдбаре, страница открыта на вкладке **Обзор** (FR-002).
2. Обзор показывает карточки: суммарный расход, прогоны по статусам, success rate, медианная длительность, открытые задачи на людях (US1).
3. Сменить период 24h/7d/30d в общем фильтре — все карточки/графики пересчитались без перезагрузки; при 24h ось времени почасовая (R2).
4. Вкладка **Расходы и токены**: стек расходов по дням по executor_type; у сегментов kimi/deepseek_api — пометка оценочной стоимости (`~`/тултип, та же формулировка, что на Runs) (FR-008); график токенов с 4 раздельными величинами; топ воркспейсов по расходу.
5. Выбрать конкретный воркспейс в фильтре → топ воркспейсов скрывается/схлопывается, остальные графики сузились до воркспейса (US2 AS3).
6. Вкладка **Здоровье прогонов**: stacked area по статусам; success rate; median/p95 длительность; retry rate; failed/timed_out по executor_type.
7. Вкладка **Активность и триггеры**: три разбивки (источник/роль/воркспейс); прогоны без роли — в явной категории «не определено» (FR-014).
8. Вкладка **Люди в контуре**: латентность резолюции (медиана/p95), открытые/закрытые по kind, доля awaiting_human.
9. Переключить на воркспейс без данных (или период без данных) → каждый график показывает empty-state (el-empty), без ошибок и вечных спиннеров (FR-016, SC-005).
10. Переключение вкладок сохраняет выбранные фильтры (в query-string URL); дип-линк `/metrics?tab=cost&period=30d` открывает нужную вкладку с фильтром (SC-002, R11).
11. Тёмная/светлая тема: цвета серий берутся из `--el-color-*`, корректны в обеих темах (реш. 2026-07-16).

## Автотесты (гейты)

```bash
pnpm typecheck && pnpm lint && pnpm test         # vue-tsc + контракт-round-trip (metrics.schema.spec) + web-компоненты (MetricsPage.spec)
pnpm test:integration                            # test/integration/metrics.spec.ts — реальный Postgres: бакетинг, zero-fill, median/p95, «не определено», фильтры, 401
```

Интеграционный тест сидирует прогоны на разные дни/статусы/executor'ы и human-tasks (открытые+резолвленные) и проверяет инварианты из contracts §Инварианты (в т.ч. консистентность overview↔reliability, SC-003).

## Заметки / будущее (не входит в v1)
- Индекс `runs(created_at)` — добавить, если замер покажет деградацию агрегатов на всех воркспейсах при 30d (R10). Сейчас миграций нет.
- Точная историческая доля «когда-либо уходил в awaiting_human» требует лога переходов статуса (его нет) — v1 использует текущий `status='awaiting_human'` и помечает это в UI (data-model §Human).
- Экспорт графиков, произвольный диапазон дат, real-time обновление — вне v1 (spec §Assumptions).
