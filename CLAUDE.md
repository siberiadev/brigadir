# BRIGADIR

Оркестратор пайплайнов AI-кодинг-агентов поверх Jira. Внутренний инструмент команды (некоммерческий режим).

## Документы — источник правды

- `docs/plan-internal.md` — **актуальный рабочий план** (итерации, принятые решения); при противоречиях приоритет у него
- `docs/spec.md` — детальное ТЗ (эндпоинты, таблицы, поведение модулей)
- `docs/architecture.md` — схема БД (§3, реализована as-is), AgentExecutor (§4), callback-протокол (§5), ReportSchema (§6)
- `docs/progress.md` — журнал итераций; новые итерации дописываются туда
- `docs/local-setup.md` — локальный запуск (dev-режим, compose, секреты, грабли)
- `.specify/memory/constitution.md` — обязательные принципы; проверяется гейтами spec-kit

## Команды

- `pnpm typecheck && pnpm lint && pnpm test` — статика + юниты
- `pnpm test:integration` — интеграционные (vitest + testcontainers, нужен Docker; общие контейнеры на прогон — см. `test/integration/global-setup.ts`)
- `docker compose up --build` — полный стек (postgres, redis, backend, worker)

## UI-конвенции

- **Иконки — lucide (`lucide-vue-next`), и они анимируются на hover** (стиль lucide-animated.com, реш. 2026-07-14). Два яруса: (1) **универсальные эффекты целой иконки** — оборачивай в `<AnimatedIcon effect="spin|dip|pop|wiggle">` (`apps/web/src/components/AnimatedIcon.vue`); чтобы эффект срабатывал от наведения на родительскую кнопку/ссылку, повесь на неё класс `anim-trigger`. (2) **Пер-частные эффекты** (анимация отдельных path'ов глифа — плитки, стрелки) — ручной CSS рядом с местом использования; референсы — грид и logout в `AppSidebar.vue`. Для трансформов SVG-подэлементов обязательны `transform-box: fill-box` + `transform-origin: center`; `prefers-reduced-motion` уважать. Сверяй анатомию глифа с живым DOM — lucide меняет polyline/line на path между версиями.

## Выстраданные правила (нарушались — чинили)

1. **Никакой инициализации ресурсов в аргументах `@Module()`-декоратора.** Всё внутри `imports: [X.register()]` выполняется при ИМПОРТЕ файла — до тестовых `beforeAll` и поздних env. Соединения/креды/URL — только через DI-фабрики (`forRootAsync`/`useFactory`). Никаких молчаливых фолбэков на `localhost` — лучше упасть с ошибкой «env не задан». Composition-time чтение допустимо только для статической структуры (имена очередей) и документируется на месте. (Итерация 1: eager Redis-коннект увёл все тесты в хостовый redis — флак 50%, см. progress.md.)
2. **Прогоны неидемпотентны**: `maxStalledCount: 0`, дедуп на трёх уровнях (webhook id → BullMQ deduplication → partial unique index `runs_one_active`) — ни один уровень не убирать.
3. **В Jira пишет только система**, агенты только репортят через callback-тулзы. Все Jira-записи — через per-issue write queue.
4. **Тесты — в той же итерации, что и функциональность**; pipeline-логика без тестов не считается сделанной. Интеграционные тесты — против реальных Postgres/Redis (testcontainers), без моков брокера.
5. Схему БД из `docs/architecture.md` §3 не менять без обновления документа; миграции — коммитятся (`drizzle/`), ревью SQL против §3 обязательно.
6. **Изоляция тест-сьютов на общем ресурсе — неймспейсами, не flush'ем.** Redis имеет только 15 логических БД, сьютов больше — коллизии двух конкурентных сьютов в одной БД неизбежны; `flushdb` при этом сносит живые ключи соседа (его jobs исчезают, run висит в `queued`). Правильно: уникальный BullMQ `prefix` на сьют (`BULLMQ_PREFIX`, читается лениво в forRootAsync). (Итерация 4: флейк «stuck at queued» под полной нагрузкой.)
7. **Финализация из исхода процесса не должна затирать состояние из callback'ов.** Для callback-прогонов ВСЕ записи статуса, порождённые исходом процесса (fail-closed, cancelled, timed_out, retry), гвардятся `WHERE status='running'`; `markRunning` возвращает false для запаркованного прогона — job дропается, не исполняется. (Итерация 4: cancel-поллер затирал `awaiting_human` в `cancelled` — гонка, всплывшая на чекпоинте.)
