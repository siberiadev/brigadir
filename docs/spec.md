# BRIGADIR — Техническое задание

> **Актуальный режим работы — внутренний инструмент**: см. [plan-internal.md](plan-internal.md) (решения 2026-07-10: Jira через API token, UI workspace/агентов перенесён в Phase 1, «в Jira пишет только система»). При противоречии приоритет у plan-internal.md; Phase 2+ ниже — справочно.

Phase 0–1 — детально (эндпоинты, таблицы, поведение модулей); Phase 2+ — крупными мазками. Схема данных — в [architecture.md](architecture.md) §3 (здесь — только уточнения). Термины: **run** — один прогон агента по тикету; **executor** — способ исполнения; **workspace** — подключение к одному Jira-проекту.

---

# Phase 0 — Оркестратор вместо Jira Automation

## 0.1 Стек и структура

- Node.js 22 LTS, NestJS 11, TypeScript strict, pnpm; Postgres 16 (Drizzle или TypeORM — на выбор при старте, дальше не менять), Redis 7, BullMQ 5, `@nestjs/bullmq`.
- Монорепо: `apps/backend`, `apps/worker` (тот же NestJS-проект, отдельный entrypoint: API можно рестартить, не убивая 40-минутные прогоны), `packages/contracts` (zod-схемы: ReportSchema, CallbackTools, конфиги), позже `apps/web`, `packages/mcp-server`.
- Конфигурация Phase 0: `.env` (Jira creds, ключи), `agents.yaml` (валидируется zod-схемой при старте; ошибка конфига = отказ старта с внятным сообщением). YAML — только на Phase 0: с Phase 1 workspace и агенты создаются в UI (решение 2026-07-10), yaml остаётся как seed/экспорт.

```yaml
# agents.yaml (Phase 0)
workspace:
  jira_site: https://acme.atlassian.net
  project_key: BRIG
  board_id: 42            # Jira board; тип (kanban/scrum) система определит сама
  scope_jql: 'labels = ai-pipeline'   # опционально: глобальный фильтр скоупа (AND к поллеру)
  branch_prefix: feat     # ИНЕРТНО с feature 024: хранится/валидируется, но обёртке не передаётся (агент именует ветку сам)
  repositories:           # первый — дефолтный
    - name: product
      url: git@github.com:acme/product.git
      default_branch: main
    - name: frontend
      url: git@github.com:acme/frontend.git
      default_branch: main
executors:
  claude-sub:
    type: claude_cli
    concurrency: 2
    model: sonnet
  routines-qa:
    type: claude_routines
    routine_id: trig_xxx        # fire token — в .env, не в yaml
    concurrency: 1
agents:
  - name: implementer
    executor: claude-sub
    trigger_status: "Ready for Dev"
    status_running: "In Progress"
    status_success: "Code Review"
    status_failure: "Blocked"
    timeout_minutes: 45
    max_budget_usd: 3
    max_attempts: 2
    behavior:
      branch_prefix: feat   # инертно с feature 024 (агент именует ветку сам)
      allowed_tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash(git *)", "Bash(pnpm *)"]
      required_checks: [tests_pass, lint_pass]
    instruction: |
      Implement the ticket. Run tests.
  # ... остальные 5 агентов
```

## 0.2 JiraModule

Клиент поверх `fetch` (v3 REST, basic auth `email:api_token`), без сторонних SDK.

Обязательное поведение:

1. **Rate-limiter**: token bucket (настройка `JIRA_MAX_RPS`, дефолт 5) + глобальный concurrency cap (дефолт 8); на 429 — пауза по `Retry-After` (fallback: expo backoff + jitter, cap 5 мин); лог `RateLimit-Reason`.
2. **Per-issue write queue**: все мутации (transition, comment, property) сериализуются per issue key через in-process `p-queue` map по ключу — этого достаточно в Phase 0 (один процесс пишет в Jira). BullMQ OSS per-key сериализацию из коробки не даёт (groups — только в Pro), поэтому очередь в Redis для этого не используем.
3. **Transition discovery**: `transitionTo(issueKey, targetStatusName)`: GET `/issue/{key}/transitions` → матч по `to.name` (case-insensitive) → POST id. Кэш (project, issuetype, fromStatus) TTL 10 мин. 409 → инвалидация + 1 ретрай. Нет пути → ошибка `NoTransitionPath` (run failed с этой диагностикой — конфиг доски кривой).
4. **ADF-composer**: `buildRunComment(report): ADFDoc` — panel (info/error по outcome) + summary + `taskList` из checks (✅ pass / ❌ fail / ⚠ warn / ⏭ skip + reason) + ссылка на run в дашборде (Phase 1).
5. **Поиск**: `searchUpdated(jql, fields)` — POST `/rest/api/3/search/jql`, цикл по `nextPageToken`, обязательный явный `fields`.
6. Заготовка на будущее: все вызовы через интерфейс `JiraClient` (реализация `BasicAuthJiraClient`; в Phase 3 добавится `OAuthJiraClient`).

## 0.3 IngestModule

1. **Поллер** (`upsertJobScheduler('reconcile', {every: 300_000})`):
   - **Скоуп зависит от типа борды** (решение 2026-07-11, plan-internal п.5). Тип определяется при подключении workspace через `GET /rest/agile/1.0/board/{board_id}` и кэшируется в `workspaces`:
     - kanban: `project = {key} [AND ({scope_jql})] AND updated >= "{HWM - 60s}"`;
     - scrum: `project = {key} AND sprint IN openSprints() [AND ({scope_jql})] AND updated >= "{HWM - 60s}"`; нет активного спринта → пасс вхолостую.
   - `workspace.scope_jql` — опциональный глобальный фильтр скоупа (например, `labels = ai-pipeline` для пилота на части доски); действует на всех агентов workspace. Не путать с `agents.trigger_jql` — точечным фильтром одного агента поверх скоупа.
   - fields: `status,summary,updated`.
   - **Вход в скоуп = событие**: тикет, впервые появившийся в скоупе уже в триггер-статусе (добавлен в активный спринт, старт спринта), обрабатывается как `status_changed` (diff против отсутствующего `last_seen_status`).
   - **Смена активного спринта**: старт спринта не обновляет `updated` у задач → поллер хранит `active_sprint_id` в `workspaces.settings`; при изменении — полный рескан задач спринта без условия по `updated` (одноразово), затем обычный HWM-режим.
   - Для каждого issue: upsert `tickets`, diff `last_seen_status` vs фактический → событие `status_changed` в PipelineModule → обновить high-water mark (max `updated`, персистится в `workspaces.settings`).
   - Также: watchdog прогонов (running дольше timeout+grace → kill/fail), sweep застрявших `queued`.
2. **Webhook endpoint** `POST /webhooks/jira` (опционален в Phase 0, включается если админ создал system webhook):
   - HMAC-верификация секрета; ответ 200 немедленно, обработка асинхронно.
   - Дедуп: insert в `webhook_events` с `ON CONFLICT DO NOTHING` по `(workspace_id, external_id)`; повтор → skip.
   - Из `jira:issue_updated` извлекается changelog со сменой status → то же событие `status_changed`.
   - Webhook и поллер сходятся в одной точке: `PipelineModule.onStatusChanged(ticket, fromStatus, toStatus, source)` — идемпотентной по построению.

## 0.4 PipelineModule

```
onStatusChanged(ticket, from, to, source):
  agents = enabled agents WHERE trigger_status == to
           AND (trigger_jql IS NULL OR ticket matches trigger_jql)   # Phase 0: только trigger_status
  for agent in agents:
    if EXISTS active run (ticket): skip (log)   # с миграции 0011 — один активный прогон на тикет
    INSERT runs (status=queued) — ловим unique violation как «уже есть»
    queue[agent.executor.type].add('run', {runId}, {
      deduplication: {id: `${ticket.id}:${agent.id}`},
      attempts: agent.max_attempts,
      backoff: {type: 'custom'},
    })

dependencyGate(ticket):  # решение 2026-07-11: модель «временной команды» (backend+frontend фича)
  links = issue.fields.issuelinks WHERE type = "is blocked by"
  # feature 032: порог релиза настраивается на воркспейс —
  # workspaces.settings.dependency_release_status (имя Jira-статуса).
  # Связь удовлетворена, если статус блокера СОВПАДАЕТ с настройкой
  # (trim + case-insensitive) ИЛИ его категория = done. Ветка "ИЛИ done"
  # безусловна: блокер, перепрыгнувший настроенный статус, всё равно
  # отпускает зависимых.
  return all(
    linked.status.category in done-category
    or (release_status and linked.status.name ~= release_status)
    for linked in links
  )
  # Настройка НЕ валидируется против воркфлоу доски: неизвестное имя просто
  # никогда не совпадёт, и остаётся ровно правило done-категории (деградируем,
  # а не отказываем — блокер может жить в другом проекте). Дашборд показывает
  # предупреждение, релиз-пасс — один warn за проход.
  # Настройка не задана -> поведение байт-в-байт как до feature 032.
  # false -> прогон не стартует; тикет помечается waiting_dependencies.
  # Закрытие блокера НЕ обновляет updated заблокированного тикета -> reconcile-проход
  # перепроверяет все тикеты в триггер-статусах, пропущенные из-за зависимостей.
  # Прогон, отпущенный ТОЛЬКО по совпадению имени статуса, получает событие
  # run_events `source: 'dependency-release', early: true` (feature 032).

onRunFinished(run, report | processFailure):
  if report.outcome == success:
    jira.transitionTo(ticket, agent.status_success); jira.comment(buildRunComment)
  else:
    jira.transitionTo(ticket, agent.status_failure); jira.comment(...)
    # Phase 0: human task = просто коммент + Blocked. Очередь — Phase 1.
```

Правила: если `status_running` задан — transition при старте джоба (не при enqueue); переходы делаются **после** записи результата в Postgres (падение между ними чинит reconciliation: run завершён, а тикет не переведён → повторить transition).

Ретрай BullMQ и строки `runs`: ретрай переиспользует **тот же run**. При ошибке процессора: если attempts остались — `runs.status = 'queued'`, `attempt = attemptsMade + 1`; исчерпаны — `failed`. Новая строка run создаётся только новым триггером или resume из human-task.

## 0.5 Worker и executors

Общие настройки воркеров: `maxStalledCount: 0` (прогоны неидемпотентны — лучше явный failed, чем молчаливый дабл-прогон), Redis-коннект `maxRetriesPerRequest: null`, `removeOnComplete: {count: 1000}`, `removeOnFail: {count: 5000}`.

`RunProcessor extends WorkerHost` (по одному классу на очередь, без sandboxed-процессоров):

1. Загрузить run+agent+workspace; отметить `running`, `started_at`.
2. `RunRuntime.prepare`: `git worktree add --detach` из кэш-клона репо (кэш на диске, `git fetch --prune` перед worktree) в `WORKTREES_DIR/{runId}`; старт-реф — ветка, заявленная предыдущей стадией по тикету, иначе `origin/{default_branch}` (feature 023, architecture §7).
3. Собрать `RunContext` (инструкция в упрощённой Phase 0-обёртке — см. architecture §7, примечание о фазировке: без MCP-раздела, отчёт через `--json-schema`; + текст тикета из Jira: summary, description как markdown), env-санация (см. 0.6). Ветку заводит и пушит АГЕНТ; `{behavior.branch_prefix}/{ticket_key}` — имя, которое обёртка ему предлагает, а не то, что создаёт система.
4. `executor.run(ctx, abortSignal)`; параллельно — подписка на флаг `run:{id}:cancelled`.
5. Финализация: статус, cost/usage, отчёт (Phase 0 — из `structured_output`), events; `onRunFinished`; cleanup worktree (конфиг `KEEP_FAILED_WORKTREES=true`).
6. Классификация ошибок: rate-limit → `worker.rateLimit(ttl)` + `RateLimitError` (ttl: из `retry_delay_ms`; для подписочного окна — эвристика 15 мин, повторно — 60 мин); crash/timeout → обычный fail (backoff-ретрай); auth/конфиг → `UnrecoverableError`.

**ClaudeCliExecutor**:

```
claude -p "<prompt>" \
  --output-format stream-json --verbose \
  --json-schema "$(cat report-schema.json)" \
  --strict-mcp-config \
  --settings "{worktree}/.brigadir/settings.json" \  # явные settings, чтобы хостовые конфиги не протекали
  --permission-mode dontAsk \
  --allowedTools "Read Edit Write Glob Grep Bash(git *) Bash(npm *) Bash(pnpm *)" \  # из behavior.allowed_tools
  --max-turns 80 --max-budget-usd {agent.max_budget_usd} \
  --model {executor.model}
```

Открытый вопрос имплементации: доставка `structured_output` при `--json-schema` задокументирована для `--output-format json`; для `stream-json` (финальное `result`-событие) — проверить на первом прототипе. Если в stream-json отчёт не приходит — fallback: `--output-format json` (теряем прогресс-события до Phase 1) — с Phase 1 первичным каналом всё равно становится MCP `complete_task`.

- spawn c `detached: true`, cwd=worktree; OS-таймаут `timeout_minutes`; на cancel/shutdown — SIGTERM группе, 15 c grace, SIGKILL.
- stream-json построчно: `system/init` → event; `assistant`/`tool_use` → events (сэмплировано); `system/api_retry` → event + rate-limit классификация; финальный `result` → cost/usage/structured_output.
- stderr — в `run_events(type=log)` хвостом ≤ 64KB.

**ClaudeRoutinesExecutor**: `POST https://api.anthropic.com/v1/claude_code/routines/{id}/fire` с обязательным заголовком `anthropic-beta: experimental-cc-routine-2026-04-01` (без него — 400) и телом `{"text": "ticket={key}\nsummary={...}\nreport_to={CALLBACK_URL}/api/callbacks/runs/{runId}/complete\ntoken={runJWT}"}` (`text` ≤ 65 536 символов); сохранить `session_url` в `external_ref`. Завершение — **только** callback `complete` или watchdog-таймаут → `failed`; side-effect-детекцию по Jira не используем (обёртка запрещает агенту самому трогать тикет). Для этого уже в Phase 0 поднимается **минимальный callback-эндпоинт** `POST /api/callbacks/runs/:runId/complete` — подмножество Phase 1 CallbackModule: проверка run-JWT + валидация ReportSchema (полный модуль с `progress`/`human` — Phase 1). 429 от `/fire` → `RateLimitError`. healthCheck: read-API у Routines нет — проверяем только наличие токена и давность последнего успешного fire. Cancel облачной сессии невозможен: run помечается `cancelled`, поздний `complete` отсекается по статусу (409); сессия может дожить сама.

## 0.6 Env-санация (обязательный тест)

Процесс агента получает **только** allowlist: `PATH, HOME, GIT_*, LANG, BRIGADIR_*` + явные из agent config. Автотест: в env воркера подложен `ANTHROPIC_API_KEY=canary` → в env спавненного процесса его нет (иначе CLI молча уйдёт с подписки на API-биллинг — задокументированный приоритет).

## 0.7 Definition of Done Phase 0

См. [roadmap.md](roadmap.md) — плюс технические: интеграционный тест пайплайна на mock-Jira (nock/msw); `docker-compose.yml` (postgres, redis, backend, worker); README с запуском за ≤ 15 минут.

---

# Phase 1 — Дашборд, чеклисты, human-queue, MCP-callback

## 1.1 Контракты (`packages/contracts`)

- `ReportSchema` v1 — как в [architecture.md](architecture.md) §6, единый источник: из zod генерируется JSON Schema для `--json-schema` и для MCP `inputSchema`.
- `CallbackTools` (progress/human/complete) — §5 архитектуры.
- Условная валидация: `outcome=needs_human` ⇒ `human_task` required; `checks` непусты при `outcome != needs_human`.

## 1.2 CallbackModule (HTTP API)

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| POST | `/api/callbacks/runs/:runId/progress` | `{stage, message, percent?}` | `204` |
| POST | `/api/callbacks/runs/:runId/human` | `{kind, title, details, blocking}` | `201 {human_task_id}`; при `blocking=true` run сразу переводится в `awaiting_human`, в ответе `{instruction: "You may finish now without calling complete_task; the system will resume you with the answer."}` |
| POST | `/api/callbacks/runs/:runId/complete` | ReportSchema | `200 {ack: true}`; невалидно → `422 {errors}` (агент чинит и повторяет); run уже завершён → `409` |

- Auth: `Bearer <run JWT>` (HS256, секрет backend'а; claims `{sub: runId, wsp, tkt, exp}` — единый набор в `packages/contracts`, тот же, что в architecture §5); guard сверяет `sub == :runId` и статус run ∈ {running, awaiting_human}.
- `422` на `complete` возвращает список zod-ошибок в тексте — это и есть repair-loop для агента.
- Идемпотентность `complete`: первый валидный побеждает, остальные 409.
- Все callback'и пишутся в `run_events`; `progress` дублируется в `job.updateProgress` и SSE.

## 1.3 MCP stdio server (`packages/mcp-server`, бинарь `brigadir-mcp`)

- `@modelcontextprotocol/sdk`, `McpServer` + три `registerTool` из `CallbackTools`; каждый handler = HTTP POST на CallbackModule c `BRIGADIR_RUN_TOKEN`.
- env: `BRIGADIR_API_URL`, `BRIGADIR_RUN_ID`, `BRIGADIR_RUN_TOKEN`. stdout — только протокол; логи — stderr.
- Ошибки HTTP → MCP `isError: true` с текстом (агент видит и может повторить); 5 ретраев с backoff на сетевые ошибки — callback'и не должны теряться из-за blip'а.
- Подключение в ClaudeCliExecutor: `--mcp-config {worktree}/.brigadir/mcp.json`, где в конфиге `env: {"BRIGADIR_RUN_TOKEN": "${BRIGADIR_RUN_TOKEN}", ...}` — значения подставляются из env процесса `claude` (его выставляет воркер). Токен не попадает ни в argv, ни в файл. Плюс `--allowedTools "... mcp__brigadir__*"`.
- **Stop-hook** (генерируется в settings прогона): скрипт проверяет маркер-файл `{worktree}/.brigadir/completed` (его пишет MCP-сервер после успешного `complete` **или** после blocking `request_human` — оба легитимно завершают сессию) → нет маркера → `{"decision":"block","reason":"Call mcp__brigadir__complete_task with your final report first."}` (максимум 2 блока, затем пропустить — защита от вечного цикла).
- С этого момента `complete_task` — primary, `--json-schema` — fallback (процесс умер без complete → пробуем structured_output → иначе failed).

## 1.4 HumanTaskModule

- Создание: из `request_human` и из `complete_task{outcome: needs_human}`; во втором случае — только если у run ещё **нет** open-задачи (дедуп per run: один вопрос — одна задача, один transition, один коммент).
- `blocking=true`: run → `awaiting_human` (job завершается успешно — слот освобождается), тикет → `status_failure` ("Blocked") + ADF-коммент с вопросом. Агент после этого завершает процесс без `complete_task` — это легитимный выход (см. Stop-hook в 1.3 и architecture §2 п.4).
- Resolve (`POST /api/human-tasks/:id/resolve {resolution, action}`):
  - `action=resume`: в одной транзакции старый run → `superseded`, создаётся новый run (attempt+1) того же агента — порядок «закрыть старый → создать новый» не нарушает partial unique index `runs_one_active`; `resolution` добавляется в промпт блоком `## Human answer to your question` (улучшение позже: `claude --resume <session_id>` из `external_ref` — продолжение той же сессии с полной памятью вместо холодного старта); тикет переводится в `status_running` (**не** в trigger-статус — иначе `onStatusChanged` попытается заэнкьюить параллельный run); порядок: создать run → потом transition.
  - `action=done_manually`: run закрывается, тикет переводится вручную человеком в Jira (мы не трогаем).
  - `action=dismiss`: задача закрыта без действий.

## 1.5 REST API для дашборда

Пагинация (единая, решение 2026-07-15): каждый list-эндпоинт (`GET /api/workspaces`, `GET /api/agents`, `GET /api/executors`, `GET /api/human-tasks`, `GET /api/workspaces/:id/runs`) принимает `page`/`page_size` (дефолт 10, максимум 100) и отвечает конвертом `{ items, page, page_size, total }` с детерминированным `ORDER BY` (схемы — фабрика `makePaginatedResponseSchema` в `packages/contracts/src/pagination.schema.ts`).

```
# workspaces (создание/подключение Jira — решение 2026-07-10)
GET  /api/workspaces                      # пагинированный конверт {items, page, page_size, total}
GET  /api/workspaces/:id                  # detail (2026-07-15) — для шапки/настроек, не листать список
POST /api/workspaces                      # {name, jira_site_url, jira_email, jira_api_token, board}
                                          # board — id или URL борды (id извлекается из URL)
                                          # перед сохранением: GET /myself (валидация токена) +
                                          # GET /rest/agile/1.0/board/{id} (доступ, тип kanban/scrum,
                                          # project_key из location) — тип и ключ сохраняются в workspace;
                                          # ошибка -> 422 с причиной
PUT  /api/workspaces/:id/jira-connection  # переподключение/ротация токена (та же валидация)
GET  /api/workspaces/:id/statuses         # статусы проекта из Jira — для селектов в форме агента

# executors (ПЛАТФОРМЕННЫЕ, решение 2026-07-13: executor — физическая мощность,
# не настройка workspace; админка — страница Settings /settings/executors)
GET    /api/executors
POST   /api/executors                     # typed-config по типу; имя глобально уникально (409)
PUT    /api/executors/:id
DELETE /api/executors/:id                 # 409 executor_in_use, если на него ссылаются агенты
                                          # ЛЮБОГО workspace

# agents (CRUD в UI с Phase 1)
GET    /api/agents?workspace=
POST   /api/agents                        # {name, instruction, executor_id, trigger_status,
                                          #  status_running?, status_success, status_failure,
                                          #  timeout_minutes, max_budget_usd, behavior}
PUT    /api/agents/:id
DELETE /api/agents/:id                    # soft: enabled=false, если есть завершённые прогоны
POST   /api/agents/:id/test-run           # ручной прогон по указанному тикету (отладка промпта)

GET  /api/tickets?status=&q=&page=        # + counters по статусам
GET  /api/tickets/:key                    # ticket + runs[] (+ checks, human_tasks)
GET  /api/runs?status=&agent=&page=
GET  /api/runs/:id                        # + report, checks, cost
GET  /api/runs/:id/events?after_id=       # таймлайн, инкрементально
POST /api/runs/:id/cancel
POST /api/runs/:id/retry                  # новый attempt (для failed / timed_out / cancelled)
GET  /api/human-tasks?status=open
POST /api/human-tasks/:id/resolve
GET  /api/agents                          # read-only в Phase 1 (из yaml)
GET  /api/stats                           # прогоны/сутки, стоимость, success rate, cache hit rate
GET  /api/events/stream                   # SSE: run status changes, progress, new human tasks
```

Семантика `cancel` зависит от executor'а: для локальных — SIGTERM группе процессов; для `claude_routines` — только локальная пометка (облачную сессию не остановить, она может ещё коммитить/пушить; поздний `complete` отсечётся 409).

Auth Phase 1: один статический bearer-токен (`DASHBOARD_TOKEN`) — self-hosted, один пользователь. Полноценные users — Phase 3.

## 1.6 Vue-дашборд (`apps/web`)

Vue 3 + Vite + Pinia + TanStack Query + **Element Plus** (решение 2026-07-10: полный набор admin-компонентов под наши экраны — `el-steps` для визарда workspace, `el-timeline` для таймлайна прогона, `el-table`, `el-form` с валидацией, `el-tag`/`el-badge` для статусов); SSE-подписка поверх query-инвалидации. **Своей kanban-доски нет** (решение 2026-07-11): Jira — единственная доска; наш операционный экран — вкладка Runs внутри workspace.

Экраны:

0. **Workspace** — визард создания (шаг 1: имя; шаг 2: подключение Jira — URL сайта + email + API-токен с подсказкой «создать на id.atlassian.com», кнопка «Проверить» → `/myself` + борда через Agile API, показываем имя бота, проект и тип борды; шаг 3: **репозитории** — список {name, git URL, default_branch}, первый — дефолтный; шаг 4: готово). Настройки workspace: переподключение/ротация токена, бейдж `expires_at` с предупреждением за 30/7 дней; `scope_jql` (глобальный фильтр скоупа, advanced); `branch_prefix` (дефолт `feat` — наследуется агентами; с feature 023 это ПОДСКАЗКА имени ветки агенту, ветки создаёт он сам); управление списком репозиториев. **Agents** — список агентов workspace, «+» открывает форму. Поля: `name`, `instruction` (textarea, без обёртки), `executor` + `model` (Phase 1: только `claude_cli`), `trigger_status`, `status_running` (опционален, **рекомендован по умолчанию** — «взят агентом» на доске), `status_success`, `status_failure`, `timeout_minutes`, `max_budget_usd`, `max_attempts`, `trigger_jql` (advanced, фильтр этого агента поверх workspace.scope_jql), `repository` (селект из списка репозиториев workspace; пусто = дефолтный), behavior: `branch_prefix` (пусто = наследуется от workspace), `allowed_tools`, `required_checks`; кнопка «тестовый прогон» по ключу тикета. Все статус-поля — селекты из `/api/workspaces/:id/statuses`: **плоский список статусов борды, без колонок** (решение 2026-07-11 — колонками пользователь думает в Jira), биндинг по status id + name. Валидация при сохранении (мини-линтер): статусы существуют на борде; **дубль `trigger_status` среди включённых агентов запрещён**, если не различается `trigger_jql`; предупреждение о цикле статусов (status_success агента А триггерит Б, чей status_success возвращает в триггер А).
1. **Runs** (вкладка внутри Workspace, решение 2026-07-11 — заменяет экран Board) — таблица прогонов: агент, тикет (ключ + summary, ссылка в Jira), статус прогона (спиннер/✅/❌/✋), attempt, длительность, стоимость; фильтры по агенту и статусу прогона, поиск по ключу тикета; live-обновление через SSE. Клик по строке → Ticket.
2. **Ticket** — шапка (ключ, summary, ссылка в Jira, текущий статус); лента прогонов: агент, executor, attempt, длительность, стоимость, outcome; **чеклист** (✅/❌/⚠/⏭ + reason раскрытием); таймлайн событий (progress-стадии, api_retry, jira-actions); кнопки cancel/retry.
3. **Human queue** (главный экран по умолчанию при наличии open-задач) — список: title, тикет, агент, возраст, kind; форма ответа + выбор action. Счётчик в навбаре.
4. **Stats** — 4–6 виджетов (успешность, стоимость/день, p50/p95 длительность, cache hit rate).

## 1.7 DoD Phase 1

См. [roadmap.md](roadmap.md); плюс: e2e-тест «агент задаёт вопрос → задача в очереди → ответ → resume → success» на mock-executor'е; нагрузочный smoke: 20 параллельных прогонов (mock) не ломают SSE/очереди.

---

# Phase 2+ — крупными мазками

**Phase 2 — продуктовая модель.** ~~CRUD workspaces/executors/agents (UI + REST)~~ — перенесено в Phase 1 (решение 2026-07-10, см. plan-internal.md); остаётся: шифрование секретов (AES-256-GCM, ключ из env/KMS), health-checks. `AnthropicApiExecutor` (Agent SDK: `query()`, `permissionMode:'dontAsk'`, in-process `createSdkMcpServer` — те же CallbackTools без HTTP, `outputFormat` fallback). `DeepSeekExecutor` (план A — Agent SDK через `api.deepseek.com/anthropic`; два обязательных спайка перед выбором A/B: (1) SDK шлёт `cache_control`, который endpoint не поддерживает — деградирует молча на автокэш DeepSeek или падает; (2) принимает ли endpoint родные имена моделей `deepseek-v4-pro` или только маппинг Claude-имён; план B — свой OpenAI-loop; политика: verification=run_tests принудительно, no-vision, forced tool call отчёта, repair-loop с лимитом). Компилятор behavior→wrapper со снапшот-тестами промптов. Streamable HTTP MCP endpoint. Линтер пайплайна. Фича-флаг «self-hosted mode» гейтит `claude_cli` (ToS); у `claude_routines` в UI — предупреждение: привязка к личному аккаунту claude.ai, все действия от имени владельца routine, дневной cap на запуски.

**Phase 3 — multi-tenant.** Users/orgs/RBAC + SSO; Jira 3LO (vault, сериализованный refresh, динамические вебхуки + 30-дневный refresh-крон + `/webhook/failed` sweep); BYOK со spend-лимитами; `DockerRunRuntime` (--runtime=runsc, default-deny egress, credential-injecting proxy для git/Jira); self-hosted runner (outbound gRPC/WS, облако не хранит код и подписочные токены); per-tenant бюджеты Jira rate limits; audit-события.

**Phase 4 — прод.** Биллинг (seats + metered), OTel-наблюдаемость и алертинг (credential expiry, webhook health, cache hit rate, стоимость аномалий), audit log UI, ретенция/экспорт, SOC2-трек, Atlassian Marketplace, опционально: executor Managed Agents; регистрация BRIGADIR как назначаемого агента в Atlassian Agents in Jira.

---

# Сквозные NFR (все фазы)

1. **Надёжность**: ни одно событие Jira не теряется навсегда (reconciliation ≤ 5 мин); ни один run не «висит» вечно (watchdog для `queued`/`running`; `awaiting_human` — осознанное исключение: ждёт человека, контролируется метрикой возраста open human-tasks с алертом по SLA); рестарт backend/worker не убивает прогоны (отдельные процессы; graceful shutdown ждёт ≤ 30 c, дальше — job переигрывается или помечается по политике агента).
2. **Идемпотентность**: повтор любого входного события (webhook, poll, callback) не создаёт дублей — гарантируется тремя рубежами (webhook_events unique, BullMQ deduplication, partial unique index).
3. **Секреты**: не в argv, не в env агента, не в логах/отчётах/Jira (скраббер); шифрование at rest.
4. **Стоимость**: у каждого run — cost_usd и usage; бюджет-потолок per run; алерт при cache hit rate < 50%.
5. **Тестируемость**: mock-executor (детерминированные сценарии: success/fail/needs_human/timeout/rate-limit) — обязательная часть Phase 0; вся pipeline-логика тестируется без реальных LLM и Jira.
