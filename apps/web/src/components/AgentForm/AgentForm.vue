<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type {
  AgentResponse,
  AgentWriteRequest,
  BoardStatus,
  ErrorIssue,
  LintableAgent,
  WorkspaceRepository,
} from '@brigadir/contracts';
// Runtime value: the SHARED linter, imported from its source module (ESM) so it
// never drags the CJS barrel / node:crypto into the browser bundle.
import { lintAgent } from '@brigadir/contracts/agent-linter';
import { MAX_PAGE_SIZE } from '@brigadir/contracts/pagination';
import { useStatuses } from '../../composables/useStatuses';
import { useAgents, useCreateAgent, useUpdateAgent, useTestRun } from '../../composables/useAgents';
import { useExecutors } from '../../composables/useExecutors';
import { useTicketCount } from '../../composables/useWorkspaces';
import { ApiError } from '../../api/client';

const props = defineProps<{
  workspaceId: string;
  agent?: AgentResponse | null;
  repositories: WorkspaceRepository[];
  /** Feature 018: create-mode seed for trigger_status (diagram "+"); ignored when `agent` is set. */
  initialTriggerStatus?: string;
}>();
const emit = defineEmits<{ saved: [warnings: ErrorIssue[]] }>();

const isEdit = computed(() => props.agent != null);

// Force a live statuses re-fetch on open (FR-011); a 502 blocks status editing.
const statusesQuery = useStatuses(props.workspaceId, { refresh: true });
const boardStatuses = computed<BoardStatus[]>(() => statusesQuery.data.value?.statuses ?? []);
const statusesUnavailable = computed(() => statusesQuery.isError.value);
const statusById = computed(() => new Map(boardStatuses.value.map((s) => [s.name, s.id])));

// Потребители ВСЕГО списка (клиентский линтер + пикер) — не листают
// (UI-конвенция 2026-07-15); >100 элементов не поддерживается осознанно.
const agentsQuery = useAgents(props.workspaceId, { page: 1, page_size: MAX_PAGE_SIZE });
// Named runner profiles (2026-07-14): the picker lists the global executor
// PROFILES as "<type> — <model> (<name>)" (mock: "mock (<name>)"), never a raw
// UUID; defaults to a claude_cli profile. Disabled profiles stay visible but
// are not selectable. The profile's model is the single source of truth — the
// agent has NO model field.
const executorsQuery = useExecutors({ page: 1, page_size: MAX_PAGE_SIZE });
const executorOptions = computed(() => executorsQuery.data.value?.items ?? []);

function executorLabel(ex: { type: string; name: string; config: Record<string, unknown> }): string {
  if (ex.type === 'mock') return `mock (${ex.name})`;
  const model = typeof ex.config.model === 'string' ? ex.config.model : '?';
  return `${ex.type} — ${model} (${ex.name})`;
}

const a = props.agent;
// feature 010 (FR-019): the per-workspace orchestrator is non-deletable and its
// name is fixed; its description is the roster line shown to it in the handoff.
const isOrchestrator = computed(() => props.agent?.is_orchestrator === true);
const form = reactive({
  name: a?.name ?? '',
  // feature 014: the agent's function (presentation). Editing it does NOT change
  // the immutable key. The orchestrator's role ("teamlead") is fixed.
  role: a?.role ?? '',
  description: a?.description ?? '',
  instruction: a?.instruction ?? '',
  executor_id: a?.executor_id ?? '',
  // Seed-only prefill (feature 018): edit mode always mirrors the agent row —
  // including a jql-only agent's null trigger — create mode may arrive pre-aimed
  // at a status from the diagram's "+".
  trigger_status: a ? (a.trigger_status ?? '') : (props.initialTriggerStatus ?? ''),
  trigger_jql: a?.trigger_jql ?? '',
  status_running: a?.status_running ?? '',
  status_success: a?.status_success ?? '',
  status_failure: a?.status_failure ?? '',
  timeout_minutes: a?.timeout_minutes ?? 45,
  max_budget_usd: a?.max_budget_usd ?? null,
  max_attempts: a?.max_attempts ?? 2,
  // Feature 019: the agent's repository SCOPE (behavior.repositories) — a
  // multi-select subset of workspace repos; [] = ALL workspace repositories.
  // Legacy rows carry the deprecated single behavior.repository — rendered as
  // a one-element selection; saving rewrites THIS agent onto the plural form.
  repositories:
    (a?.behavior?.repositories as string[] | undefined) ??
    (typeof a?.behavior?.repository === 'string' && a.behavior.repository !== ''
      ? [a.behavior.repository as string]
      : []),
  branch_prefix: (a?.behavior?.branch_prefix as string | undefined) ?? '',
  allowed_tools: (a?.behavior?.allowed_tools as string[] | undefined) ?? [],
  required_checks: (a?.behavior?.required_checks as string[] | undefined) ?? [],
  use_callback_channel: (a?.behavior?.use_callback_channel as boolean | undefined) ?? true,
});

// Default a fresh form to an ENABLED claude_cli profile (else the first enabled one).
watch(executorOptions, (opts) => {
  if (!form.executor_id && opts.length) {
    const enabled = opts.filter((e) => e.enabled);
    form.executor_id = (enabled.find((e) => e.type === 'claude_cli') ?? enabled[0] ?? opts[0]).id;
  }
});

const showAdvanced = ref(false);

// --- client-side linter mirror (same function the server enforces, T120) ---
const candidate = computed<LintableAgent>(() => ({
  id: props.agent?.id,
  name: form.name,
  trigger_status: form.trigger_status || null,
  trigger_jql: form.trigger_jql || null,
  status_running: form.status_running || null,
  status_success: form.status_success,
  status_failure: form.status_failure,
  enabled: props.agent?.enabled ?? true,
}));

const others = computed<LintableAgent[]>(() =>
  (agentsQuery.data.value?.items ?? []).map((ag) => ({
    id: ag.id,
    name: ag.name,
    trigger_status: ag.trigger_status,
    trigger_jql: ag.trigger_jql,
    status_running: ag.status_running,
    status_success: ag.status_success,
    status_failure: ag.status_failure,
    enabled: ag.enabled,
  })),
);

const lint = computed(() => lintAgent(candidate.value, others.value, boardStatuses.value));

// Server issues override/augment the client mirror on a save failure.
const serverIssues = ref<ErrorIssue[]>([]);

/** First blocking issue (client mirror ∪ last server response) for a field. */
function errorFor(field: string): string | undefined {
  const server = serverIssues.value.find((i) => i.path[0] === field && i.level === 'error');
  if (server) return server.message;
  const client = lint.value.errors.find((i) => i.path[0] === field);
  return client?.message;
}

/** Non-blocking warning (e.g. status_cycle) for a field. */
function warningFor(field: string): string | undefined {
  return lint.value.warnings.find((i) => i.path[0] === field)?.message;
}

const create = useCreateAgent(props.workspaceId);
const update = useUpdateAgent(props.workspaceId);
const saving = computed(() => create.isPending.value || update.isPending.value);
const generalError = ref('');

function buildRequest(): AgentWriteRequest {
  const status_ids = {
    trigger: statusById.value.get(form.trigger_status),
    running: form.status_running ? statusById.value.get(form.status_running) : undefined,
    success: statusById.value.get(form.status_success),
    failure: statusById.value.get(form.status_failure),
  };
  // feature 010 (FR-019): the orchestrator is never poll-triggered, so its
  // trigger/status fields carry no board mapping and the form leaves them
  // empty. The write schema still requires non-empty strings (min(1)); the
  // update handler discards these fields for an orchestrator, so send inert
  // placeholders to satisfy validation rather than an empty string that 422s.
  const orchestratorStatusStub = isOrchestrator.value ? 'n/a' : '';
  return {
    workspace_id: props.workspaceId,
    name: form.name,
    // feature 014: role is editable; key is server-derived on create and never
    // sent (the write schema is strict — sending a key would 422).
    role: form.role || null,
    description: form.description || null,
    instruction: form.instruction,
    executor_id: form.executor_id,
    trigger_status: form.trigger_status || orchestratorStatusStub,
    trigger_jql: form.trigger_jql || null,
    status_running: form.status_running || null,
    status_success: form.status_success || orchestratorStatusStub,
    status_failure: form.status_failure || orchestratorStatusStub,
    status_ids,
    timeout_minutes: form.timeout_minutes,
    max_budget_usd: form.max_budget_usd,
    max_attempts: form.max_attempts,
    behavior: {
      branch_prefix: form.branch_prefix || null,
      // Feature 019: the plural scope is the written form; the deprecated
      // single key is nulled on save of THIS agent only (untouched agents keep
      // whatever stored form they have — no migration).
      repositories: form.repositories,
      repository: null,
      allowed_tools: form.allowed_tools,
      required_checks: form.required_checks,
      use_callback_channel: form.use_callback_channel,
      // NO model key: the executor profile's model is the single source of
      // truth; a legacy behavior.model on old rows is ignored by the runtime.
    },
  };
}

async function submit() {
  serverIssues.value = [];
  generalError.value = '';
  // The client mirror surfaces issues for immediate feedback, but the SERVER is
  // authoritative on save (T153): we always attempt the write and let a 422
  // re-pin anything. status_cycle is a warning and never blocks.
  const body = buildRequest();
  try {
    const res = props.agent
      ? await update.mutateAsync({ id: props.agent.id, body })
      : await create.mutateAsync(body);
    emit('saved', res.warnings ?? []);
  } catch (err) {
    if (err instanceof ApiError && err.issues.length) {
      serverIssues.value = err.issues;
    } else {
      generalError.value = (err as Error)?.message ?? 'Save failed.';
    }
  }
}

// --- test-run by ticket key (edit only) ---
const testRun = useTestRun();
const ticketKey = ref('');
const testRunResult = ref('');

async function runTest() {
  if (!props.agent || !ticketKey.value) return;
  testRunResult.value = '';
  try {
    const res = await testRun.mutateAsync({ id: props.agent.id, ticketKey: ticketKey.value });
    testRunResult.value = res.deduplicated
      ? `Deduplicated — existing run ${res.existing_run_id}`
      : `Enqueued run ${res.run_id}`;
  } catch (err) {
    testRunResult.value = (err as Error)?.message ?? 'Test run failed.';
  }
}

// --- live-Jira trigger preview: how many tickets currently sit in the agent's
// trigger_status inside the workspace scope (this is exactly what would trigger
// a run today — trigger_jql is not evaluated at runtime). Available whenever a
// trigger_status is chosen, in both create and edit mode.
const ticketCount = useTicketCount(props.workspaceId);
const triggerPreviewResult = ref('');

async function previewTrigger() {
  if (!form.trigger_status) return;
  triggerPreviewResult.value = '';
  try {
    const res = await ticketCount.mutateAsync({ status: form.trigger_status });
    triggerPreviewResult.value =
      res.active_sprint_ids.length === 0 && res.count === 0
        ? 'No active sprint on this board — nothing would trigger.'
        : `${res.count} ticket(s) in "${form.trigger_status}" would trigger this agent.`;
  } catch (err) {
    triggerPreviewResult.value = (err as Error)?.message ?? 'Preview failed.';
  }
}

// The Cancel/Save buttons live in the hosting FormDialog footer (AgentsList),
// so we expose the imperative bits the footer drives.
defineExpose({ submit, saving });
</script>

<template>
  <el-form label-position="top" class="agent-form">
    <el-alert
      v-if="statusesUnavailable"
      type="warning"
      :closable="false"
      data-test="statuses-unavailable"
      title="Board statuses are unavailable — status fields are disabled until they load."
    />

    <el-form-item label="Name (persona)">
      <el-input v-model="form.name" :disabled="isOrchestrator" data-test="name-input" />
    </el-form-item>

    <el-form-item label="Role (function, e.g. Developer / QA / Reviewer)">
      <el-input
        v-model="form.role"
        :disabled="isOrchestrator"
        placeholder="Developer"
        data-test="role-input"
      />
    </el-form-item>

    <!-- feature 014: the key is the immutable technical handle (routing/URLs/logs),
         system-generated once at creation; shown read-only, editing name/role
         never changes it. Absent on create (server derives it). -->
    <el-form-item v-if="isEdit" label="Key (technical handle — read-only)">
      <el-input :model-value="props.agent?.key" readonly disabled data-test="key-readonly" />
    </el-form-item>

    <el-form-item label="Description (roster line shown to the orchestrator)">
      <el-input
        v-model="form.description"
        type="textarea"
        :autosize="{ minRows: 1, maxRows: 4 }"
        placeholder="What this agent does — the orchestrator uses this to route."
        data-test="description-input"
      />
    </el-form-item>

    <el-form-item label="Instruction">
      <el-input
        v-model="form.instruction"
        type="textarea"
        :autosize="{ minRows: 3, maxRows: 15 }"
        data-test="instruction-input"
      />
    </el-form-item>

    <el-form-item label="Executor">
      <el-select
        v-model="form.executor_id"
        filterable
        data-test="executor-select"
        placeholder="Select executor"
      >
        <!-- The option LABEL carries the full profile identity so the selected
             value renders the same "<type> — <model> (<name>)" string. -->
        <el-option
          v-for="ex in executorOptions"
          :key="ex.id"
          :label="executorLabel(ex)"
          :value="ex.id"
          :disabled="!ex.enabled"
        >
          <span class="executor-option">
            <span>{{ executorLabel(ex) }}</span>
            <el-tag v-if="!ex.enabled" size="small" type="info">disabled</el-tag>
          </span>
        </el-option>
      </el-select>
    </el-form-item>

    <!-- feature 010: the orchestrator is never poll-triggered and a completed
         orchestrator run takes NO generic success/failure transition — the
         ticket's next status is decided by the ROUTING TARGET's mapping. Its
         status fields are inert placeholders, so hide the whole block. -->
    <el-alert
      v-if="isOrchestrator"
      type="info"
      :closable="false"
      show-icon
      data-test="orchestrator-statuses-hint"
      title="No status mapping: the orchestrator is triggered by failed runs (not by a board status), and the ticket's next status is decided by the agent it routes to."
    />

    <template v-if="!isOrchestrator">
      <el-form-item label="Trigger status" :error="errorFor('trigger_status')">
        <div class="input-with-action">
          <el-select
            v-model="form.trigger_status"
            filterable
            allow-create
            :disabled="statusesUnavailable"
            data-test="trigger-status-select"
          >
            <el-option v-for="s in boardStatuses" :key="s.id" :label="s.name" :value="s.name" />
          </el-select>
          <el-button
            data-test="trigger-preview-button"
            :loading="ticketCount.isPending.value"
            :disabled="!form.trigger_status"
            @click="previewTrigger"
          >
            Preview matching tickets
          </el-button>
        </div>
        <div v-if="errorFor('trigger_status')" class="field-error" data-test="trigger-status-error">
          {{ errorFor('trigger_status') }}
        </div>
        <div v-if="triggerPreviewResult" class="field-hint" data-test="trigger-preview-result">
          {{ triggerPreviewResult }}
        </div>
      </el-form-item>

      <el-form-item label="Trigger JQL (advanced)">
        <el-input v-model="form.trigger_jql" data-test="trigger-jql-input" />
      </el-form-item>

      <el-form-item label="Running status (recommended)" :error="errorFor('status_running')">
        <el-select
          v-model="form.status_running"
          filterable
          allow-create
          clearable
          :disabled="statusesUnavailable"
          data-test="status-running-select"
        >
          <el-option v-for="s in boardStatuses" :key="s.id" :label="s.name" :value="s.name" />
        </el-select>
      </el-form-item>

      <el-form-item label="Success status" :error="errorFor('status_success')">
        <el-select
          v-model="form.status_success"
          filterable
          allow-create
          :disabled="statusesUnavailable"
          data-test="status-success-select"
        >
          <el-option v-for="s in boardStatuses" :key="s.id" :label="s.name" :value="s.name" />
        </el-select>
        <div v-if="errorFor('status_success')" class="field-error" data-test="status-success-error">
          {{ errorFor('status_success') }}
        </div>
        <div
          v-if="warningFor('status_success')"
          class="field-warning"
          data-test="status-success-warning"
        >
          {{ warningFor('status_success') }}
        </div>
      </el-form-item>

      <el-form-item label="Failure status" :error="errorFor('status_failure')">
        <el-select
          v-model="form.status_failure"
          filterable
          allow-create
          :disabled="statusesUnavailable"
          data-test="status-failure-select"
        >
          <el-option v-for="s in boardStatuses" :key="s.id" :label="s.name" :value="s.name" />
        </el-select>
      </el-form-item>
    </template>

    <div class="two-col">
      <el-form-item label="Timeout (min)">
        <el-input-number v-model="form.timeout_minutes" :min="1" data-test="timeout-input" />
      </el-form-item>
      <el-form-item label="Max attempts">
        <el-input-number v-model="form.max_attempts" :min="1" data-test="max-attempts-input" />
      </el-form-item>
      <el-form-item label="Max budget (USD)">
        <el-input-number v-model="form.max_budget_usd" :min="0" :step="0.5" data-test="budget-input" />
      </el-form-item>
    </div>

    <!-- feature 010: orchestrator triage runs have no repository workspace.
         feature 019: multi-select repository SCOPE; empty = all workspace repos. -->
    <el-form-item v-if="!isOrchestrator" label="Repositories (empty = all)">
      <el-select
        v-model="form.repositories"
        multiple
        clearable
        placeholder="all repositories"
        data-test="repository-select"
      >
        <el-option v-for="r in repositories" :key="r.name" :label="r.name" :value="r.name" />
      </el-select>
    </el-form-item>

    <el-divider>
      <el-button link @click="showAdvanced = !showAdvanced" data-test="toggle-advanced">
        {{ showAdvanced ? 'Hide' : 'Show' }} advanced
      </el-button>
    </el-divider>

    <template v-if="showAdvanced">
      <el-form-item label="Branch prefix (empty = workspace default)">
        <el-input v-model="form.branch_prefix" data-test="branch-prefix-input" />
      </el-form-item>
      <el-form-item label="Allowed tools">
        <el-select v-model="form.allowed_tools" multiple filterable allow-create data-test="allowed-tools-select" />
      </el-form-item>
      <el-form-item label="Required checks">
        <el-select v-model="form.required_checks" multiple filterable allow-create data-test="required-checks-select" />
      </el-form-item>
    </template>

    <el-form-item label="Use callback channel">
      <el-switch v-model="form.use_callback_channel" data-test="callback-switch" />
    </el-form-item>

    <el-alert v-if="generalError" type="error" :closable="false" data-test="general-error">
      {{ generalError }}
    </el-alert>

    <!-- Test-run by ticket key (edit only) -->
    <el-divider v-if="isEdit" />
    <div v-if="isEdit" class="test-run">
      <el-input
        v-model="ticketKey"
        placeholder="BRIG-123"
        data-test="ticket-key-input"
        style="max-width: 200px"
      />
      <el-button data-test="test-run-button" :loading="testRun.isPending.value" @click="runTest">
        Test run
      </el-button>
      <span v-if="testRunResult" data-test="test-run-result">{{ testRunResult }}</span>
    </div>
  </el-form>
</template>

<style scoped lang="scss">
.agent-form {
  max-width: 640px;
}
.two-col {
  display: flex;
  gap: 16px;
}
.two-col > * {
  flex: 1;
}
.field-error {
  font-size: 12px;
  color: var(--el-color-danger);
  margin-top: 4px;
}
.field-warning {
  font-size: 12px;
  color: var(--el-color-warning);
  margin-top: 4px;
}
.input-with-action {
  display: flex;
  align-items: center;
  gap: 8px;
}
.input-with-action > .el-select {
  flex: 1;
}
.field-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 4px;
}
.test-run {
  display: flex;
  gap: 12px;
  align-items: center;
}
.executor-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
</style>
