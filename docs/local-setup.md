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

## 5. Тесты

```bash
pnpm typecheck && pnpm lint && pnpm test   # статика + юниты (быстро, без Docker)
pnpm test:integration                       # testcontainers: нужен Docker, ~15-20 сек
pnpm --filter @brigadir/web test            # компонентные тесты дашборда
```

## 6. Частые грабли

| Симптом | Причина |
|---|---|
| Бут падает с ошибкой про `BRIGADIR_*` | Не задан один из трёх секретов, либо `CREDENTIALS_KEY` не 32 байта. Это fail-fast by design, не чините «дефолтом» |
| `401` на все `/api/*` | Неверный bearer в token gate — сверьте с `BRIGADIR_DASHBOARD_TOKEN` |
| Правки agents.yaml «не применяются» | Так и задумано: БД — источник правды, yaml импортируется один раз. Правьте через UI |
| В compose «не видит» agents.yaml после правки | Файл в образе: `docker compose up --build` |
| Тикет не подхватывается | Скоуп: scrum-борда без активного спринта = пустой скоуп; проверьте scope_jql и что статус тикета точно равен trigger_status |
| `ECONNREFUSED` к Postgres/Redis | `docker compose up -d postgres redis` не сделан, либо порты 5432/6379 заняты локальными сервисами |
