# BRIGADIR — Roadmap

> **Актуальный рабочий план — [plan-internal.md](plan-internal.md)** (режим внутреннего инструмента, решения 2026-07-10: Jira через API token, UI workspace/агентов в Phase 1, вырезаны multi-tenant/BYOK-executor'ы/песочницы). Этот roadmap — полная продуктовая версия, справочно.

Логика фаз сохранена из исходного плана и скорректирована по результатам исследования ([research.md](research.md)). Главные коррекции:

- **Routines имеют официальный `/fire` API** (research preview) → executor `claude_routines` реализуем уже в Phase 0, но строго как fire-and-forget с watchdog.
- **ToS-матрица** прошивается в продукт с Phase 2: подписочные executor'ы (`claude_cli`) — только self-hosted/на машине пользователя; SaaS — BYOK или self-hosted runner.
- **MCP-callback переносится из Phase 2 в Phase 1** (упрощённо): исследование показало, что `complete_task` как MCP-тулза + Stop-hook — самый надёжный канал structured output, и он же нужен для human-queue. Тянуть его позже — значит дважды переделывать контракт отчёта.
- Jira-интеграция Phase 0 обязана строиться на **новом `/search/jql`** (старые эндпоинты удалены) и учитывать 1-годовую экспирацию API-токенов.
- Конкурентный ландшафт (Rovo Dev, Copilot for Jira GA) требует ускорить выход к дифференциаторам: human-queue и чеклисты (Phase 1) важнее полировки Phase 0.

---

## Phase 0 — Прототип для себя: замена Jira Automation

**Цель:** мой личный пайплайн (6 агентов) работает на своём оркестраторе, Jira Automation отключена. Один workspace, конфигурация агентов — YAML-файл, без UI.

Состав:

1. NestJS-скелет: `JiraModule` (API token, rate-limiter, per-issue write queue, transition discovery + 409-retry, минимальный ADF-composer), `IngestModule` (reconciliation-поллер `/search/jql` + high-water mark; опционально один admin system webhook), Postgres-миграции (workspaces, executors, agents, tickets, runs, run_events, webhook_events — по [architecture.md](architecture.md) §3).
2. BullMQ: очереди per executor, `setGlobalConcurrency`, дедуп `{id: ticket:agent}`, `RateLimitError` для лимитов подписки, reconciliation через `upsertJobScheduler`, graceful shutdown (`enableShutdownHooks` + kill process groups).
3. Executor `claude_cli`: spawn `claude -p --output-format stream-json --json-schema <report> --strict-mcp-config --allowedTools ... --max-turns --max-budget-usd` + OS-таймаут; парсинг `system/api_retry` как rate-limit сигнала; env-санация.
4. Executor `claude_routines`: `POST /fire` c ключом тикета + callback URL в тексте; watchdog-таймаут; персист `session_url`. Для него же — **минимальный callback-эндпоинт** `POST /api/callbacks/runs/:runId/complete` с run-JWT (подмножество Phase 1 CallbackModule).
5. PipelineModule: trigger-статус → enqueue; результат → transition success/failure. Отчёт в Phase 0 — через `--json-schema` structured_output (MCP-канал приедет в Phase 1); обёртка инструкции — упрощённый статический шаблон (architecture §7, примечание о фазировке).
6. Конфиг агентов: `agents.yaml` (имя, инструкция, executor, trigger, целевые статусы, таймаут) — hot-reload не нужен.

**Критерии готовности (DoD):**

- [ ] Все 6 агентов гоняют реальные тикеты по моей доске ≥ 1 недели без Jira Automation.
- [ ] Пропущенный вебхук/даунтайм оркестратора не теряет тикеты: поллер догоняет по high-water mark (проверено выключением сервиса на час под движением тикетов).
- [ ] Ни одного дабл-прогона (ticket, agent) — подтверждено уникальным индексом и логами за неделю.
- [ ] Упор в 5-часовой лимит подписки не роняет джобы: очередь паузится и доигрывает после окна.
- [ ] Каждый run в Postgres: статус, стоимость, usage, structured report, exit-диагностика.

## Phase 1 — Structured output как продукт: дашборд, чеклисты, human-queue

**Цель:** три исходные боли закрыты полностью: читаемые чеклисты вместо простыней, единая очередь «нужен человек», надёжные отчёты.

Состав:

1. **Callback-канал**: `CallbackModule` (HTTP API + run JWT), stdio MCP-сервер `brigadir-mcp` (report_progress / request_human / complete_task), Stop-hook enforcement, единый zod-контракт. `complete_task` становится источником правды о завершении; `--json-schema` — fallback.
2. **ReportSchema v1** ([architecture.md](architecture.md) §6) + `run_checks` + скраббер секретов.
3. **Human-queue**: `human_tasks`, blocking/non-blocking семантика, resume прогона с `resolution` в контексте, transition в Blocked + ADF-коммент.
4. **Vue-дашборд**: доска тикетов (зеркало Jira-статусов) → карточка тикета (история прогонов, чеклисты ✅/❌, таймлайн, стоимость) → очередь human-tasks (разрешение из UI) → лента событий (SSE). Retry/cancel прогона из UI.
4a. **UI workspace и агентов** (перенесено из Phase 2, решение 2026-07-10): визард создания workspace с подключением Jira по API token (валидация `GET /myself` + чтение проекта, `expires_at` с предупреждениями), переподключение в настройках; CRUD агентов (инструкция, executor/модель, триггер- и целевые статусы из живого списка статусов проекта, тестовый прогон).
5. ADF-чеклисты в Jira-комментах (taskList + panel) — короткая версия, «подробности в BRIGADIR».

**DoD:**

- [ ] QA-агент репортит только через `complete_task`; 100% прогонов за тестовую неделю имеют валидный отчёт или явный `failed` с диагностикой.
- [ ] Вопрос агента появляется в очереди ≤ 5 сек после `request_human`; ответ из UI возобновляет прогон без ручных действий в Jira.
- [ ] На карточке тикета видно за 10 секунд: что сделано, что упало и почему, сколько стоило.
- [ ] В Jira-комменте — читаемый чеклист, а не простыня (субъективная проверка на себе: перестал открывать сырые логи).

## Phase 2 — Продуктовая модель: workspace, агенты из UI, все 4 executor'а

**Цель:** продукт настраивается без правки кода: workspace + агенты + executor'ы создаются в UI; чужой человек может развернуть self-hosted и собрать свой пайплайн.

Состав:

1. CRUD workspace/executors/agents в UI; шифрование секретов; health-checks executor'ов; onboarding-визард (подключение Jira, маппинг статусов доски).
2. **Все 4 executor'а**: + `anthropic_api` (Agent SDK, in-process MCP, `outputFormat`), + `deepseek_api` (план A: Anthropic-совместимый endpoint — перед выбором A/B спайк на поведение SDK без `cache_control` и на имена моделей; план B: OpenAI-loop; policy-деградация: forced tool call отчёта, repair-loop, no-vision routing, недоверие self-report — `verification: run_tests`).
3. **Компилятор обёртки инструкций** из behavior options (§7 архитектуры) для всех executor'ов.
4. Streamable HTTP MCP endpoint (`/mcp`) как четвёртый биндинг callback'ов.
5. Валидация пайплайна: линтер конфигурации агентов (циклы статусов, недостижимые статусы, конфликтующие триггеры).
6. ToS-матрица в UI: `claude_cli` доступен только при self-hosted развёртывании; предупреждение у `claude_routines` о привязке к личному аккаунту (действия от имени владельца, дневной cap); предупреждения об экспирации Jira-токена и `setup-token`.

**DoD:**

- [ ] Пайплайн из ≥ 3 агентов на ≥ 2 разных executor'ах собирается в UI без правки файлов и проходит тикет от Ready до Done.
- [ ] Один и тот же агент (инструкция + behavior) переключается между `anthropic_api` и `deepseek_api` без изменения инструкции; отчёты валидны на обоих.
- [ ] Внешний пользователь (не я) развернул self-hosted по README и запустил свой пайплайн (пилотный дизайн-партнёр).
- [ ] Секреты не встречаются в логах/отчётах/Jira (автотест скраббера + ручной аудит).

## Phase 3 — Multi-tenant: auth, BYOK, песочницы, self-hosted runner

**Цель:** облачная версия для команд при сохранении self-hosted; легальная модель исполнения.

Состав:

1. Users/orgs/roles, SSO; Jira **OAuth 2.0 3LO app** (vault refresh-токенов с сериализованной ротацией, cloudId-роутинг, динамические вебхуки: 5/user cap, 30-дневный refresh-крон, `/webhook/failed` sweep) — API-token путь остаётся для self-hosted.
2. BYOK: ключи Anthropic/DeepSeek per workspace, шифрование, spend-лимиты per workspace.
3. **Песочницы**: `RunRuntime` → Docker `--runtime=runsc`; default-deny egress; credential-injecting proxy (git + Jira токены не входят в песочницу).
4. **Self-hosted runner**: агент-демон у клиента (его `claude` CLI, его подписка — легально), коннектится к облачному UI по outbound WebSocket/gRPC; облако не видит ни кода, ни подписочных токенов.
5. Per-tenant rate budgets (Jira 65k points pool!), квоты конкурентности, изоляция очередей.

**DoD:**

- [ ] Две организации на одном инстансе не влияют друг на друга (нагрузочный тест: одна упирается в лимиты — вторая не деградирует).
- [ ] Прогон в песочнице не может достучаться до чужих секретов/сети (пентест-чеклист: env dump, egress-скан, git-креды).
- [ ] Runner-режим: облачный UI управляет пайплайном, исполнение на машине клиента, подписочный токен не покидает её.
- [ ] Jira 3LO: переживает ротацию refresh-токена под конкурентными воркерами и 90-дневный re-auth сценарий.

## Phase 4 — Прод: биллинг, наблюдаемость, аудит

Состав: биллинг (per-seat + metered прогоны; маржа на managed-executor'ах), полная наблюдаемость (OTel-трейсы прогонов, метрики очередей, алерты: token expiry, webhook died, cache-hit-rate упал), audit log (кто/что/когда: каждое действие в Jira от имени системы), ретенция и экспорт данных, SOC2-подготовка, Marketplace-листинг 3LO-приложения, опционально executor `managed_agents` (Anthropic Managed Agents) и интеграция «BRIGADIR как назначаемый агент» в Atlassian Agents in Jira.

**DoD:** платящие команды; окупаемость юнит-экономики прогона; прохождение вендор-ревью Atlassian.

---

## Сквозные риски

| Риск | Митигация |
|---|---|
| Atlassian (Rovo Dev) смыкает нишу | Скорость к Phase 1–2 (дифференциаторы), BYO-экономика, self-hosted; план Б — интеграция в Agents in Jira как «их» агент |
| Anthropic ужесточает ToS / ломает `/fire` (research preview) | Ядро не зависит от Routines; `claude_cli` — официальный CLI (разрешён); BYOK-путь всегда работает |
| DeepSeek deprecation (deepseek-chat 2026-07-24) и нестабильность | Имена моделей — конфиг, не код; health-checks; план B (OpenAI-loop) |
| Jira ломает API (прецедент: удаление /search) | Все вызовы через один JiraModule; changelog-мониторинг; reconciliation переживает деградацию вебхуков |
| Экспирация кредов (Jira token 1 год, setup-token 1 год, OAuth 90 дней) | Единый credential-реестр с `expires_at` + алерты за 30/7/1 день |
