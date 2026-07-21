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

## Возможность: собрать команду под борду через `brigadir-admin` (admin-MCP)

**Если пользователь просит «собрать команду/агентов под борду», «создать workspace», «настроить MCP для создания workspace и agents» — предложи подключить `brigadir-admin` и сверься с этим разделом.** Это stdio MCP-сервер (`packages/admin-mcp`, feature 012), который человек+Claude Code используют СНАРУЖИ прогона: recon борды → `create_workspace` (всегда PAUSED) → `generate_agents`/`create_team`/`create_agent`. НЕ путать с callback-MCP `brigadir-mcp` (тот — для агента ВНУТРИ прогона). 9 тулз, детали — `docs/architecture.md` §«Админская плоскость».

Подключение (project-scoped, коммитится, подхватывается Claude Code при старте):
1. Конфиг уже лежит в корне — **`.mcp.json`** (сервер `brigadir-admin`, `${VAR}`-ссылки на env).
2. Собрать сервер (в gitignore, после клона нужен build): `pnpm --filter @brigadir/admin-mcp build`.
3. Env для сервера (4 шт., только из env — Принцип V): `BRIGADIR_API_URL` (обычно `http://localhost:3000`), `BRIGADIR_DASHBOARD_TOKEN` (из `.env`), `BRIGADIR_JIRA_EMAIL`, `BRIGADIR_JIRA_API_TOKEN`. Экспортировать в шелл перед запуском `claude`: `set -a; source .env; set +a` (+ добавить два Jira-ключа в `.env`, шаблон — в `.env.example`).
4. Бэкенд должен быть поднят на `BRIGADIR_API_URL` (сервер — тонкий HTTP-клиент админ-API, в БД не ходит), иначе тулзы отдадут connection error.
5. Перезапустить Claude Code → `/mcp` покажет `brigadir-admin`. **MCP читается при старте сессии — в уже запущенную сессию сервер не подхватится, нужен рестарт.**

## UI-конвенции

- **Иконки — lucide (`lucide-vue-next`). Hover-анимация — ТОЛЬКО у пунктов меню в sidebar (`AppSidebar.vue`); все остальные иконки статичные** (реш. 2026-07-15, сужение реш. 2026-07-14 — «анимировать все иконки» отменено). Для sidebar два яруса: (1) **универсальные эффекты целой иконки** — оборачивай в `<AnimatedIcon effect="spin|dip|pop|wiggle">` (`apps/web/src/components/AnimatedIcon.vue`); чтобы эффект срабатывал от наведения на родительскую кнопку/ссылку, повесь на неё класс `anim-trigger`. (2) **Пер-частные эффекты** (анимация отдельных path'ов глифа — плитки, стрелки) — ручной CSS рядом с местом использования; референсы — грид и logout в `AppSidebar.vue`. Для трансформов SVG-подэлементов обязательны `transform-box: fill-box` + `transform-origin: center`; `prefers-reduced-motion` уважать. Сверяй анатомию глифа с живым DOM — lucide меняет polyline/line на path между версиями. State-индикаторы (пульс running-статуса в `RunStatusTag.vue`) — не hover-анимация, правило их не касается.

- **Брендовая палитра — только через `--el-color-*`** (реш. 2026-07-16). Единственный дом переопределений — `apps/web/src/styles/_theme.scss`: там задаются базовые цвета состояний (primary = янтарный #f59e0b, warning сдвинут в красно-оранжевый, чтобы не путался с primary) и генерируются оттенки `light-3/5/7/8/9`, `dark-2`, `-rgb` по формулам theme-chalk для светлой и тёмной темы. В компонентах брендовые цвета не хардкодить — только `var(--el-color-*)`. Лого — единый файл `apps/web/public/logo.svg` (знак `>_` на янтарной плашке): он и favicon (`index.html`), и плашка в сайдбаре (`<img>` в `AppSidebar.vue`); inline-копий SVG не заводить. Вордмарк `>_ BRIGADIR` — моноширинный (`$font-family-mono`). Спиннер `v-loading` — стандартный круговой Element Plus (красится в primary через переменные автоматически); кастомное «лицо бригадира» убрано 2026-07-16 до появления нового лого (есть в git-истории).

- **Пагинация списков — единая, серверная** (реш. 2026-07-15). Каждый list-эндпоинт принимает `page`/`page_size` и отвечает конвертом `{ items, page, page_size, total }` — схема строится ТОЛЬКО фабрикой `makePaginatedResponseSchema(...)` из `packages/contracts/src/pagination.schema.ts`; константы (дефолт 10, максимум 100, опции селектора 10/20/50/100) — в `pagination.constants.ts` (dep-free модуль, web импортирует его через алиас `@brigadir/contracts/pagination`, НЕ из CJS-барреля). Пагинированный запрос обязан иметь детерминированный `ORDER BY`; бэкенд парсит query через `parsePagination` (`dashboard.helpers.ts`). В UI — только общий `<ListPagination>` (`apps/web/src/components/ListPagination.vue`) в паре с composable `usePagination` (`apps/web/src/composables/usePagination.ts`); самодельные `el-pagination` запрещены. Видимость: `total ≤ 10` → компонент скрыт целиком (ни пейджера, ни селектора); `total > 10` → показывается всегда, даже если выбранный `page_size` больше `total` (одна страница в пейджере, селектор доступен). Смена любого фильтра или `page_size` сбрасывает на страницу 1; если `total` уменьшился и текущая страница вышла за последнюю — `usePagination.bindTotal` кламирует её. На пагинированных TanStack-запросах обязателен `placeholderData: (prev) => prev`. Потребители всего списка (пикеры, лукапы по id) не листают: точечный detail-эндпоинт (`GET /api/workspaces/:id` + `useWorkspace`) либо `page_size=100`.

- **Таймлайн прогона — читаемый, без JSON-дампов** (реш. 2026-07-21, feature 026). Разделение: `RunTimeline/presenter.ts` — чистый view-model (`bodyFormat: markdown|mono|kv`, `tags`, `orchestrator`/`iconKey`, флаги `legacyTruncated`/`fieldTruncated`), `RunTimeline/TimelineEvent.vue` — рендер; новые типы событий добавлять через презентер, не в шаблоне. Человеческие тексты (`message`/`details`/`summary`) рендерятся Markdown'ом через `MarkdownText.vue`; команды/сырьё — моноблок; payload без главного текстового поля — компактный key/value список, `JSON.stringify` в body запрещён. Обращения агента к оркестратору (`mcp__brigadir__*`) — не «обычные тулзы»: заголовок вида `report_progress → Brigadir` и свои иконки (Megaphone / MessageCircleQuestion у `request_human` / FlagTriangleRight у `complete_task`), дедуп `report_progress`-колла с его `progress`-событием сохраняется. Длинное тело — пер-элементный «Show more/less», полный текст всегда в DOM (уточнение решения 2026-07-15 «ничего не прятать», не отмена). Данные: `tool_call.input` персистится ТОЛЬКО структурным объектом через `libs/executors/src/claude-cli/tool-input-sanitizer.ts` (человеческий текст — целиком, файловые тела `content`/`new_string`/`old_string` → плейсхолдер `<file content, N KB>`, прочие строки — кап 2000 + флаг `truncated`; всё через скраббер, рекурсивно). Человеческие тексты на пути записи не резать; кап `report_progress.message` = 4000 (контракт, reject); новые «шумные» поля тулз — добавлять в политику санитайзера, а не обрезать JSON целиком.

## Выстраданные правила (нарушались — чинили)

1. **Никакой инициализации ресурсов в аргументах `@Module()`-декоратора.** Всё внутри `imports: [X.register()]` выполняется при ИМПОРТЕ файла — до тестовых `beforeAll` и поздних env. Соединения/креды/URL — только через DI-фабрики (`forRootAsync`/`useFactory`). Никаких молчаливых фолбэков на `localhost` — лучше упасть с ошибкой «env не задан». Composition-time чтение допустимо только для статической структуры (имена очередей) и документируется на месте. (Итерация 1: eager Redis-коннект увёл все тесты в хостовый redis — флак 50%, см. progress.md.)
2. **Прогоны неидемпотентны**: `maxStalledCount: 0`, дедуп на трёх уровнях (webhook id → BullMQ deduplication → partial unique index `runs_one_active`) — ни один уровень не убирать.
3. **В Jira пишет только система**, агенты только репортят через callback-тулзы. Все Jira-записи — через per-issue write queue.
4. **Тесты — в той же итерации, что и функциональность**; pipeline-логика без тестов не считается сделанной. Интеграционные тесты — против реальных Postgres/Redis (testcontainers), без моков брокера.
5. Схему БД из `docs/architecture.md` §3 не менять без обновления документа; миграции — коммитятся (`drizzle/`), ревью SQL против §3 обязательно.
6. **Изоляция тест-сьютов на общем ресурсе — неймспейсами, не flush'ем.** Redis имеет только 15 логических БД, сьютов больше — коллизии двух конкурентных сьютов в одной БД неизбежны; `flushdb` при этом сносит живые ключи соседа (его jobs исчезают, run висит в `queued`). Правильно: уникальный BullMQ `prefix` на сьют (`BULLMQ_PREFIX`, читается лениво в forRootAsync). (Итерация 4: флейк «stuck at queued» под полной нагрузкой.)
7. **Финализация из исхода процесса не должна затирать состояние из callback'ов.** Для callback-прогонов ВСЕ записи статуса, порождённые исходом процесса (fail-closed, cancelled, timed_out, retry), гвардятся `WHERE status='running'`; `markRunning` возвращает false для запаркованного прогона — job дропается, не исполняется. (Итерация 4: cancel-поллер затирал `awaiting_human` в `cancelled` — гонка, всплывшая на чекпоинте.)
