# Выгрузка по SXF-1174 (для внешнего анализа)

Три файла, все из одной БД (`postgres://brigadir:brigadir@localhost:5434/brigadir`),
снято 2026-07-28 ~11:26 MSK+4. Тикет: `SXF-1174` (`5d4c1cab-7cf5-4219-b9e3-adf1fd6d03f5`),
workspace `b3e0fdc9-0a6a-49ac-968d-d653791fdbfa` «Squad Pulse Team».

| Файл | Что внутри |
|---|---|
| `SXF-1174-dump.json` (615 КБ) | Полный машинный дамп: workspace (+ `settings`), все 5 агентов с инструкциями и статусной моделью, тикет, **11 прогонов** со `trigger_event` / `usage` / `report` / `error` / `run_checks` и **527 `run_events`**, 5 человекозадач тикета + 1 по workspace, сиблинг-тикеты |
| `SXF-1174-timeline.txt` (7.6 КБ) | Сводка глазами: таблица прогонов, профиль типов событий, группировка rework-прогонов по `deciding_run_id`, человекозадачи, ошибки |
| `SXF-1174-events.md` (345 КБ) | Все 527 событий по прогонам в читаемом виде (payload'ы как есть) |

Секретов в выгрузке нет: `jira_credentials`, `env_secrets`, `executors.secrets` и
`agent_instructions_token` не выбирались. `workspace.settings.repositories[].env` содержит
только несекретные значения (хосты/порты/email), как они лежат в БД.

## Что показывает выгрузка (короткий факт-лист)

**Прогонов 11, не 4.** Хронология (`SXF-1174-timeline.txt`):

```
22:31:15 5890636f odin-planner    poll           succeeded   1375.8с $6.5242  jira_action=1
23:19:02 b51c09f1 thor-developer  poll           superseded 37147.8с $2.4820  jira_action=0
09:38:10 acd95115 thor-developer  human-resume   superseded   671.1с $2.3010  jira_action=0
10:03:25 b4d27e5e brigadir        answer-triage  succeeded    262.5с $1.1091  jira_action=0
10:07:48 49f595cf heimdall-qa     rework         cancelled    209.9с $0.5859  ← deciding=b4d27e5e
10:11:35 4e013e29 heimdall-qa     rework         cancelled    118.3с $0.2725  ← deciding=b4d27e5e
11:14:18 8a92fa06 mimir-reviewer  poll           cancelled    721.2с $2.0521
11:14:22 e033adef heimdall-qa     rework         failed       570.3с $1.9844  ← deciding=b4d27e5e
11:24:04 c6d3bd1f heimdall-qa     rework         cancelled    135.5с $0.4022  ← deciding=b4d27e5e
11:26:32 49779be1 mimir-reviewer  poll           cancelled     20.6с $0.1091
11:26:33 7f2bd0cf heimdall-qa     rework         cancelled     19.3с  —       ← deciding=b4d27e5e
```

1. **Одно решение оркестратора породило 5 rework-прогонов.** У всех пяти `trigger_event`
   идентичен: `source=rework`, `deciding_run_id=b4d27e5e`, `target_agent=heimdall-qa`,
   `task` длиной 3969 символов, `human_task_id=153d413d`, `failing_run_id=acd95115`. Такую
   нагрузку формирует только `processOrchestratorDecision`
   (`libs/pipeline/src/pipeline.service.ts:526-538`). Каждый новый появлялся вскоре после того,
   как предыдущий перестал быть активным (отмена/провал) — снималась маска partial unique
   index `runs_one_active`. Суммарно на этих пяти прогонах $3.24 и 1053 с.
2. **Ни один прогон, кроме первого, не имеет `jira_action`-маркера** (колонка `jira_action`
   выше). Пока маркера нет, `DriftRepairService`
   (`libs/ingest/src/drift-repair.service.ts:38-49`) на каждом проходе реконсайла (30 с) снова
   зовёт `pipeline.onRunFinished(runId)`; для оркестраторного прогона это доходит до
   `runTrigger.trigger` и заводит rework заново. `onRunFinished` защищён от повторов **только**
   этим маркером (`pipeline.service.ts:242`).
3. **Перевод статуса, который требовал роутинг, невозможен на борде.**
   `heimdall-qa.status_running = "QA"`; из «In Progress» на борде переходов в «QA» нет.
   `transitionTo` бросает `NoTransitionPath`, а оркестраторная ветка
   (`pipeline.service.ts:435-449`) его **не перехватывает** — в отличие от worker-ветки
   (`pipeline.service.ts:369-383`, там пишется `error{stage:'jira_transition'}`). Отсюда:
   ни маркера, ни `error`-события (у `b4d27e5e` профиль `log 1 / progress 5 / tool_call 10`).
4. **Триггер вызывается до перевода статуса** (`pipeline.service.ts:526` против `:542`) —
   поэтому rework-прогоны стартуют, даже когда перевод падает.
5. **Статусная модель агентов** (из дампа): thor-developer trigger `Ready for Development` /
   running `In Progress` / success `Review`; mimir-reviewer trigger `Review` / success
   `Ready for QA`; heimdall-qa trigger `Ready for QA` / running `QA` / success `QA Done`.
   Тикет сейчас в `Review` — поэтому по `poll` его законно подхватывает mimir-reviewer
   (прогоны `8a92fa06`, `49779be1`), а QA-прогоны идут не по `poll`, а по `rework`, где
   `trigger_status` не проверяется вообще.
6. **`workspace.settings.enabled = false`** на момент выгрузки (`updated_at` 11:26:54), при том
   что rework-прогоны появлялись в 11:14–11:26. Требует проверки: селектор реконсайла
   (`libs/ingest/src/reconcile.service.ts:60`, `settings->>'enabled' is distinct from 'false'`)
   должен был этот workspace пропускать.
7. **`e033adef` упал не по делу задачи**, а на отчёте: `runs.error` =
   `no schema-valid structured_output: expected object, received undefined` — то есть QA-агент
   отработал 570 с / 76 tool_call и не смог сдать отчёт.
8. **Открытая ложная человекозадача** `58c5a567` `[blocker_branch_lost]` (создана 09:52:21,
   `run_id = null`) — ветка `feat/SXF-1172-board-metrics-dedup` жива, tip `d56bcb1`.

Аналитический разбор цепочки (с якорями `file:line` и планом разблокировки) —
`docs/runs/2026-07-28-run-b4d27e5e-brigadir-routing-loop.md`. Он написан до этой выгрузки и
считал QA-прогонов два; корректное число — пять.

## Как воспроизвести выгрузку

Запрос целиком — в истории; ключевая часть: `jsonb_build_object` по `workspaces`/`agents`/
`tickets`/`runs` (+ вложенные `run_checks`, `run_events`)/`human_tasks`, фильтр
`tickets.jira_key='SXF-1174' and workspace_id='b3e0fdc9-...'`. Поля секретов исключены явно.
