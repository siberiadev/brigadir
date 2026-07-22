#!/usr/bin/env node
/**
 * One-off backfill: reprice historical deepseek_api runs at DeepSeek rates.
 *
 * Runs recorded before libs/executors/src/claude-cli/provider-pricing.ts
 * carry the CLI's total_cost_usd — priced against ANTHROPIC's list, ~30× the
 * real DeepSeek bill. This script recomputes runs.cost_usd from the persisted
 * runs.usage token counts using the SAME price table as provider-pricing.ts
 * (kept in sync by hand — this is a one-off, not a shared module).
 *
 *   node --env-file=.env scripts/backfill-deepseek-cost.mjs           # dry-run
 *   node --env-file=.env scripts/backfill-deepseek-cost.mjs --apply   # write
 *
 * The run's model is not a runs column — it is read from the run's own
 * `log` run_event (payload.model, written at spawn). Runs whose model cannot
 * be resolved or is missing from the price table are listed and left
 * untouched, never guessed.
 */

import pg from 'pg';

// Prices: https://api-docs.deepseek.com/quick_start/pricing/ (2026-07-22).
// Mirror of PROVIDER_MODEL_PRICING['deepseek_api'] in provider-pricing.ts.
const PRICING_USD_PER_MTOK = {
  'deepseek-v4-pro': { inputCacheMiss: 0.435, inputCacheHit: 0.003625, output: 0.87 },
  'deepseek-v4-flash': { inputCacheMiss: 0.14, inputCacheHit: 0.0028, output: 0.28 },
};

const apply = process.argv.includes('--apply');

function tokens(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function computeCostUsd(pricing, usage) {
  const miss = tokens(usage.input_tokens) + tokens(usage.cache_creation_input_tokens);
  const hit = tokens(usage.cache_read_input_tokens);
  const out = tokens(usage.output_tokens);
  if (miss + hit + out === 0) return undefined;
  const cost =
    (miss * pricing.inputCacheMiss + hit * pricing.inputCacheHit + out * pricing.output) / 1e6;
  // runs.cost_usd is numeric(10,4) — round to what the column can hold.
  return Math.round(cost * 1e4) / 1e4;
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set — run with: node --env-file=.env scripts/...');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  // One log event per run carries payload.model (written at spawn); pick the
  // earliest defensively should a run ever have several.
  const { rows } = await client.query(`
    SELECT r.id, r.cost_usd, r.usage,
           (SELECT e.payload->>'model' FROM run_events e
             WHERE e.run_id = r.id AND e.type = 'log' AND e.payload ? 'model'
             ORDER BY e.created_at ASC LIMIT 1) AS model
      FROM runs r
     WHERE r.executor_type = 'deepseek_api' AND r.usage IS NOT NULL
     ORDER BY r.created_at ASC
  `);

  let updated = 0;
  let oldTotal = 0;
  let newTotal = 0;
  const skipped = [];

  for (const row of rows) {
    const model = (row.model ?? '').trim().toLowerCase();
    const pricing = PRICING_USD_PER_MTOK[model];
    const usage = typeof row.usage === 'object' && row.usage !== null ? row.usage : {};
    const cost = pricing ? computeCostUsd(pricing, usage) : undefined;
    if (cost === undefined) {
      skipped.push({ id: row.id, model: row.model ?? '(no model log event)' });
      continue;
    }
    const before = row.cost_usd === null ? null : Number(row.cost_usd);
    oldTotal += before ?? 0;
    newTotal += cost;
    console.log(
      `${row.id}  ${model}  $${before?.toFixed(4) ?? '—'} → $${cost.toFixed(4)}${apply ? '' : '  (dry-run)'}`,
    );
    if (apply) {
      await client.query('UPDATE runs SET cost_usd = $1 WHERE id = $2', [String(cost), row.id]);
    }
    updated += 1;
  }

  for (const s of skipped) console.log(`SKIPPED ${s.id} — unpriceable model: ${s.model}`);
  console.log(
    `\n${apply ? 'Updated' : 'Would update'} ${updated} run(s), skipped ${skipped.length}.` +
      ` Totals: $${oldTotal.toFixed(4)} → $${newTotal.toFixed(4)}.` +
      (apply ? '' : ' Re-run with --apply to write.'),
  );
} finally {
  await client.end();
}
