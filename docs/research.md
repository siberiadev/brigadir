# BRIGADIR — Результаты исследования (deep research)

Дата исследования: **2026-07-09**. Пять параллельных research-агентов, приоритет — официальная документация. Каждый раздел завершается блоком **«Что это меняет в архитектуре»**.

Легенда достоверности: **[док]** — задокументированный факт, **[вывод]** — наша интерпретация/синтез, **[сообщ]** — сторонний/комьюнити-источник.

---

## 1. Claude Code cloud / Routines

### Главное: программный API запуска СУЩЕСТВУЕТ

**[док]** Routines — сохранённые конфигурации Claude Code (промпт + репозитории + коннекторы), выполняются в облаке Anthropic. Три типа триггеров: **Scheduled** (cron, минимум 1 час), **API** (HTTP-эндпоинт на каждый routine), **GitHub events**. Статус — research preview, доступно на Pro/Max/Team/Enterprise.
Источник: https://code.claude.com/docs/en/routines

```
POST https://api.anthropic.com/v1/claude_code/routines/{routine_id}/fire
Authorization: Bearer sk-ant-oat01-...            # per-routine token, показывается один раз (только в web UI)
anthropic-beta: experimental-cc-routine-2026-04-01 # обязателен
Content-Type: application/json

{"text": "free-form context, max 65,536 chars"}

--> 200 {"type":"routine_fire","claude_code_session_id":"session_01...","claude_code_session_url":"https://claude.ai/code/..."}
```

Ключевые свойства **[док]**:

- **Fire-and-forget**: ответ приходит сразу после создания сессии; API **не стримит вывод и не ждёт завершения**.
- **Нет idempotency key** — каждый успешный POST создаёт новую сессию (ретраи вебхуков = дубли сессий).
- Токен скоупится на запуск **только одного** routine: «no read access, no access to other routines». Управление токенами — только через UI.
- Ошибки: `400` (нет beta-заголовка / текст длиннее лимита / routine на паузе), `429 rate_limit_error` + `Retry-After` (дневной лимит запусков routine или лимит подписки), `401/403/404/500/503`.
- Routine привязан к **личному аккаунту claude.ai** (не шарится в команде); все действия (коммиты, PR, комменты через коннекторы Jira/Slack) идут **от имени этого пользователя**.
- Запуск полностью автономный: **никаких permission-промптов**, доступны все инструменты подключённых коннекторов, включая записи. Гардрейл: push только в ветки с префиксом `claude/` (если не отключено).
- Лимиты: дневной cap на запуски routines per-account + обычные лимиты подписки.

### Передача параметров и получение результата

- **Вход [док]**: только поле `text` (свободный текст, не парсится, до 65 536 символов). Паттерн: `{"text": "Process BRIG-123"}` + сохранённый промпт «возьми тикет из текста триггера через Atlassian-коннектор». Ровно этот паттерн — в официальном примере alert-triage.
- **Выход: публичного API чтения НЕТ [док]**. Токен `/fire` не даёт read-доступа; эндпоинтов чтения сессий Claude Code нет. Beta API `/v1/sessions` — это **другой продукт** (Managed Agents), и даже он не возвращает транскрипты.
- Задокументированные паттерны получения результата — «push изнутри прогона»: routine сам открывает PR, сам комментирует Jira-тикет через Atlassian-коннектор, сам постит в Slack. `/fire` возвращает `session_id` + human-readable `session_url` — их надо персистить для корреляции.
- **[док]** Зелёный статус запуска «не означает, что задача из промпта выполнена» — только что сессия завершилась без инфраструктурной ошибки.
- Полу-ручной канал: `claude --teleport <session-id>` затягивает облачную сессию в локальный терминал (нужен login той же подписки).

### CLI ↔ cloud

- `claude --cloud "task"` — создать облачную сессию из терминала; `/schedule` — управлять **scheduled**-роутинами из CLI. **API- и GitHub-триггеры создаются только в web UI** [док].
- Токены `claude setup-token` «scoped to inference only» — не могут устанавливать Remote Control сессии; **[вывод]** скорее всего не могут и запускать `--cloud`/`--teleport`.
- Окружение облачного прогона: Ubuntu 24.04 (~4 vCPU/16 GB), уважает `CLAUDE.md`/`.claude/settings.json`/`.mcp.json` из репо (но не `~/.claude`), env-переменные окружения **не являются секрет-стором** (видны редакторам окружения), сетевые уровни None/Trusted/Custom/Full.

### Что это меняет в архитектуре

1. Executor «Claude Code Routines» реален и дешёв в реализации: `POST /fire` с ключом тикета. Но он обязан быть **fire-and-forget с push-репортингом**: наш оркестратор дедуплицирует на своей стороне, персистит `session_id`/`session_url` в run, а **фактом завершения считает побочные эффекты** (коммент в Jira / PR / вызов нашего HTTP-callback изнутри прогона).
2. Привязка к личному аккаунту + beta-заголовок + UI-only токены ⇒ Routines — **опциональный zero-ops бекенд для Phase 0 / соло-режима**, а не ядро продукта. Ядро — свой раннер на `claude -p` / Agent SDK.
3. HTTP-вариант callback-протокола (см. §6) для Routines обязателен: MCP stdio туда не подключить, но routine может дергать наш API как обычный HTTP-инструмент (или через подключённый remote MCP).

---

## 2. `claude -p` (headless mode)

Источники: https://code.claude.com/docs/en/headless · https://code.claude.com/docs/en/cli-reference · https://code.claude.com/docs/en/authentication

### Актуальные флаги (середина 2026) [док]

| Группа | Флаги |
|---|---|
| Ядро | `-p/--print`; stdin до 10 MB; **`--bare`** — отключает автоподхват hooks/skills/plugins/MCP/CLAUDE.md («recommended mode for scripted and SDK calls», станет дефолтом для `-p`) |
| Вывод | `--output-format text\|json\|stream-json`, `--input-format`, `--include-partial-messages`, **`--json-schema '<schema>'`** → валидированный `structured_output` в результате |
| Разрешения | `--allowedTools` / `--disallowedTools` (синтаксис правил, напр. `Bash(git diff *)`), `--permission-mode default\|acceptEdits\|plan\|auto\|dontAsk\|bypassPermissions`, `--dangerously-skip-permissions`, `--permission-prompt-tool <mcp_tool>` |
| Промпт | `--system-prompt(-file)`, `--append-system-prompt(-file)` |
| Контроль | `--max-turns`, **`--max-budget-usd`**, `--model`, `--fallback-model`, `--effort` |
| Сессии | `--continue`, `--resume <id>`, `--fork-session`, `--session-id <uuid>`, `--no-session-persistence` |
| MCP | `--mcp-config <file\|json>` (**инлайн-JSON поддерживается**), `--strict-mcp-config` (игнорировать все прочие MCP-конфиги) |
| Прочее | `--agents '<json>'`, `--settings`, `--verbose`, `--debug-file`, `-w/--worktree` |

JSON-результат (`--output-format json`): `{type:"result", subtype:"success"|"error_max_turns"|"error_during_execution"|"error_budget", is_error, num_turns, result, session_id, total_cost_usd, usage:{...}, structured_output?}`.

**stream-json** даёт события `system/init` и **`system/api_retry`** с категорией ошибки `rate_limit | overloaded | billing_error | authentication_failed | ...`, `attempt`, `retry_delay_ms`, `error_status` — **это единственный документированный программный детектор rate-limit посреди прогона**.

### Auth и headless

- `claude setup-token` → OAuth-токен на **1 год** (`sk-ant-oat01-…`), экспортируется как `CLAUDE_CODE_OAUTH_TOKEN`. Требует Pro/Max/Team/Enterprise. Scoped to inference only. **`--bare` его НЕ читает** (в bare — только `ANTHROPIC_API_KEY`/`apiKeyHelper`).
- Порядок приоритета аутентификации [док]: cloud-провайдеры → `ANTHROPIC_AUTH_TOKEN` → **`ANTHROPIC_API_KEY`** (в `-p` «always used when present»!) → `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` → OAuth подписки из `/login`. **Экспортированный API-ключ молча перебивает подписку** — раннер обязан санировать env.

### Rate limits и коды выхода

- **Отдельного exit-кода для «usage limit reached» НЕТ** [док-отсутствие; GitHub issue #36320]: при упоре в 5-часовое окно CLI завершается с ненулевым кодом без различимой причины.
- Надёжная детекция **[вывод]**: парсить `--output-format json` (`is_error` + текст `result`) или `stream-json` (`api_retry` с `error:"rate_limit"`/`error_status:429`). Exit-коды трактовать только как 0/не-0.
- Глобального `--timeout` нет — оборачивать в OS `timeout(1)`; бюджеты через `--max-turns` + `--max-budget-usd`.

### ToS: что можно и что нельзя (критично)

- **[док]** Consumer Terms запрещают автоматизированный доступ «except via an Anthropic API key or where Anthropic explicitly permits it». Официальный CLI (`claude -p` в скриптах, cron, CI) — **явно разрешён** (docs Anthropic сами показывают такие примеры; `claude-code-action` официально документирует `setup-token` для Pro/Max).
- **[док, февраль 2026]** Anthropic явно закрепил: «Using OAuth tokens obtained through Claude Free, Pro, or Max accounts in any other product, tool, or service — **including the Agent SDK** — is not permitted». С января 2026 идёт enforcement (заблокированы OpenClaw, OpenCode, Roo Code, Goose).
- **[вывод]** Для нас:
  - ✅ **Разрешено**: автоматизация своего аккаунта на своей машине/CI через официальный `claude` CLI; запуск чужих routines через их `/fire` токен, который пользователь сам создал.
  - ⚠️ **Запрещено**: Agent SDK + подписочный OAuth-токен (SDK — только с API-ключом).
  - ❌ **Запрещено**: multi-tenant SaaS, где наш сервис хранит подписочные OAuth-токены клиентов и гоняет агентов от их имени.

### Что это меняет в архитектуре

1. Executor `claude_cli`: спавним `claude -p --output-format stream-json --json-schema <report> --mcp-config '<inline>' --strict-mcp-config --allowedTools ... --max-turns --max-budget-usd` + OS-таймаут. Health-сигнал — поток JSON-событий, не exit-код.
2. `--bare` желателен для воспроизводимости, но **несовместим с подписочной авторизацией** ⇒ для подписочного режима работаем без `--bare`, но с `--strict-mcp-config` и явным `--settings`.
3. Легальная матрица прошита в модель executor'ов: `claude_cli` — только «свой CLI на своей машине» (self-hosted runner); `anthropic_api` (Agent SDK/API-key) — единственный санкционированный commercial-путь.

---

## 3. Anthropic API / Claude Agent SDK

Источники: https://code.claude.com/docs/en/agent-sdk (+ /structured-outputs, /permissions, /custom-tools, /mcp) · https://platform.claude.com/docs/en/about-claude/pricing.md · https://platform.claude.com/docs/en/api/rate-limits.md

### Как строить агентный прогон

Три официальных уровня **[док]**:

1. **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — Claude Code как библиотека: встроенные тулзы (Read/Write/Edit/Bash/Glob/Grep/WebSearch...), permission modes (для headless — `dontAsk` + явные `allowedTools`), hooks (PreToolUse/PostToolUse/**Stop**/SessionEnd), субагенты, resume сессий. **Лучший выбор для нашего executor'а `anthropic_api`.** Под капотом SDK спавнит бинарь Claude Code.
2. Raw Messages API + tool use — только если нужен полностью свой цикл (актуально для DeepSeek-совместимости).
3. **Managed Agents** (beta) — Anthropic хостит и цикл, и sandbox (маунт GitHub-репо через прокси, SSE-стрим, вебхуки; $0.08/session-hour + токены). Кандидат в executor будущей фазы «no sandbox ops».

Ключевое для нас в SDK **[док]**:

- **Structured output на уровне харнесса**: `outputFormat: {type:'json_schema', schema}` — SDK валидирует финальный ответ по схеме и **сам ре-промптит при несоответствии**; результат в `structured_output` у `SDKResultMessage`; отдельный subtype ошибки `error_max_structured_output_retries`.
- **In-process MCP**: `createSdkMcpServer()` + `tool()` (Zod) — наши callback-тулзы работают **внутри процесса воркера без child-процесса и токенов**.
- `canUseTool` callback — программные permission-решения.
- Хуки in-process: `Stop`-хук может заблокировать завершение («сначала вызови complete_task»).

### Цены и стоимость прогона (mid-2026) [док]

| Модель | Input $/MTok | Output $/MTok | Cache read |
|---|---|---|---|
| Claude Fable 5 | 10 | 50 | 1.00 |
| Claude Opus 4.8 | 5 | 25 | 0.50 |
| Claude Sonnet 5 (intro до 2026-08-31) | 2 | 10 | 0.20 |
| Claude Sonnet 5 (с 2026-09-01) / 4.6 | 3 | 15 | 0.30 |
| Claude Haiku 4.5 | 1 | 5 | 0.10 |

- Кэш: write 1.25× (5 мин) / 2× (1 час), read **0.1×**. В агентном цикле кэш — не оптимизация, а необходимость (~3× разницы в стоимости input).
- **Оценка стоимости среднего прогона** (0.5–2M input-событий при ~80% cache-hit, 20–50k output) **[вывод]**: Haiku ~$0.26–0.89, **Sonnet 5 ~$0.5–1.8**, **Opus 4.8 ~$1.3–4.5**, Fable 5 ~$2.6–8.9. Без кэша — умножить input-часть на ~3.
- Rate limits: тиры Start/Build/Scale; **cache_read токены НЕ считаются в ITPM** — на Start-тире (400k OTPM/2M ITPM) реалистично ~100–200 параллельных прогонов; узкое место — OTPM и месячный spend cap тира.
- Новый токенизатор (Opus 4.7+/Sonnet 5/Fable 5): ~+30% токенов на тот же текст.

### Что это меняет в архитектуре

1. Не писать свой tool-loop для Claude-пути: воркер = workspace → `git clone` → один `query()` с `permissionMode:'dontAsk'` + `allowedTools` + `outputFormat` → `structured_output`.
2. Телеметрия обязана проверять `usage.cache_read_input_tokens > 0` per run; системный промпт — байт-стабильный на тикет.
3. Планировщик — token-budget по заголовкам `anthropic-ratelimit-*`; 429 = backpressure очереди, не per-request ретрай.

---

## 4. DeepSeek API

Источники: https://api-docs.deepseek.com (pricing, rate_limit, tool_calls, json_mode, anthropic_api, news260424)

### Состояние (mid-2026) [док]

- **Модели: `deepseek-v4-pro`** (1M ctx, thinking + non-thinking) и `deepseek-v4-flash`. **`deepseek-chat` и `deepseek-reasoner` deprecated 2026-07-24** — хардкод старых имён сломается через две недели после даты исследования!
- OpenAI-совместимый endpoint + **Anthropic-совместимый endpoint** `https://api.deepseek.com/anthropic` (маппинг имён моделей Claude→DeepSeek; поддержаны tool use, tool_choice, thinking, streaming; **НЕ поддержаны**: изображения, `cache_control`, server-side MCP-блоки).
- **Tool use в thinking-режиме поддержан** (с V3.2); V4 сохраняет reasoning-историю между tool-раундами.
- JSON mode — только `json_object` (без schema); **строгие схемы только у tool-аргументов** (beta `strict: true`, все поля required, без min/max-ограничений). Документированный баг: «may occasionally return empty content».
- Цены: v4-pro $0.435/$0.87 per MTok (cache hit $0.0036!), v4-flash $0.14/$0.28. Автоматический кэш. Off-peak скидок больше нет.
- Лимиты: **не RPM/TPM, а конкурентность** — 500 одновременных запросов (pro), 2500 (flash); 429 при превышении.
- **Стоимость прогона [вывод]: v4-pro ~$0.06–0.22** — в 10–25 раз дешевле Sonnet 5.

### Ограничения vs Claude [док/сообщ]

- Только текст (нет vision → нет скриншот-верификации).
- Очень высокая галлюцинация при неуверенности (AA-Omniscience: ~94–96% вместо отказа) — фабрикация путей, аргументов, «тесты прошли».
- Слабее в multi-constraint instruction following и длинных агентных цепочках; нет серверных тулз/Managed Agents/fallback-механики.
- Инфраструктура в Китае — блокер для части клиентов.

### Что это меняет в архитектуре

1. **Возможно, не нужен второй харнес**: Anthropic-совместимый endpoint DeepSeek позволяет гнать один Claude-shaped цикл с подменой `ANTHROPIC_BASE_URL` (сам DeepSeek рекламирует интеграцию с Claude Code). Держим raw-OpenAI путь как fallback.
2. DeepSeek-executor обязан иметь **policy-слой деградации**: финальный отчёт — как forced tool call (не текстовый JSON), repair-loop с ре-промптом по ошибке схемы, «done» подтверждается только exit-кодами реальных тестов, задачи с визуальной верификацией не роутятся на DeepSeek.
3. Планировщик DeepSeek-очереди лимитирует **число in-flight запросов**, а не токены.

---

## 5. Jira Cloud

Источники: developer.atlassian.com (basic-auth, oauth-2-3lo-apps, scopes, webhooks, rate-limiting, jira-entity-properties) + community/changelogs

### Auth: выбор по фазам

| Фаза | Способ | Обоснование |
|---|---|---|
| Self-hosted MVP | **API token + basic auth** от выделенного бот-аккаунта | Ноль регистраций; но с дек. 2024 токены живут **максимум 1 год** (легаси-токены принудительно умерли к маю 2026) → нужны алерты об истечении и лёгкая ротация |
| Пилот / малый multi-user | Один распространяемый **3LO-app** | Atlassian прямо запрещает вендорам собирать клиентские API-токены («don't comply with our Security requirements»); 3LO открывает динамические вебхуки |
| SaaS | 3LO + (опционально) тонкий Forge-компаньон | Forge — если понадобятся нативные события/`asApp`/Marketplace. **Connect мёртв** (EOS конец 2026) |

Детали 3LO **[док]**: access-токен 1 час; **ротирующиеся refresh-токены** (каждый refresh инвалидирует старый; 90 дней inactivity-expiry; 10-минутный leeway на конкурентный reuse) ⇒ нужен vault + **сериализация refresh per-tenant (lock)**. Вызовы — `api.atlassian.com/ex/jira/{cloudId}/...`, discovery через `/oauth/token/accessible-resources`. Семантика только asUser ⇒ для бот-идентичности клиент авторизует ботовым пользователем.

### Webhooks [док]

- **Admin system webhooks**: UI/REST, нужен Jira-админ, полный JQL, HMAC-секрет, **без экспирации** — идеально для self-hosted MVP.
- **Динамические вебхуки OAuth-app** (`/rest/api/3/webhook`): лимит **5 на app×пользователя×тенант**; JQL-фильтр урезан (project, status, assignee...; без `updated >=`); **экспирация 30 дней** — обязателен refresh-крон; доставка best-effort, возможны дубли (**дедуп по `X-Atlassian-Webhook-Identifier`**), до 5 ретраев с backoff 5–15 мин; `GET /webhook/failed` хранит провалы ~72 часа.
- Automation → outgoing webhook: zero-code альтернатива, но без ретраев и жрёт квоту automation клиента (наша исходная боль).

### JQL polling [док]

- **Старые `/rest/api/2|3/search` УДАЛЕНЫ (410 Gone с конца 2025).** Новый `/rest/api/3/search/jql`: **курсорная пагинация `nextPageToken`**, без `total` (есть `/search/approximate-count`), поля только по явному списку `fields`.
- Паттерн reconciliation: `project = X AND updated >= "-6m"` каждые 5 мин (окно > интервала), high-water mark по `updated` в нашей БД, стриминговый diff против последнего известного статуса.

### Rate limits [док]

- Cost-based квоты (у приложений — общий пул 65k points/час, расширяемый), burst ~100 RPS GET, **per-issue write: 20 записей/2 сек и 100/30 сек** — оркестратор, постящий коммент+transition+property подряд, упрётся ⇒ **сериализация записей per-issue**.
- 429 + `Retry-After` + `X-RateLimit-*`/`Beta-RateLimit*` + `RateLimit-Reason` (`quota-global-based` | `burst-based` | `per-issue-on-write` — по нему видно, в какой из потолков упёрлись); официальные рекомендации: exponential backoff + jitter.

### Transitions, ADF, issue properties [док]

- Transition id **уникален per-workflow** и валиден только из текущего статуса ⇒ **runtime-discovery**: `GET /transitions`, матч по целевому статусу, POST; конкурентные переходы → **409** (ре-фетч + ретрай); кэш per project+issuetype с инвалидацией.
- Комментарии в v3 — только **ADF** (JSON-дерево). Хорошая новость: ADF нативно поддерживает `taskList`/`taskItem`/`panel`/`table` ⇒ чеклисты агентов рендерим первоклассно. Нужен свой ADF-composer (и parser, если читаем ответы людей).
- **Issue properties**: скрытый JSON на тикете, ≤32 KB, до 100 на app; поддержаны в JQL-фильтрах вебхуков. Идеально для run-метаданных (id прогона, идемпотентные маркеры). Без compare-and-swap ⇒ один писатель per issue.

### Что это меняет в архитектуре

1. Вебхуки — **ускоритель, никогда не источник правды**; гарантированный путь — reconciliation-поллер (это совпадает с уже принятым решением, теперь с конкретикой: `/search/jql` + nextPageToken + high-water mark).
2. Обязательные компоненты: refresh-крон вебхуков (< 30 дней), дедуп-ingest, per-issue write queue, runtime transition discovery c 409-ретраем, ADF-composer, token-expiry алерты.
3. Никогда: Connect, сбор клиентских API-токенов в SaaS, старые `/search`.

---

## 6. MCP stdio callback-сервер

Источники: modelcontextprotocol.io (spec 2025-06-18 / 2025-11-25), typescript-sdk, code.claude.com (mcp, custom-tools, hooks)

### Ключевые факты [док]

- Транспорты MCP надолго два: **stdio** (локально; клиент спавнит сервер как subprocess, NDJSON, stdout — только протокол, логи — в stderr) и **Streamable HTTP** (удалённо; один `/mcp` endpoint, `Mcp-Session-Id`, bearer-auth).
- TS SDK: `McpServer` + `registerTool(name, {inputSchema: zod}, handler)` + `StdioServerTransport` — сервер с тремя тулзами пишется за час.
- Подключение per-run:
  - `claude -p`: `--mcp-config '<inline JSON>'` с блоком `env` (туда инжектим `RUN_ID` + `RUN_TOKEN`) + `--strict-mcp-config` + `--allowedTools "mcp__brigadir__*"`.
  - Agent SDK: `createSdkMcpServer` **in-process** — хендлеры замыкаются на BullMQ job напрямую, ни child-процесса, ни токена.
  - OpenAI-совместимый цикл: MCP-клиента нет — оркестратор сам объявляет те же схемы как OpenAI `tools[]` и сам исполняет.
- **Аутентификация/корреляция**: env-инжекция per-run bearer-токена — задокументированный первоклассный паттерн MCP-auth; prior art — AWS `cli-agent-orchestrator` (env `CAO_TERMINAL_ID` для роутинга статусов). Токен живёт в процессе тулзы, **модель его не видит** ⇒ prompt-injection не может его слить. Секреты в env, не в argv (argv виден в `ps`).
- **Tool call как финальный отчёт** надёжнее печати JSON: аргументы валидируются схемой при вызове, невалидный отчёт отбивается обратно модели (self-healing). Слабое место: модель может «забыть» вызвать → **`Stop`-хук Claude Code возвращает `{"decision":"block","reason":"сначала вызови complete_task"}` и заставляет агента доделать**.

### Что это меняет в архитектуре

1. **Один контракт тулз — три биндинга** (stdio MCP / in-process SDK MCP / OpenAI functions) из одного zod/JSON-Schema модуля.
2. **Источник правды о завершении — получение оркестратором `complete_task`-callback'а**, не stdout CLI. Exit JSON — диагностика.
3. Для облачных executor'ов (Routines) — четвёртый биндинг: тот же контракт как **Streamable HTTP MCP** endpoint (`/mcp`) на нашем NestJS с per-run bearer, либо прямые HTTP-вызовы.

---

## 7. BullMQ для долгих джобов

Источники: docs.bullmq.io, api.docs.bullmq.io, docs.nestjs.com/techniques/queues

### Ключевые факты [док]

- **Локи авто-продлеваются**, пока event loop жив; джоб «stalled» только если renewal сорвался. Наш процессор I/O-bound (await spawn `claude`) ⇒ **60-минутные джобы работают на дефолтных настройках**; гигантский lockDuration не нужен и вреден. `maxStalledCount: 0/1` для неидемпотентных прогонов.
- Конкурентность: worker `concurrency` + **`queue.setGlobalConcurrency(N)`** (потолок на всю очередь) ⇒ паттерн «очередь на executor-тип со своим cap».
- **Rate-limit-реакция**: `await worker.rateLimit(ttlMs); throw Worker.RateLimitError()` — джоб возвращается в waiting **без расхода attempt**; кастомный `backoffStrategy(attempts, type, err)` для header-derived задержек; `UnrecoverableError` — мгновенный fail.
- **Дедупликация**: `deduplication: {id: ticketId}` (simple mode — до завершения джоба) + DB unique constraint как последний рубеж.
- **`upsertJobScheduler`** — современный API для reconciliation-крона (upsert-семантика, без дублей на деплое).
- Flows (parent-child, `waiting-children`) — есть, но для линейного пайплайна проще «оркестратор добавляет следующий джоб по факту complete_task».
- NestJS: `@Processor('name', {concurrency}) extends WorkerHost`; **sandboxed-процессоры лишаются DI** ⇒ предпочесть обычные (тяжёлая работа всё равно в спавненном `claude`). Обязательно `app.enableShutdownHooks()`; на SIGTERM — `worker.close()` + **убийство process group** ребёнка (`detached: true`, kill `-pid`) — иначе MCP-серверы-внуки становятся зомби. Redis-коннект воркеров: `maxRetriesPerRequest: null`; задать `removeOnComplete/removeOnFail`.
- Отмена активного джоба «снаружи» не встроена ⇒ явный механизм: флаг `cancelled:{runId}` в Redis/DB + процессор слушает и убивает ребёнка.
- Наблюдаемость: `QueueEvents` на Redis Streams (переживает реконнекты), Bull Board (OSS, монтируется в Nest) / Taskforce.sh.

### Что это меняет в архитектуре

Схема очередей фиксируется: `queue:{executor_type}` × `setGlobalConcurrency` = ёмкость executor'а; `limiter` = провайдерский троттлинг; `RateLimitError` = 429/лимиты подписки; heartbeat = наш `report_progress` → `job.updateProgress()` (для UI; liveness BullMQ и так lock-based); reconciliation-sweeper через `upsertJobScheduler` чинит расхождения DB ↔ queue ↔ живость child-PID.

---

## 8. Песочницы для multi-tenant

Источники: Northflank guides, Anthropic engineering blog, github.com/anthropic-experimental/sandbox-runtime, вендорские доки

### Сравнение [док/сообщ]

| Технология | Старт | Изоляция | Сложность | Вердикт |
|---|---|---|---|---|
| Голый процесс + git worktree | мгновенно | нет | нулевая | MVP self-hosted (один трастовый домен) |
| Docker + hardening | мс | общее ядро — не граница тенантов | низкая | ранний multi-tenant, минимум |
| **gVisor (`--runtime=runsc`)** | мс | userspace-ядро | низкая (drop-in к Docker) | **лучший шаг для ранней SaaS**: тот же Docker-флоу, ~10–30% I/O-оверхед не важен на фоне 30–60-мин сессий |
| Firecracker/Kata microVM | 125–500 мс | аппаратная, золотой стандарт | высокая самим / низкая у платформ | серьёзный прод |

- Консенсус 2026: shared-kernel контейнеры — **не граница тенантов** для кода, который LLM написал после чтения attacker-influenced входа (README, npm postinstall).
- SaaS-песочницы: E2B (~$0.05/vCPU-ч), **Daytona (open-source, self-hostable — уникально совпадает с нашей self-hosted-first историей)**, Fly Machines, Modal, Northflank (BYOC), Runloop. 45-мин прогон на 2vCPU ≈ **$0.08–0.25** — COGS песочницы ничтожен на фоне LLM-токенов.
- **Anthropic `sandbox-runtime` (srt)**: bubblewrap/seccomp + **egress-прокси вне песочницы** с доменным allowlist. Не граница тенантов, но бесплатный слой защиты для MVP и **референс-паттерн секретной архитектуры**.
- Секреты: (1) **credential-injecting egress proxy** — токенов вообще нет внутри песочницы (так работает Claude Code on the web с git-кредами); (2) short-lived scoped токены per run; (3) **никогда секреты в env шелла агента** (`env | curl` под prompt-injection); (4) скраббер секретов в выводе перед постингом в Jira; (5) default-deny egress.

### Что это меняет в архитектуре

1. **Сейчас** зафиксировать интерфейс `RunRuntime` (`start(workspace, image, env, egressPolicy) → exec/stream/stop`), чтобы одна и та же логика прогона ехала на: локальный процесс → Docker/runsc → Daytona/microVM.
2. Паттерн «секрет вне досягаемости агента» закладывается **с Phase 0** (git credential helper / env-санация; полноценный брокер с egress-прокси — к multi-tenant фазе); скраббер секретов — в том же пайплайне пост-обработки, что и парсинг structured output.

---

## 9. Конкуренты (mid-2026)

### Критичное: Atlassian пришёл в нашу нишу

- **Rovo Dev in Jira** (раскатка с 2026-04-02): несколько фоновых облачных сессий из любого Jira work item; план → код+тесты в песочнице → PR; триггеры через Jira Automation; **$20/dev/мес + 2000 кредитов, overage $0.01/кредит**; только Bitbucket/GitHub Cloud; model choice «coming soon» на счётчике Atlassian.
- **Agents in Jira** (open beta с 2026-02-24): агенты — назначаемые/упоминаемые «тиммейты» в Jira, включая **сторонних (Copilot, Cursor, Codex, Claude, кастомные через MCP)**.
- **GitHub Copilot coding agent for Jira — GA 2026-06-25**: assign тикета Copilot'у из дропдауна → draft PR, статус стримится в тикет.
- Vibe Kanban: **Bloop закрылся 2026-04-10**, продукт ушёл в комьюнити-OSS. Terragon: **закрылся 2026-02-09** (код открыт) — а ведь это был ровно BYO-subscription раннер. Урок: «голый инструмент без бизнес-модели умирает»; Terragon доказал техническую валидность BYO-модели и умер без workflow-слоя.
- Живые смежники: Omnara ($9/мес; **лучшая реализация мобильного "agent needs you" — референс для нашей human-queue**), Conductor, Sculptor, kandev (18 executor-провайдеров!), Composio Agent Orchestrator (open-source, автономные CI-fix циклы), Shopify Roast (типизированные workflow-шаги — референс для чеклистов), Devin (Jira-интеграция, но единственный проприетарный агент), Claude Managed Agents (это *бекенд* для нас, не конкурент).

### Что стало коммодити (не позиционироваться на этом)

- «Назначь тикет агенту — получи PR» (Rovo Dev, Copilot for Jira, Devin).
- «Kanban-доска гоняет локальных агентов» (мёртвый Vibe Kanban, kandev, куча OSS).
- «Смотри за агентами откуда угодно» (Omnara).

### Оставшаяся ниша (наша)

1. **BYO executor поверх Jira** — никто не даёт гонять Jira-native фоновых агентов на *своей* подписке Claude / своём API-ключе / DeepSeek. Rovo Dev = кредиты Atlassian, Copilot = счётчик GitHub, Devin = Devin. Позиционирование по цене пишет само себя.
2. **Оркестрация разнородного флота с политиками** — маршрутизация тип-тикета→executor, бюджеты конкурентности, retry/escalate, порядок зависимостей. Agents in Jira делает агентов *назначаемыми*, но арбитраж между ними оставляет Automation-правилам.
3. **Human-queue с короткими actionable-задачами + QA-чеклисты из structured output** — ближайший аналог только Omnara (session-level пуши, без тикет/QA-семантики).
4. **Self-hosted-first** — Rovo/Copilot/Devin/Cursor cloud-only.

### Риски и ходы [вывод]

- Atlassian может сомкнуть нишу за 2–3 квартала («model choice coming soon»). Наши устойчивые рвы — BYO-экономика, self-hosting, QA/human-queue слой, а не «Jira-нативность» сама по себе.
- Рассмотреть ход «строить **на** Agents in Jira»: наш оркестратор регистрируется как назначаемый агент через их MCP-поверхность — наследуем их UX назначения, добавляем слой флота/QA/BYO, которого у них нет.

---

## Сводка решений, вытекающих из исследования

| # | Решение | Основание |
|---|---|---|
| 1 | Ядро — свой раннер (`claude -p` / Agent SDK); Routines — опциональный fire-and-forget executor | §1: нет read-API, привязка к личному аккаунту |
| 2 | Матрица легальности executor'ов прошита в продукт: подписка ⇒ только официальный CLI на машине пользователя (self-hosted runner); SaaS ⇒ BYOK API / свои routines клиента | §2 ToS |
| 3 | Финальный отчёт = вызов тулзы `complete_task` (MCP/SDK/OpenAI-functions) + Stop-hook enforcement; факт получения callback'а — источник правды | §6 |
| 4 | Jira Phase 0: бот-аккаунт + API token + `/search/jql`-поллинг (+ опц. admin webhook); SaaS: 3LO + динамические вебхуки + тот же поллинг | §5 |
| 5 | Очередь на executor-тип; `RateLimitError` без расхода attempts; дедуп по ticket; reconciliation через `upsertJobScheduler` | §7 |
| 6 | Интерфейс `RunRuntime` с первого дня; паттерн «секрет вне досягаемости агента» — с Phase 0, полноценный брокер — к multi-tenant | §8 |
| 7 | Дефолтная модель — Sonnet 5 ($0.5–1.8/прогон); DeepSeek v4-pro как бюджетный тир ($0.06–0.22) с policy-деградацией; имена `deepseek-chat/reasoner` не использовать (deprecated 2026-07-24) | §3, §4 |
| 8 | Позиционирование: BYO-executor + флот с политиками + human-queue/QA-чеклисты + self-hosted; НЕ «assign ticket to agent» | §9 |
