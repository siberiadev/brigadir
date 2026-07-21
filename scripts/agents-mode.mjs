#!/usr/bin/env node
/**
 * Стабильный режим для агент-прогонов (feature 027, US1 / FR-001…FR-003).
 *
 * Вторая native non-watch пара backend+worker из собранных бандлов на
 * выделенном порту: callback-цель агентов больше не зависит от того, что
 * человек делает в редакторе с dev-стеком на :3000. Одна команда входа и
 * выхода; никаких внешних зависимостей (plain Node ≥ 22, --env-file).
 *
 *   pnpm agents:start   — собрать и поднять пару (pidfiles/логи в .agents-mode/)
 *   pnpm agents:stop    — SIGTERM: worker дренится (лок отдаётся ПОСЛЕ дренажа), затем backend
 *   pnpm agents:status  — живость процессов + health-проверки на agents-порту
 *
 * Эксклюзивность потребления очередей гарантирует worker-lock
 * (apps/worker/src/worker-lock.service.ts), не этот скрипт: забытый dev-worker
 * не сможет молча красть джобы — стабильный worker будет громко ждать лок.
 * Документация: docs/local-setup.md §2a.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STATE_DIR = join(ROOT, '.agents-mode');
const ENV_FILE = join(ROOT, '.env');

const DEFAULT_AGENTS_PORT = 3210;
const WORKER_DRAIN_TIMEOUT_MS = 40_000; // compose stop_grace_period 35s + slack

const PROCS = [
  {
    name: 'backend',
    entry: join('dist', 'apps', 'backend', 'main.api.js'),
    pidFile: join(STATE_DIR, 'backend.pid'),
    logFile: join(STATE_DIR, 'backend.log'),
  },
  {
    name: 'worker',
    entry: join('dist', 'apps', 'worker', 'main.worker.js'),
    pidFile: join(STATE_DIR, 'worker.pid'),
    logFile: join(STATE_DIR, 'worker.log'),
  },
];

function agentsPort() {
  if (process.env.BRIGADIR_AGENTS_PORT) return Number(process.env.BRIGADIR_AGENTS_PORT);
  if (existsSync(ENV_FILE)) {
    const m = readFileSync(ENV_FILE, 'utf8').match(/^BRIGADIR_AGENTS_PORT=(\d+)\s*$/m);
    if (m) return Number(m[1]);
  }
  return DEFAULT_AGENTS_PORT;
}

function readPid(pidFile) {
  try {
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchStatus(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return `${res.status}`;
  } catch (err) {
    return `unreachable (${err?.cause?.code ?? err?.name ?? 'error'})`;
  }
}

function run(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`\n[agents-mode] build step failed: ${cmd} ${args.join(' ')}`);
    process.exit(res.status ?? 1);
  }
}

function requireEnvFile() {
  if (!existsSync(ENV_FILE)) {
    console.error(
      '[agents-mode] .env not found at repo root — see docs/local-setup.md §1 (secrets are boot-required)',
    );
    process.exit(1);
  }
}

async function start() {
  requireEnvFile();
  for (const proc of PROCS) {
    const pid = readPid(proc.pidFile);
    if (pid && pidAlive(pid)) {
      console.error(
        `[agents-mode] ${proc.name} is already running (pid ${pid}) — use \`pnpm agents:status\` / \`pnpm agents:stop\``,
      );
      process.exit(1);
    }
  }

  const port = agentsPort();
  console.log(`[agents-mode] building bundles (contracts → mcp-server → backend → worker)…`);
  run('pnpm', ['--filter', '@brigadir/contracts', 'build']);
  run('pnpm', ['build:mcp-server']);
  run('pnpm', ['build:backend']);
  run('pnpm', ['build:worker']);

  mkdirSync(STATE_DIR, { recursive: true });

  const extraEnv = {
    backend: { PORT: String(port) },
    worker: {
      BRIGADIR_CALLBACK_BASE_URL: `http://127.0.0.1:${port}/api/callbacks`,
      BRIGADIR_WORKER_MODE: 'agents',
    },
  };

  for (const proc of PROCS) {
    const logFd = openSync(proc.logFile, 'a');
    // cwd = repo root: deployment guard и resolveMcpServerEntryPath резолвят
    // packages/mcp-server/* от cwd (FR-005 — идентично dev-режиму).
    const child = spawn('node', ['--env-file=.env', proc.entry], {
      cwd: ROOT,
      env: { ...process.env, ...extraEnv[proc.name] },
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    writeFileSync(proc.pidFile, `${child.pid}\n`);
    console.log(`[agents-mode] ${proc.name} started (pid ${child.pid}, log ${proc.logFile})`);

    if (proc.name === 'backend') {
      const healthUrl = `http://127.0.0.1:${port}/health`;
      let ok = false;
      for (let i = 0; i < 30; i++) {
        await sleep(1_000);
        if (!pidAlive(child.pid)) break;
        if ((await fetchStatus(healthUrl)) === '200') {
          ok = true;
          break;
        }
      }
      if (!ok) {
        console.error(
          `[agents-mode] backend did not become healthy on ${healthUrl} — check ${proc.logFile} (postgres/redis up? \`docker compose up -d postgres redis\`)`,
        );
        await stop();
        process.exit(1);
      }
      console.log(`[agents-mode] backend healthy on :${port}`);
    }
  }

  console.log(
    `[agents-mode] stable pair is up. Callbacks target http://127.0.0.1:${port}/api/callbacks.\n` +
      `[agents-mode] if a dev worker is still alive, the agents worker will WAIT for the worker-lock — check ${join(STATE_DIR, 'worker.log')}`,
  );
}

async function stopProc(proc, timeoutMs) {
  const pid = readPid(proc.pidFile);
  if (!pid || !pidAlive(pid)) {
    rmSync(proc.pidFile, { force: true });
    console.log(`[agents-mode] ${proc.name}: not running`);
    return;
  }
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && pidAlive(pid)) {
    await sleep(250);
  }
  if (pidAlive(pid)) {
    console.error(
      `[agents-mode] ${proc.name} (pid ${pid}) did not exit in ${timeoutMs}ms — leaving it running (in-flight runs drain first by design; retry \`pnpm agents:stop\` later)`,
    );
    return;
  }
  rmSync(proc.pidFile, { force: true });
  console.log(`[agents-mode] ${proc.name}: stopped`);
}

async function stop() {
  // Worker первым: дренаж in-flight прогонов + release worker-lock'а, затем
  // backend (callback-цель живёт, пока дренятся прогоны).
  await stopProc(PROCS[1], WORKER_DRAIN_TIMEOUT_MS);
  await stopProc(PROCS[0], 10_000);
}

async function status() {
  const port = agentsPort();
  let exitCode = 0;
  for (const proc of PROCS) {
    const pid = readPid(proc.pidFile);
    const alive = pid !== null && pidAlive(pid);
    if (!alive) exitCode = 1;
    console.log(`[agents-mode] ${proc.name}: ${alive ? `running (pid ${pid})` : 'NOT running'}`);
  }
  console.log(
    `[agents-mode] GET http://127.0.0.1:${port}/health → ${await fetchStatus(`http://127.0.0.1:${port}/health`)}`,
  );
  console.log(
    `[agents-mode] GET http://127.0.0.1:${port}/api/callbacks/health → ${await fetchStatus(`http://127.0.0.1:${port}/api/callbacks/health`)}`,
  );
  console.log(
    `[agents-mode] worker-lock state: see ${join(STATE_DIR, 'worker.log')} (последняя строка про worker-lock)`,
  );
  process.exit(exitCode);
}

const cmd = process.argv[2];
if (cmd === 'start') await start();
else if (cmd === 'stop') await stop();
else if (cmd === 'status') await status();
else {
  console.error('usage: node scripts/agents-mode.mjs <start|stop|status>');
  process.exit(2);
}
