# Auth & Multi-tenancy — дизайн модуля

> **Статус: дизайн зафиксирован, имплементация НЕ начата** (обсуждение 2026-07-17).
> Модуль сознательно вырезан из внутреннего режима ([plan-internal.md](plan-internal.md), реш. 2026-07-10) и соответствует Phase 3 «Users/orgs/roles» из [roadmap.md](roadmap.md). Этот документ — детализация и источник правды по дизайну на момент, когда к модулю вернёмся. Открытые вопросы — в §8.

## 1. Мотивация и рамки

Сейчас BRIGADIR — single-operator система: один общий bearer-токен на весь дашборд, понятия пользователя нет. Цель модуля — изолировать workspaces разных пользователей и команд:

- **Tenant** — граница видимости. Пользователи из разных tenants не видят ни друг друга, ни чужие workspaces.
- Внутри tenant — роли **ADMIN** (видит и управляет всеми workspaces tenant'а) и **USER** (видит и управляет только созданными им самим).
- USER может пригласить (share) другого пользователя своего tenant'а в свой workspace; ADMIN — любого в любой workspace tenant'а.

Вне рамок этого дизайна (остаётся в Phase 3/4 roadmap): Jira OAuth 3LO, BYOK-ключи per workspace, песочницы, self-hosted runner, per-tenant rate budgets, биллинг, audit log.

## 2. Текущее состояние (as-is, на 2026-07-17)

Ни одной таблицы с user/owner/tenant в схеме нет. Три плоскости аутентификации, все на симметричных секретах, ни одна не идентифицирует человека:

| Плоскость | Секрет | Что идентифицирует |
|---|---|---|
| Оператор → dashboard API | статический bearer `BRIGADIR_DASHBOARD_TOKEN` | никого (один общий токен) |
| Агент внутри прогона → callback API | per-run HS256 JWT (`sub=runId`, `wsp=workspaceId`), секрет `BRIGADIR_JWT_SECRET` | прогон, не человека |
| Секреты at rest | `BRIGADIR_CREDENTIALS_KEY` (AES-256-GCM) | — |

Ключевые факты, влияющие на дизайн:

- `DashboardTokenGuard` (`libs/app-config/src/dashboard-token.guard.ts`) навешан **per-controller**, не глобально; существует **вторая копия** guard'а и provider'а в `apps/backend/src/dashboard/` — при рефакторинге auth консолидировать.
- Фронт: логина нет, «token gate» в `apps/web/src/App.vue`, токен в sessionStorage (`apps/web/src/api/token.ts`), подставляется fetch-клиентом (`apps/web/src/api/client.ts`).
- **`workspaces` — уже фактический корень изоляции**: почти все таблицы (agents, tickets, runs, human_tasks, webhook_events) несут `workspace_id` FK. Owner-колонки нет нигде.
- **`executors` — платформенные**: `workspace_id` у них сознательно убран в миграции 0003. `global_settings` — тоже платформенная.
- Jira-креды — **per-workspace в БД** (`workspaces.jira_credentials`, bytea, шифрование), НЕ глобальные. Глобальные env-креды `BRIGADIR_JIRA_EMAIL`/`BRIGADIR_JIRA_API_TOKEN` использует только admin-mcp при бутстрапе workspace.
- Ingest — **поллер, не вебхук**: `ReconcileService` (`libs/ingest/src/reconcile.service.ts`) итерирует все enabled-workspaces напрямую из БД, для каждого берёт его Jira-клиент. Никакой HTTP-аутентификации на этом пути нет — trusted in-process worker.
- Callback-канал (`RunTokenGuard`, `libs/callback/src/run-token.guard.ts`): проверяет per-run JWT + ре-читает статус run из БД; workspace резолвится из строки run, не из токена. Уже фактически tenant-безопасен.
- `admin-mcp` (`packages/admin-mcp`) — stdio MCP, тонкий HTTP-клиент дашборд-API на том же статическом токене.
- Единственный след человека в БД — `human_tasks.resolved_by`, **free-text строка** (не FK).

## 3. Принятые решения

### 3.1. Tenant-модель: user глобален, membership — многие-ко-многим

Пользователь **может состоять в нескольких tenants** и переключаться между ними (один аккаунт — несколько команд; гибкость закладываем сразу, чтобы не переделывать). Создание tenant — **self-service**: любой пользователь создаёт tenant и автоматически становится его ADMIN. Отдельный «супер-админ платформы» для создания tenants не нужен.

### 3.2. Роли — два уровня

**Уровень tenant** (`tenant_members.role`):

- `ADMIN` — управляет всеми workspaces tenant'а, членами tenant'а, executors; приглашает кого угодно куда угодно.
- `USER` — создаёт свои workspaces и является их полноправным «workspace-админом»; чужие workspaces не видит, пока его не пригласили.

**Уровень workspace** (`workspace_members.role`, только для приглашённых):

- `viewer` — роль по умолчанию при приглашении; смотрит workspace, агентов, прогоны, отчёты; ничего не меняет.
- `admin` — назначается явно; редактирует workspace/агентов наравне с owner'ом.

Доступ tenant-ADMIN и owner'а (`workspaces.created_by`) — **implicit**, без строк в `workspace_members`. Это убирает классы багов «админа забыли добавить в новый workspace» и «owner удалил сам себя». Явные строки — только у приглашённых.

Матрица прав:

| Действие | Tenant ADMIN | Tenant USER (owner ws) | WS admin (приглашён) | WS viewer |
|---|---|---|---|---|
| Управлять членами tenant, executors | ✅ | ❌ | ❌ | ❌ |
| Создать workspace | ✅ | ✅ | — | — |
| Редактировать workspace/агентов, retry/cancel прогонов | ✅ (все) | ✅ (свои) | ✅ | ❌ |
| Приглашать в workspace | ✅ (в любой) | ✅ (в свой) | ❓ §8.2 | ❌ |
| Смотреть runs, отчёты, таймлайн | ✅ | ✅ | ✅ | ✅ |
| Резолвить human tasks | ✅ | ✅ | ✅ | ❓ §8.3 |

Правило доступа к workspace — одна функция:

```
canAccess(user, ws) =
  membership(user, ws.tenant_id) существует
  AND ( role == ADMIN
        OR ws.created_by == user.id
        OR ∃ workspace_members(ws.id, user.id) )
```

### 3.3. Аутентификация — внешний провайдер, роли — только у нас

Аутентификацию (кто это?) отдаём **внешнему провайдеру**; авторизация (что ему можно?) целиком живёт в нашем Postgres. Провайдер выдаёт JWT, бэкенд валидирует и по стабильному `sub` находит/создаёт строку в `users` (JIT-провижининг при первом логине). **Роли и членства в custom claims провайдера не дублировать** — два источника правды разъедутся.

**Выбор провайдера ограничен требованием §3.6 (remote MCP)**: провайдер должен уметь работать полноценным OAuth 2.1 authorization server для сторонних клиентов (PKCE, discovery-метаданные, dynamic client registration) — именно так Claude Code / Claude.ai подключаются к remote MCP и показывают окно логина.

- **Firebase Auth — отклонён**: отлично логинит своё приложение, но не является authorization server'ом (нет DCR, consent-флоу, кастомных scopes) — OAuth-прослойку для MCP пришлось бы писать самим.
- **WorkOS AuthKit — основной кандидат**: бесплатно до 1M MAU, прицельная поддержка сценария «AS для MCP-сервера», встроенные invites.
- **Auth0 — запасной**: полноценный OIDC/OAuth AS с DCR, бесплатный тир ~25k MAU, зрелый.
- Keycloak self-hosted — всё умеет, но +один сервис на своём плече; держим как fallback, если внешние SaaS не подойдут.

Итоговый выбор WorkOS vs Auth0 — открыт (§8.1), решать руками на прототипе.

### 3.4. Executors — per tenant

Возвращаем executors в tenant-скоуп (`executors.tenant_id`) — осознанный откат решения миграции 0003. Причина: executor несёт зашифрованный API-ключ и `max_parallel_runs`; общий ключ на все tenants = смешанный биллинг и общий лимит параллельности. Управляют executors только tenant-ADMIN'ы; USER видит список (нужен при создании агентов), но не редактирует.

### 3.5. Enforcement — глобальный guard + один обязательный хелпер доступа

Enforcement — это ответ на вопрос «в каком месте кода проверяется, что пользователю можно видеть эти данные, и что гарантирует, что ни один эндпоинт не забыл проверку». Провайдер этим не занимается. Два механизма:

1. **Глобальный `APP_GUARD`** (вместо нынешних per-controller): валидирует JWT провайдера, кладёт `{userId}` в request context. Требуемые роли объявляются декораторами на эндпоинтах. Заодно консолидируется дубликат `DashboardTokenGuard`.
2. **Конвенция «доступ к workspace — только через один хелпер»**: единая функция вида `resolveWorkspaceAccess(userId, workspaceId) → {tenantId, effectiveRole}`, через которую обязан проходить каждый workspace-scoped эндпоинт; list-запросы строятся только от membership-набора пользователя. Самодельные `WHERE workspace_id = ...` без хелпера запрещены — по аналогии с уже канонизированными `parsePagination`/`makePaginatedResponseSchema` и запретом самодельных `el-pagination`. Забытый фильтр — не неудобство, а межтенантная утечка, поэтому правило механическое. После имплементации — кандидат в «выстраданные правила» CLAUDE.md.

Postgres RLS рассматривали и **отложили**: с Drizzle и одним пулом соединений это заметная сложность, app-layer-конвенции для нашего масштаба достаточно.

**Активный tenant** на сервере не храним. Для эндпоинтов конкретного ресурса (`/api/workspaces/:id`, runs, agents, human-tasks) tenant выводится из ресурса + проверяется членство. Заголовок `X-Tenant-Id` нужен только спискам и созданию (`GET/POST /api/workspaces`, executors). Переключатель tenant'а — чисто фронтовая механика.

### 3.6. Remote MCP вместо stdio admin-mcp

Целевое состояние: admin-плоскость — **HTTP-stream MCP** на `mcp.brigadir.com/mcp` с авторизацией по MCP-спецификации (OAuth 2.1 + PKCE, discovery, DCR): пользователь подключает сервер в Claude Code/claude.ai и логинится через то же окно провайдера, что и на `brigadir.com/login`. Токен MCP-сессии идентифицирует пользователя (не tenant) — tenant-контекст передаётся явным параметром тулз (`list_workspaces(tenant_id?)`, без параметра — всё доступное пользователю).

До этой итерации stdio `admin-mcp` живёт на временном **per-user PAT** (персональный API-ключ вместо общего `BRIGADIR_DASHBOARD_TOKEN`), чтобы бэкенд знал user/tenant при `create_workspace`.

### 3.7. Инвайты — два разных механизма

1. **Share workspace существующему члену tenant'а** — мгновенный insert в `workspace_members`, без email-флоу.
2. **Приглашение нового человека в tenant** — через провайдера: ADMIN добавляет по email → пользователь получает ссылку, при первом входе задаёт пароль (по сути reset-password/invite-флоу провайдера; у WorkOS invites встроены, у Auth0 — паттерн через change-password ticket). Наш бэкенд при accept'е создаёт строку `tenant_members`.

### 3.8. Что НЕ меняется

- **Poller/worker** (`ReconcileService`, run-процессоры): trusted in-process, действуют «от имени workspace», tenant наследуют транзитивно через `workspace.tenant_id`. Не трогаем.
- **Callback-канал** (per-run JWT + `RunTokenGuard`): уже привязан к run/workspace, ре-читает состояние из БД. Не трогаем.
- **Jira-креды per-workspace** — остаются как есть.

## 4. Целевая схема данных

```
users             (id uuid PK, provider_uid text UNIQUE, email text UNIQUE, name text, created_at)
tenants           (id uuid PK, name text, created_at)
tenant_members    (tenant_id FK→tenants CASCADE, user_id FK→users CASCADE,
                   role enum('ADMIN','USER'), created_at, PK (tenant_id, user_id))
workspace_members (workspace_id FK→workspaces CASCADE, user_id FK→users CASCADE,
                   role enum('admin','viewer'), created_at, PK (workspace_id, user_id))

workspaces  + tenant_id uuid NOT NULL FK→tenants
            + created_by uuid NULL FK→users        -- NULL = «системный» (до-миграционный)
executors   + tenant_id uuid NOT NULL FK→tenants   -- откат 0003
human_tasks : resolved_by text → resolved_by uuid NULL FK→users
```

По правилу 5 CLAUDE.md: перед имплементацией эти изменения вносятся в `docs/architecture.md` §3, миграции коммитятся с ревью SQL против §3.

## 5. Миграция существующих данных

1. Создать default tenant; все существующие workspaces и executors → `tenant_id = default`.
2. Существующие операторы получают учётки в провайдере → строки `users` → `tenant_members(default, ADMIN)`.
3. Старые workspaces: `created_by = NULL` → видны только ADMIN'ам (что совпадает с текущим кругом доступа).
4. `human_tasks.resolved_by`: старые free-text значения не мапим (оставить NULL или legacy-колонку), новые резолвы пишут FK.
5. `BRIGADIR_DASHBOARD_TOKEN` умирает после итерации 1; на переходный период admin-mcp — на PAT (§3.6).

## 6. Нарезка итераций

1. **Провайдер + users + JIT-провижининг + сессии на фронте.** Всё в одном default tenant, все — ADMIN; функционально ничего не меняется, но статический токен умирает. Попутно: консолидация дубликата `DashboardTokenGuard`, `resolved_by` → FK. Token gate во фронте превращается в страницу логина провайдера.
2. **Tenants + membership + enforcement.** `tenant_id` на workspaces/executors, глобальный guard, `resolveWorkspaceAccess`, фильтрация всех списков, `X-Tenant-Id`, переключатель tenant'а в UI, self-service создание tenant.
3. **Workspace sharing.** `workspace_members` (admin/viewer) + UI управления доступом на workspace.
4. **Invites в tenant** через провайдера (§3.7.2) + PAT для stdio admin-mcp.
5. **Remote MCP** (§3.6): HTTP-stream транспорт, OAuth-обвязка, деплой на поддомен. Осознанно последним — самостоятельный кусок работы, до него admin-mcp живёт на PAT.

Правило 4 CLAUDE.md действует: каждая итерация — с тестами в ней же; для enforcement — обязательные негативные интеграционные тесты (пользователь tenant A запрашивает ресурс tenant B по прямому id → 404/403).

## 7. Как это стыкуется с roadmap Phase 3

Этот дизайн закрывает пункт «Users/orgs/roles, SSO» Phase 3. Остальное из Phase 3 (Jira 3LO, BYOK per workspace, песочницы, runner, per-tenant rate budgets) — поверх этой модели, отдельными работами. DoD Phase 3 «две организации на одном инстансе не влияют друг на друга» в части видимости данных обеспечивается §3.5; в части нагрузки/лимитов — нет (это rate budgets, вне рамок).

## 8. Открытые вопросы

1. **WorkOS AuthKit vs Auth0** — финальный выбор. Критерии: качество MCP-OAuth-сценария из коробки, invites, цена на нашем масштабе, DX. Решать прототипом (~полдня на обоих). Склонность — WorkOS (бесплатный потолок + прицельная MCP-поддержка).
2. **Может ли приглашённый ws-admin приглашать дальше?** Склонность — да (иначе owner — бутылочное горлышко), но не решено.
3. **Может ли viewer резолвить human tasks?** Склонность — нет (резолв меняет ход прогона, это write), но не решено.
4. **Судьба `global_settings`** (платформенные настройки, включая инструкции brigadir-агента): остаются платформенными без UI-доступа tenant-пользователей, или переезжают per-tenant? Пока склонность — оставить платформенными, редактирование только через прямой доступ оператора инстанса; вернуться к вопросу при итерации 2.
5. **Терминология в UI**: tenant vs organization vs team (в БД — `tenants`; как называть пользователю — вопрос продукта).
6. **Детали tenant-контекста в remote MCP**: явный параметр тулз (текущая склонность) vs выбор tenant на consent-экране — уточнить, когда дойдём до итерации 5 и посмотрим на реальный UX в Claude-клиентах.
7. **Лимиты self-service создания tenants** (анти-мусор): нужен ли cap на количество tenants на пользователя. Для internal-режима — нет; вернуться при открытии наружу.
