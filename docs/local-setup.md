# Локальный запуск BRIGADIR

Полный путь от чистого клона до работающего дашборда. Два режима: **дев-режим** (рекомендуется для разработки и ручных приёмок) и **полный docker compose**.

## 0. Предварительные требования

- **Node.js 22+** (`node --version`) — нужен для `--env-file` и рантайма
- **pnpm** (`corepack enable` включает его из коробки)
- **Docker** (Postgres/Redis поднимаются контейнерами; также нужен интеграционным тестам)
- Для живых прогонов агентов (итерация 3+): установленный и залогиненный **claude** CLI

## 1. Установка и секреты

```bash
git clone git@github.com:siberiadev/brigadir.git && cd brigadir
pnpm install
cp .env.example .env
```

Сгенерируйте и впишите в `.env` три обязательных секрета (бут **упадёт** без любого из них — это намеренно, Constitution V):

```bash
openssl rand -base64 32   # → BRIGADIR_CREDENTIALS_KEY  (AES-256-GCM ключ для Jira-кредов в БД)
openssl rand -hex 32      # → BRIGADIR_DASHBOARD_TOKEN  (bearer дашборда — его вводите в UI)
openssl rand -hex 32      # → BRIGADIR_JWT_SECRET       (подпись per-run callback-токенов)
```

`DATABASE_URL` / `REDIS_URL` в `.env.example` уже указывают на localhost-контейнеры — менять не нужно.

**Почему порты 5434/6380, а не стандартные**: у разработчиков часто крутятся brew-овские Postgres/Redis на 5432/6379, привязанные к `127.0.0.1`. Они перехватывают коннект на `localhost` раньше Docker-контейнера (тот слушает `0.0.0.0`), и вы молча попадаете в чужую базу («role brigadir does not exist») или чужой Redis (флейк итерации 1). Поэтому контейнеры проекта мапятся на **5434** (Postgres) и **6380** (Redis) — конфликт исключён по построению.

**Про `agents.yaml`**: файл ОПЦИОНАЛЕН (с итерации 5 источник правды — БД). Если он есть, при первом буте импортируется **один раз** (существующие строки никогда не перезаписываются); дальше конфигурируйте через дашборд. Свежий старт без yaml тоже работает — workspace создаётся визардом. Нюанс: до итерации 6 у agent-формы нет создания executor'ов, поэтому для агентов в новом workspace executor пока сидится через yaml.

## 2. Дев-режим (рекомендуется)

Четыре терминала (или фоновые процессы):

```bash
# 1. Инфраструктура — только БД и Redis
docker compose up -d postgres redis

# 2. Сборка (contracts + mcp-server + backend + worker + web)
pnpm build

# 3. Backend (миграции и сид выполняются при буте автоматически)
node --env-file=.env dist/apps/backend/main.api.js

# 4. Worker (поллер, reconcile, исполнение прогонов)
node --env-file=.env dist/apps/worker/main.worker.js
```

Проверка: `curl localhost:3000/health` → ok.

**Фронтенд** — два варианта:

```bash
# а) hot-reload разработка: Vite на :5173, /api проксируется на :3000
pnpm --filter @brigadir/web dev
# → открыть http://localhost:5173

# б) как в проде: backend раздаёт собранный apps/web/dist сам
# → просто открыть http://localhost:3000 (сборка уже сделана шагом 2)
```

При первом открытии дашборд спросит bearer — вставьте значение `BRIGADIR_DASHBOARD_TOKEN` из `.env` (хранится в sessionStorage, в бандл не зашивается).

⚠️ `node --env-file` обязателен: `.env` сам по себе никем не читается, а `pnpm start:backend` переменные из него не подхватит.

## 3. Полный docker compose

`docker-compose.yml` не содержит секретов. Добавьте им pass-through (списком, БЕЗ `${}`-интерполяции значений) в сервисы `backend` и `worker`:

```yaml
    environment:
      # ...существующие...
      - BRIGADIR_CREDENTIALS_KEY
      - BRIGADIR_DASHBOARD_TOKEN
      - BRIGADIR_JWT_SECRET
```

Затем:

```bash
export BRIGADIR_CREDENTIALS_KEY=... BRIGADIR_DASHBOARD_TOKEN=... BRIGADIR_JWT_SECRET=...
docker compose up --build
# → http://localhost:3000
```

Помните: `agents.yaml` запекается в образ при сборке — после его правки нужен `--build`, не рестарт.

## 4. Первые шаги в дашборде

1. **Workspaces → New workspace**: имя → Jira (site URL, email бота, API-токен с id.atlassian.com, срок действия токена — вводится вручную, Jira его не отдаёт; board id или URL борды) → **Verify** покажет имя бота, проект и тип борды → репозитории (первый = дефолтный) → создать.
2. **Agents → New agent**: статусы подтянутся с живой борды (плоским списком); линтер подсветит несуществующий статус / дубль триггера прямо в форме.
3. **Проверка конвейера**: кнопка «test run by ticket key» у агента, либо перетащите тикет в trigger-статус на Jira-доске — поллер подхватит на следующем проходе (интервал reconcile — 5 минут; для мгновенной реакции перезапустите worker или дёрните test-run).

## 4a. Bedrock / корпоративный Claude

Если на машине Claude Code ходит в модели ТОЛЬКО через AWS Bedrock (корпоративный доступ, нет подписки `~/.claude` и нет прямого Anthropic API-ключа), обычный `claude_cli`-профиль падает на старте CLI («Not logged in · Please run /login»), а прогон — с «no schema-valid structured_output». Решение — auth-режим **bedrock** в профиле executor'а (feature 018): всё настраивается из дашборда, без экспортов в шелл воркера и без правок кода/allowlist'а.

**Предпосылки на машине воркера** (не в BRIGADIR):

1. `~/.aws` с рабочим доступом к Bedrock: именованный профиль (`AWS_PROFILE`) или дефолтная цепочка кредов. SSO-сессию обновляет человек (`aws sso login`) — протухшие креды = упавший прогон с диагностикой, это ожидаемо.
2. Если корпоративный TLS-перехват — путь к CA-бандлу (PEM) на диске воркера.
3. `claude` CLI, поддерживающий Bedrock (переменная `CLAUDE_CODE_USE_BEDROCK`).

**Настройка профиля** (Settings → Executors → New/Edit):

- Type `claude_cli`, Authentication → **AWS Bedrock**.
- **AWS region** (обязательно), **AWS profile** (пусто = дефолтная цепочка AWS SDK), **CA bundle path** (пусто = без перехвата).
- **Model — полный Bedrock model/inference-profile id**, например `eu.anthropic.claude-opus-4-8`. Голые алиасы («opus», «sonnet») в bedrock-режиме НЕ работают: они резолвятся через `ANTHROPIC_DEFAULT_*_MODEL`, которые в прогон сознательно не передаются.

**Как это работает.** Значения из профиля (не из шелла!) инжектируются в env спауна ПОСЛЕ allowlist-прохода: `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION`, `AWS_PROFILE`/`NODE_EXTRA_CA_CERTS` (если заданы). AWS-креды (access/secret/session) НИКОГДА не хранятся в BRIGADIR и не попадают в env — CLI сам читает `~/.aws` через allowlist'нутый `HOME` (та же модель, что у подписки `~/.claude`). Хост-переменные `AWS_*`/`ANTHROPIC_*` по-прежнему отрезаются by construction.

**Обратная совместимость.** У старых профилей поля `auth` нет: с сохранённым API-ключом ведут себя как `api_key`, без — как `host_subscription` (правило дефолта — `resolveEffectiveAuth`, ответы API всегда несут эффективный режим). Переключение режима с `api_key` НЕ стирает сохранённый ключ (лежит инертно, вернуться можно без повторного ввода); удаление — только явным Clear.

Портируемость: коллега на своей машине со своим `~/.aws`-профилем и своим CA-бандлом заводит СВОЙ executor-профиль в дашборде — и прогоны работают без единого изменения в коде или шелле.

## 5. Тесты

```bash
pnpm typecheck && pnpm lint && pnpm test   # статика + юниты + веб (без Docker; vue-tsc и веб-тесты входят)
pnpm test:integration                       # testcontainers: нужен Docker, ~15-20 сек
```

Веб-проверки входят в корневые `typecheck`/`test` и сами собирают
`@brigadir/contracts` первым шагом (bare-импорт `@brigadir/contracts` в вебе
резолвится в собранный `dist` пакета, который в gitignore — без сборки свежий
чекаут падал с десятками фантомных ошибок типов). Отдельно веб можно гонять
как раньше: `pnpm --filter @brigadir/web test`.

## 6. Частые грабли

| Симптом | Причина |
|---|---|
| Бут падает с ошибкой про `BRIGADIR_*` | Не задан один из трёх секретов, либо `CREDENTIALS_KEY` не 32 байта. Это fail-fast by design, не чините «дефолтом» |
| `401` на все `/api/*` | Неверный bearer в token gate — сверьте с `BRIGADIR_DASHBOARD_TOKEN` |
| Правки agents.yaml «не применяются» | Так и задумано: БД — источник правды, yaml импортируется один раз. Правьте через UI |
| В compose «не видит» agents.yaml после правки | Файл в образе: `docker compose up --build` |
| Тикет не подхватывается | Скоуп: scrum-борда без активного спринта = пустой скоуп; проверьте scope_jql и что статус тикета точно равен trigger_status |
| `ECONNREFUSED` к Postgres/Redis | `docker compose up -d postgres redis` не сделан, либо порты заняты |
| `role "brigadir" does not exist` | Вы попали в НЕ наш Postgres (обычно brew на 5432). Проверьте, что `DATABASE_URL` в `.env` указывает на **5434** и контейнеры пересозданы после смены портов (`docker compose up -d postgres redis`) |
