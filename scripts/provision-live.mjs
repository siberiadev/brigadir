#!/usr/bin/env node
/**
 * Live-smoke operator helper (T070). Run AFTER the backend has booted once and
 * seeded the workspace from agents.yaml. Does two things:
 *
 *   1. Overwrites the seeded placeholder `jira_credentials` blob with the real
 *      one (plain UTF-8 JSON — the same bytes encodeJiraCredentials produces;
 *      encryption is a later iteration per research D2).
 *   2. Enqueues one immediate reconcile job so you don't wait for the 5-minute
 *      scheduler tick.
 *
 * Usage:
 *   DATABASE_URL=postgres://... REDIS_URL=redis://... \
 *   JIRA_EMAIL=you@org.com JIRA_API_TOKEN=... \
 *   node scripts/provision-live.mjs [PROJECT_KEY]
 *
 * PROJECT_KEY is optional when there is exactly one workspace.
 */
import pg from 'pg';
import { Queue } from 'bullmq';

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env ${name}`);
    process.exit(1);
  }
  return v;
}

const databaseUrl = need('DATABASE_URL');
const redisUrl = need('REDIS_URL');
const email = need('JIRA_EMAIL');
const apiToken = need('JIRA_API_TOKEN');
const projectKey = process.argv[2];

const db = new pg.Client({ connectionString: databaseUrl });
await db.connect();

const where = projectKey ? 'WHERE jira_project_key = $2' : '';
const params = [JSON.stringify({ email, api_token: apiToken })];
if (projectKey) params.push(projectKey);
const res = await db.query(
  `UPDATE workspaces SET jira_credentials = convert_to($1, 'UTF8') ${where}
   RETURNING id, jira_project_key`,
  params,
);
await db.end();

if (res.rowCount === 0) {
  console.error(
    projectKey
      ? `No workspace with jira_project_key = ${projectKey}. Boot the backend once so ConfigSeeder creates it.`
      : 'No workspaces found. Boot the backend once so ConfigSeeder creates it.',
  );
  process.exit(1);
}
if (res.rowCount > 1) {
  console.error('More than one workspace matched — pass PROJECT_KEY explicitly.');
  process.exit(1);
}
console.log(`Credentials written for workspace ${res.rows[0].jira_project_key} (${res.rows[0].id}).`);

const u = new URL(redisUrl);
const queue = new Queue('reconcile', {
  connection: {
    host: u.hostname,
    port: Number(u.port) || 6379,
    password: u.password || undefined,
    db: Number(u.pathname.replace(/^\//, '')) || 0,
    maxRetriesPerRequest: null,
  },
});
await queue.add('reconcile-now', {});
await queue.close();
console.log('Immediate reconcile enqueued. Move a ticket into the trigger status and watch the worker log.');
