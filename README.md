<div align="center">

```
██████╗ ██████╗ ██╗ ██████╗  █████╗ ██████╗ ██╗██████╗
██╔══██╗██╔══██╗██║██╔════╝ ██╔══██╗██╔══██╗██║██╔══██╗
██████╔╝██████╔╝██║██║  ███╗███████║██║  ██║██║██████╔╝
██╔══██╗██╔══██╗██║██║   ██║██╔══██║██║  ██║██║██╔══██╗
██████╔╝██║  ██║██║╚██████╔╝██║  ██║██████╔╝██║██║  ██║
╚═════╝ ╚═╝  ╚═╝╚═╝ ╚═════╝ ╚═╝  ╚═╝╚═════╝ ╚═╝╚═╝  ╚═╝
```

**Оркестратор бригады AI-кодинг-агентов поверх Jira.**

*Доска — единственный дашборд. Статус — единственный протокол. Бригадир раздаёт наряды.*

<br/>

![Node](https://img.shields.io/badge/Node-22_LTS-3C873A?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat-square)
![NestJS](https://img.shields.io/badge/NestJS-11-E0234E?style=flat-square)
![Vue](https://img.shields.io/badge/Vue-3-42B883?style=flat-square)
![Postgres](https://img.shields.io/badge/Postgres-16-336791?style=flat-square)
![Redis](https://img.shields.io/badge/Redis_+_BullMQ-5-DC382D?style=flat-square)
![License](https://img.shields.io/badge/mode-internal_tool-6E56CF?style=flat-square)

</div>

---

## Что это

BRIGADIR превращает **доску Jira в пульт управления командой AI-агентов**. Ты не пишешь пайплайн явно — ты навешиваешь на каждый статус доски своего агента. Тикет вошёл в статус → бригадир поднимает нужного агента (`claude -p` в изолированном git-worktree) → агент делает работу и репортит структурированный отчёт → бригадир двигает тикет дальше по доске. Следующий статус триггерит следующего агента.

**Пайплайн эмерджентен** — он рождается из статусов доски, а не из конфига. Любой человек может вмешаться в любой момент прямо в Jira, и это часть протокола, а не сбой.

```
        ┌──────────────────────────┐
        │          JIRA            │   источник правды по статусу тикета
        │   ● Ready for Dev        │
        └────────────┬─────────────┘
                     │  статус сменился (webhook + reconciliation-поллинг)
        ┌────────────▼─────────────┐
        │        BRIGADIR          │   бригадир: матчит агента, раздаёт наряды,
        │  match · dedup · enqueue │   двигает статусы, пишет комменты
        └────────────┬─────────────┘
         ┌───────────┼───────────┐
         ▼           ▼           ▼
     ┌───────┐   ┌───────┐   ┌───────┐
     │ agent │   │ agent │   │ agent │   бригада: claude -p в git-worktree,
     │  QA   │   │  Dev  │   │Planner│   MCP-тулзы для отчётов
     └───┬───┘   └───┬───┘   └───┬───┘
         └───────────┴───────────┘
                     │  report_progress · request_human · complete_task
                     ▼
              статус ← down the board  →  следующий агент цепочки
```

## Зачем

Проект вырос из боли жить на **Jira Automation** как на движке для агентов. Три вещи, которые он лечит:

| Боль | Было | Стало |
|---|---|---|
| **Ненадёжный движок** | Jira Automation молча теряет триггеры, дабл-запускает, не переживает даунтайм | Дедуп на трёх уровнях, high-water-mark поллер догоняет пропущенное, идемпотентные прогоны |
| **Простыни логов** | В комменте тикета — сырой лог агента на сто строк | Читаемый чеклист ✅/❌ в Jira + карточка прогона с таймлайном, стоимостью и usage |
| **«Агент застрял»** | Непонятно, где агент ждёт человека и ждёт ли | Единая **human-queue**: `request_human` → задача в очереди ≤ 5 сек → ответ из UI возобновляет прогон |

Модель шире одного пайплайна: **workspace + агенты + scope_jql = временная команда digital-сотрудников** под узкий список задач. Собрал бригаду под фичу спринта, включил, распустил — история остаётся.

## Принципы (не нарушаются)

1. **В Jira пишет только система.** Агент никогда сам не двигает карточку и не комментирует — он репортит через тулзы (`report_progress` / `request_human` / `complete_task`), а транзишены, комменты и человеко-задачи делает бригадир. Правило зашито в обёртку инструкций.
2. **Jira — источник правды по статусу.** Оркестратор никогда не «считает» тикет в статусе, которого не видел в Jira; локальный `last_seen_status` — кэш для diff'а, не правда.
3. **Прогоны идемпотентны.** Дедуп webhook-события → BullMQ `deduplication` → partial unique index на активный прогон `(ticket, agent)`. Ни один уровень не снимается.
4. **Завершение прогона = `complete_task`.** Любой другой выход процесса без него — `failed` с диагностикой. Stop-hook принуждает Claude-агента вызвать тулзу.
5. **Агенты друг друга не запускают.** Цепочка — только через статусы Jira. Пайплайн остаётся совместимым с ручным вмешательством.

## Как устроено

```
                        ┌─────────────────────────────────────────────┐
                        │                 Jira Cloud                  │
                        └───────┬─────────────────────▲───────────────┘
             webhooks /         │                     │  transitions · ADF-комменты
             JQL-поллинг        │                     │  (per-issue write queue, 20/2с)
                        ┌───────▼─────────────────────┴───────────────┐
   Vue Dashboard ◄─SSE──┤                NestJS Backend               │
   (runs, чеклисты,     │  Jira · Ingest · Pipeline · Run · Callback  │
    human-queue)──REST─►│  HumanTask · Executor                       │
                        └───────┬───────────────────▲─────────────────┘
                                │ enqueue           │ MCP / HTTP callback
                        ┌───────▼───────┐           │  (report / request_human /
                        │ Redis + BullMQ│           │   complete_task, run-JWT)
                        │ queue / type  │           │
                        └───────┬───────┘           │
                        ┌───────▼───────────────────┴─────────────────┐
                        │             Worker (NestJS WorkerHost)      │
                        │   git worktree · env-санация · secret scrub │
                        │        claude -p  +  brigadir MCP tools     │
                        └─────────────────────────────────────────────┘
```

**Control plane (backend)** и **execution plane (worker)** — два процесса, общее только Postgres + Redis. Рестарт бэкенда не роняет живые прогоны.

- **Postgres 16** — источник правды по истории: прогоны, чеклисты, события, human-tasks, usage/cost.
- **Redis + BullMQ 5** — только очереди: per-executor concurrency, дедуп, reconciliation-scheduler.
- **Jira** — источник правды по статусу тикета.

### Стек

`pnpm` monorepo · NestJS 11 (backend + worker) · Vue 3 + Vite + Pinia + TanStack Query + Element Plus (web) · Drizzle ORM + коммит-миграции · zod-контракты (framework-free) · Streamable-HTTP MCP-сервер для callback-тулз · vitest + Testcontainers (реальные Postgres/Redis, без моков брокера).

---

## Быстрый старт

**Требования:** Node.js 22 LTS (см. `.nvmrc`), pnpm ≥ 9, Docker с запущенным демоном (нужен и для `docker compose`, и для интеграционных тестов через Testcontainers).

### 1. Установка и статика

```bash
pnpm install
pnpm typecheck   # tsc --noEmit по всему воркспейсу, strict
pnpm lint
```

### 2. Тесты

```bash
pnpm test              # юниты: contracts + mcp-server + libs
pnpm test:integration  # Testcontainers: Postgres 16 + Redis 7, миграции с нуля
```

Интеграционные поднимают реальные контейнеры, применяют коммит-миграции, гоняют сценарии прогонов, дедуп, rate-limit-аккаунтинг, машину статусов и reconcile — детерминированно (повторный прогон даёт тот же результат).

### 3. Полный стек одной командой

```bash
cp .env.example .env      # опционально для локали
docker compose up --build
```

Из пустых томов: Postgres и Redis становятся healthy → **backend** применяет миграции и сидит workspace/executors/agents из `agents.yaml`, отдаёт `GET http://localhost:3000/health` → `{ "status": "ok", "db": "up", "redis": "up" }` → **worker** подключается и регистрирует консьюмеры + reconcile-scheduler.

> Локальный dev-режим, секреты и грабли — в [`docs/local-setup.md`](docs/local-setup.md).

---

## Структура репозитория

```
apps/
  backend    HTTP control plane: миграции → сид → /health → REST + SSE
  worker     BullMQ-консьюмеры: RunProcessor + reconcile-scheduler
  web        Vue 3 дашборд (workspaces · agents · runs · human-queue · settings)
  smoke      one-shot trigger-хелпер
libs/
  jira       клиент v3, rate-limiter, per-issue write queue, transition discovery, ADF
  ingest     webhook-эндпоинт + reconciliation-поллер (high-water mark)
  pipeline   машина состояний тикета, матчинг агентов, дедуп
  runs       lifecycle прогона, события, чеклисты, статус-маппинг
  callback   HTTP callback API + MCP-канал, run-JWT
  human-tasks очередь «нужен человек», resume прогона
  executors  контракт AgentExecutor, реестр, claude_cli / mock
  database   Drizzle-схема + мигратор
  queues     реестр очередей, backoff, connection
  app-config fail-fast загрузчик agents.yaml + yaml→DB сидер
  scrubber   скраббер секретов из потока агента
packages/
  contracts  zod-схемы (Report, AgentsConfig, TriggerEvent, callbacks, pagination)
  mcp-server stdio/streamable MCP: report_progress · request_human · complete_task
drizzle/     коммит-миграции (ревью против architecture.md §3)
```

## Документы — источник правды

| Файл | Что внутри |
|---|---|
| [`docs/plan-internal.md`](docs/plan-internal.md) | **Актуальный рабочий план** — итерации, принятые решения (при противоречиях приоритет здесь) |
| [`docs/spec.md`](docs/spec.md) | Детальное ТЗ: эндпоинты, таблицы, поведение модулей |
| [`docs/architecture.md`](docs/architecture.md) | Схема БД (§3), контракт AgentExecutor (§4), callback-протокол (§5), ReportSchema (§6) |
| [`docs/progress.md`](docs/progress.md) | Журнал итераций |
| [`docs/local-setup.md`](docs/local-setup.md) | Локальный запуск |
| [`.specify/memory/constitution.md`](.specify/memory/constitution.md) | Обязательные принципы, проверяются гейтами spec-kit |

---

<div align="center">
<sub>Внутренний инструмент команды · некоммерческий режим · Jira через API-token, исполнение — на своей инфре</sub>
</div>
