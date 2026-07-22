<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import type { RunCardArtifact, RunCheckStatus, RunStatus } from '@brigadir/contracts';
import { ArrowDownUp, CircleDollarSign, Copy, GitBranch, Hash, RotateCcw, Timer, X } from 'lucide-vue-next';
import { useRunCard, useCancelRun, useRetryRun } from '../composables/useRunCard';
import { useNow } from '../composables/useNow';
import BackLink from '../components/BackLink.vue';
import RunStatusTag from '../components/RunStatusTag.vue';
import RunTimeline from '../components/RunTimeline/RunTimeline.vue';
import { presentEvents } from '../components/RunTimeline/presenter';
import { ApiError } from '../api/client';
import { formatDuration } from '../utils/date';
import { formatCost, formatCostUsd } from '../utils/currency';
import { formatTokens } from '../utils/number';
import { pluralize } from '../utils/pluralize';

const props = defineProps<{ id: string }>();

const cardQuery = useRunCard(props.id);
const card = computed(() => cardQuery.data.value);
const run = computed(() => card.value?.run);

// A run is actionable (cancel) only while running; retry only once terminal.
const isRunning = computed(() => run.value?.status === 'running');
const isTerminal = computed(() =>
  (['succeeded', 'failed', 'cancelled', 'timed_out', 'superseded'] as RunStatus[]).includes(
    run.value?.status as RunStatus,
  ),
);

const cancel = useCancelRun(props.id);
const retry = useRetryRun(props.id);

async function onCancel() {
  try {
    const res = await cancel.mutateAsync();
    ElMessage[res.cancelled ? 'success' : 'warning'](
      res.cancelled ? 'Run cancelled.' : 'Run is no longer running — not cancelled.',
    );
  } catch (err) {
    ElMessage.error((err as Error)?.message ?? 'Cancel failed.');
  }
}

async function onRetry() {
  try {
    const res = await retry.mutateAsync();
    ElMessage.success(`Retry enqueued — run ${res.run_id}.`);
  } catch (err) {
    const msg =
      err instanceof ApiError && err.code === 'active_run_exists'
        ? 'An active run already exists for this ticket and agent.'
        : (err as Error)?.message ?? 'Retry failed.';
    ElMessage.error(msg);
  }
}

// Content tabs: live view (report + timeline) | run history.
const activeTab = ref('report');

// Expanded check positions (el-collapse v-model). Reasons are kept out of the
// DOM until expanded so tests/screen-readers see them only when open.
const activeChecks = ref<number[]>([]);

const CHECK_GLYPH: Record<RunCheckStatus, string> = {
  pass: '✅',
  fail: '❌',
  warn: '⚠️',
  skip: '⏭️',
};

// Steps the model made in this session = timeline items after presentation
// (the report_progress tool_call/progress duplicates count as one step).
const stepCount = computed(() => presentEvents(card.value?.events ?? []).length);

// Feature 019: per-repo artifact counts line, e.g. "2 commits, 3 files".
function artifactCounts(a: RunCardArtifact): string {
  const parts: string[] = [];
  if (a.commits_count !== null) parts.push(pluralize(a.commits_count, 'commit'));
  if (a.files_changed !== null) parts.push(pluralize(a.files_changed, 'file'));
  return parts.join(', ');
}

// Executor tag: type + the actual model; session id for the copy button.
// Both live only in the session-init `log` event (the run record has neither).
function logEventField(field: 'model' | 'session_id'): string | null {
  for (const e of card.value?.events ?? []) {
    if (e.type !== 'log') continue;
    const payload = e.payload as Record<string, unknown> | null;
    const value = payload?.[field];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}
const executorModel = computed(() => logEventField('model'));
const sessionId = computed(() => logEventField('session_id'));

async function onCopySessionId() {
  if (!sessionId.value) return;
  try {
    await navigator.clipboard.writeText(sessionId.value);
    ElMessage.success('Session id copied.');
  } catch {
    ElMessage.error('Copy failed — clipboard unavailable.');
  }
}
const executorLabel = computed(() => {
  const type = run.value?.executor_type ?? '';
  return executorModel.value ? `${type} · ${executorModel.value}` : type;
});

// Feature 025: kimi runs report cost priced against Anthropic's list, not
// Moonshot's — the figure is indicative only, so flag it wherever a real
// value shows (a bare "—" needs no caveat).
const costIsIndicative = computed(
  () => run.value?.executor_type === 'kimi' && run.value?.cost_usd != null,
);
const INDICATIVE_COST_TIP =
  'Indicative only — kimi runs are priced against Anthropic’s list, not Moonshot’s.';

// Token counts from the persisted CLI `result.usage`. The meta item is hidden
// entirely when the run carries none (mock runs, pre-usage legacy runs) — no
// bare icon with a "—".
const usageTokens = computed(() => {
  const u = run.value?.usage;
  const input = typeof u?.input_tokens === 'number' ? u.input_tokens : null;
  const output = typeof u?.output_tokens === 'number' ? u.output_tokens : null;
  return input === null && output === null ? null : { input, output };
});
const tokensLabel = computed(() => {
  if (!usageTokens.value) return null;
  const { input, output } = usageTokens.value;
  return `${formatTokens(input) ?? '—'} in / ${formatTokens(output) ?? '—'} out`;
});
// Exact-number breakdown for the tooltip; absent fields are simply omitted.
const tokensTip = computed(() => {
  const u = run.value?.usage;
  if (!u) return '';
  const parts: string[] = [];
  const push = (label: string, value: unknown) => {
    if (typeof value === 'number') parts.push(`${label} ${value.toLocaleString('en-US')}`);
  };
  push('Input', u.input_tokens);
  push('Output', u.output_tokens);
  push('Cache read', u.cache_read_input_tokens);
  push('Cache creation', u.cache_creation_input_tokens);
  return parts.join(' · ');
});

// Live Duration while running: tick from `started_at` every second; otherwise
// the server-computed `duration_ms` (same rule as the Runs table).
const now = useNow();
const liveDuration = computed(() => {
  if (run.value?.status === 'running' && run.value.started_at) {
    return formatDuration(Math.max(0, now.value.getTime() - Date.parse(run.value.started_at)));
  }
  return formatDuration(run.value?.duration_ms ?? null);
});
</script>

<template>
  <section v-if="card && run" class="run-card">
    <BackLink :to="`/workspaces/${run.workspace_id}/runs`" label="Runs" class="back" />
    <!-- Header: ticket + status + cancel on ONE line; run meta below -->
    <div class="header-row">
      <h2 class="title" data-test="ticket-key">
        <!-- feature 011: ticketless workspace-setup runs get a label, no link. -->
        <template v-if="card.ticket">
          <a :href="card.ticket.jira_url" target="_blank" rel="noopener">{{ card.ticket.key }}</a>
          <span class="summary">{{ card.ticket.summary ?? '(no summary)' }}</span>
        </template>
        <template v-else>
          <span data-test="setup-label">Workspace setup</span>
        </template>
      </h2>
      <div class="header-actions">
        <RunStatusTag :status="run.status" />
        <el-button
          v-if="sessionId"
          plain
          size="small"
          aria-label="Copy session id"
          :title="`Copy session id ${sessionId}`"
          data-test="copy-session-id"
          @click="onCopySessionId"
        >
          <Copy :size="12" />
          <span class="btn-label">Copy session id</span>
        </el-button>
        <el-button
          v-if="isRunning"
          type="danger"
          plain
          size="small"
          aria-label="Cancel run"
          title="Cancel run"
          data-test="cancel-run"
          :loading="cancel.isPending.value"
          @click="onCancel"
        >
          <X :size="12" />
          <span class="btn-label">Cancel</span>
        </el-button>
        <el-button
          v-if="isTerminal"
          type="primary"
          plain
          size="small"
          aria-label="Retry run"
          title="Retry run"
          data-test="retry-run"
          :loading="retry.isPending.value"
          @click="onRetry"
        >
          <RotateCcw :size="12" />
        </el-button>
      </div>
    </div>
    <div class="sub muted">
      <el-tag type="success" size="small" data-test="agent-tag">{{ run.agent.name }}</el-tag>
      <el-tag type="primary" size="small" data-test="executor-tag">{{ executorLabel }}</el-tag>
      <!-- Meta items: STATIC lucide icon + value (icons replace the text
           labels; the CircleDollarSign glyph carries the "$", so the value is
           bare). No hover animation — that's sidebar-only (CLAUDE.md). -->
      <span class="meta-item" title="Attempt" data-test="meta-attempt">
        <Hash :size="13" />
        {{ run.attempt }}
      </span>
      <span class="meta-item" title="Duration" data-test="meta-duration">
        <Timer :size="13" />
        {{ liveDuration }}
      </span>
      <span class="meta-item" title="Cost" data-test="meta-cost">
        <CircleDollarSign :size="13" />
        {{ formatCost(run.cost_usd) ?? '—' }}
        <!-- kimi cost is priced against Anthropic's list — mark it indicative -->
        <el-tooltip v-if="costIsIndicative" :content="INDICATIVE_COST_TIP" placement="top">
          <sup class="indicative-mark" data-test="cost-indicative">~</sup>
        </el-tooltip>
      </span>
      <el-tooltip v-if="tokensLabel" :content="tokensTip" placement="top">
        <!-- aria-label, not `title`: the wrapping el-tooltip already owns hover -->
        <span class="meta-item" aria-label="Tokens (input / output)" data-test="meta-tokens">
          <ArrowDownUp :size="13" />
          {{ tokensLabel }}
        </span>
      </el-tooltip>
    </div>

    <!-- Content tabs: the live view (report once ready + timeline) | history -->
    <el-tabs v-model="activeTab" class="content-tabs" data-test="run-tabs">
      <el-tab-pane label="Report & Timeline" name="report">
        <!-- Failure diagnostics -->
        <section v-if="run.error" class="section">
          <h3>Failure diagnostics</h3>
          <pre class="diagnostics" data-test="run-error">{{ run.error }}</pre>
          <a v-if="run.external_ref" :href="run.external_ref" target="_blank" rel="noopener" data-test="external-ref">
            {{ run.external_ref }}
          </a>
        </section>

        <!-- Artifacts (feature 019): one line per repo the run reported;
             hidden entirely when the report carried none. -->
        <section v-if="card.artifacts.length > 0" class="section">
          <h3>Artifacts</h3>
          <ul class="artifacts" data-test="artifacts">
            <li
              v-for="(a, i) in card.artifacts"
              :key="i"
              class="artifact-row"
              :data-test="`artifact-${i}`"
            >
              <GitBranch :size="13" />
              <span v-if="a.repo" class="artifact-repo" :data-test="`artifact-repo-${i}`">{{ a.repo }}</span>
              <span v-if="a.branch" class="artifact-branch">{{ a.branch }}</span>
              <a
                v-if="a.pr_url"
                :href="a.pr_url"
                target="_blank"
                rel="noopener"
                :data-test="`artifact-pr-${i}`"
              >
                {{ a.pr_url }}
              </a>
              <span v-if="artifactCounts(a)" class="artifact-counts muted">{{ artifactCounts(a) }}</span>
            </li>
          </ul>
        </section>

        <!-- Report checklist — hidden until checks arrive (partial report) -->
        <section v-if="card.checks.length > 0" class="section">
          <h3>Report</h3>
          <el-collapse v-model="activeChecks" class="checks" data-test="checks">
            <el-collapse-item
              v-for="c in card.checks"
              :key="c.position"
              :name="c.position"
              :disabled="!c.reason"
              :data-test="`check-${c.position}`"
            >
              <template #title>
                <span class="check-row" :data-test="`check-toggle-${c.position}`">
                  <span class="glyph" :data-test="`glyph-${c.position}`">{{ CHECK_GLYPH[c.status] }}</span>
                  <span class="check-name">{{ c.name }}</span>
                </span>
              </template>
              <div
                v-if="c.reason && activeChecks.includes(c.position)"
                class="reason"
                :data-test="`reason-${c.position}`"
              >
                {{ c.reason }}
              </div>
            </el-collapse-item>
          </el-collapse>
        </section>

        <!-- Event timeline -->
        <section class="section">
          <h3>
            Timeline
            <el-tag size="small" type="info" round data-test="timeline-count">{{ pluralize(stepCount, 'step') }}</el-tag>
          </h3>
          <RunTimeline :events="card.events" />
        </section>
      </el-tab-pane>

      <el-tab-pane label="Run history" name="history">
        <el-table :data="card.history" data-test="history-table">
          <el-table-column prop="agent" label="Agent" />
          <el-table-column prop="executor_type" label="Executor" />
          <el-table-column prop="attempt" label="Attempt" width="90" />
          <el-table-column label="Duration">
            <template #default="{ row }">{{ formatDuration(row.duration_ms) }}</template>
          </el-table-column>
          <el-table-column label="Cost">
            <template #default="{ row }">{{ formatCostUsd(row.cost_usd) ?? '—' }}</template>
          </el-table-column>
          <el-table-column prop="status" label="Outcome" />
        </el-table>
      </el-tab-pane>
    </el-tabs>
  </section>

  <el-empty
    v-else-if="cardQuery.isError.value"
    description="Run not found."
    data-test="run-not-found"
  />
  <el-skeleton v-else :rows="6" animated />
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.run-card {
  max-width: 900px;
}
.back {
  margin-bottom: $space-sm;
}
.header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $space-sm;
}
.title {
  margin: 0;
  min-width: 0;
}
.header-actions {
  display: flex;
  align-items: center;
  gap: $space-sm;
  flex-shrink: 0;
}
// el-button applies `margin-left` to a sibling button; the flex gap already
// spaces the group, so neutralize it for whichever action button renders first.
.header-actions .el-button {
  margin-left: 0;
}
.btn-label {
  margin-left: $space-xs;
}
.summary {
  font-weight: $font-weight-regular;
  margin-left: $space-sm;
  color: var(--el-text-color-regular);
}
.sub {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: $space-sm;
  font-size: 13px;
  margin: $space-sm 0 $space-lg;
}
.muted {
  color: var(--el-text-color-secondary);
}
.meta-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.indicative-mark {
  color: var(--el-color-warning);
  font-weight: $font-weight-medium;
  cursor: help;
}
.content-tabs {
  margin-top: $space-sm;
}
.section {
  margin-bottom: $space-lg;

  h3 {
    margin: 0 0 $space-sm;
    font-size: 14px;
    font-weight: $font-weight-medium;
    color: var(--el-text-color-secondary);
  }
}
// Bare collapse (no card around it): drop its outer top/bottom borders and
// keep only the thin separators between items.
.checks {
  --el-collapse-header-height: 40px;
  border-top: none;
  border-bottom: none;

  :deep(.el-collapse-item:last-child .el-collapse-item__header) {
    border-bottom: none;
  }
  // Checks without a reason are `disabled`: not expandable, but they are not
  // "inactive" — show them in the normal text color and without a chevron.
  :deep(.el-collapse-item.is-disabled .el-collapse-item__header) {
    color: inherit;
    cursor: default;
  }
  :deep(.el-collapse-item.is-disabled .el-collapse-item__arrow) {
    display: none;
  }
}
.check-row {
  display: flex;
  align-items: center;
  gap: $space-sm;
  min-width: 0;
}
.artifacts {
  list-style: none;
  margin: 0;
  padding: 0;
}
.artifact-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: $space-sm;
  padding: 4px 0;
  font-size: 13px;

  a {
    word-break: break-all;
  }
}
.artifact-repo {
  font-weight: $font-weight-medium;
}
.artifact-counts {
  font-size: 12px;
}
.glyph {
  width: 1.4em;
}
.reason {
  margin: 0 0 0 1.9em;
  color: var(--el-text-color-regular);
  font-size: 13px;
}
.diagnostics {
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--el-fill-color-light);
  padding: $space-md;
  border-radius: $radius-sm;
  margin: 0 0 $space-sm;
  font-size: 12px;
}
</style>
