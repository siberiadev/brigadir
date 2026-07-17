<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  DEFAULT_ORCHESTRATOR_INSTRUCTION,
  DEFAULT_WORKSPACE_SETUP_INSTRUCTION,
  DEFAULT_BRIGADIR_AGENT_TEMPLATE,
} from '@brigadir/contracts/orchestrator-defaults';
import { MAX_PAGE_SIZE } from '@brigadir/contracts/pagination';
import type { BrigadirAgentSettings, ErrorIssue } from '@brigadir/contracts';
import {
  useBrigadirAgentSettings,
  useUpdateBrigadirAgentSettings,
} from '../../composables/useBrigadirAgentSettings';
import { useExecutors } from '../../composables/useExecutors';
import { ApiError } from '../../api/client';

/**
 * "Brigadir agent" settings panel (feature 015): the editable TEMPLATE of the
 * default orchestrator. Identity/triage/limits are copied into every NEW
 * workspace's orchestrator at creation (existing workspaces untouched —
 * feature 010 SC-006 semantics); the setup execution profile and the
 * agent-creation instruction are read LIVE by every "Generate agents" run.
 *
 * Behavior editing surface (analysis U1): only the triage workspace mode is
 * exposed; every other behavior key round-trips unchanged — the loaded
 * behavior objects are kept and only the exposed key is patched on save.
 */
const query = useBrigadirAgentSettings();
const update = useUpdateBrigadirAgentSettings();

const executorsQuery = useExecutors({ page: 1, page_size: MAX_PAGE_SIZE });
const executorOptions = computed(() => executorsQuery.data.value?.items ?? []);

function executorLabel(ex: { type: string; name: string; config: Record<string, unknown> }): string {
  if (ex.type === 'mock') return `mock (${ex.name})`;
  const model = typeof ex.config.model === 'string' ? ex.config.model : '?';
  return `${ex.type} — ${model} (${ex.name})`;
}

// --- editable state, seeded from the loaded settings ---
const name = ref('');
const role = ref('');
const enabled = ref(true);
const timeoutMinutes = ref(45);
const maxAttempts = ref(2);
const maxBudgetUsd = ref<number | null>(null);
const triageExecutor = ref('');
const triageWorkspaceMode = ref<'none' | 'default_repo'>('none');
const setupExecutor = ref('');
const setupTimeoutMinutes = ref(60);
const routingInstruction = ref('');
const setupInstruction = ref('');

// Unexposed behavior keys are preserved verbatim (round-trip, analysis U1).
let triageBehaviorRest: Record<string, unknown> = {};
let setupBehavior: Record<string, unknown> = {};

watch(
  () => query.data.value,
  (value) => {
    if (!value) return;
    const t = value.template;
    name.value = t.name;
    role.value = t.role;
    enabled.value = t.enabled;
    timeoutMinutes.value = t.timeout_minutes;
    maxAttempts.value = t.max_attempts;
    maxBudgetUsd.value = t.max_budget_usd;
    triageExecutor.value = t.triage.executor;
    const { workspace_mode, ...rest } = t.triage.behavior;
    triageWorkspaceMode.value = workspace_mode === 'none' ? 'none' : 'default_repo';
    triageBehaviorRest = rest;
    setupExecutor.value = t.setup.executor;
    setupTimeoutMinutes.value = t.setup.timeout_minutes;
    setupBehavior = { ...t.setup.behavior };
    routingInstruction.value = value.routing_instruction;
    setupInstruction.value = value.workspace_setup_instruction;
  },
  { immediate: true },
);

const routingIsDefault = computed(
  () => routingInstruction.value === DEFAULT_ORCHESTRATOR_INSTRUCTION,
);
const setupIsDefault = computed(
  () => setupInstruction.value === DEFAULT_WORKSPACE_SETUP_INSTRUCTION,
);

function resetRouting() {
  routingInstruction.value = DEFAULT_ORCHESTRATOR_INSTRUCTION;
}
function resetSetup() {
  setupInstruction.value = DEFAULT_WORKSPACE_SETUP_INSTRUCTION;
}

/** Reset EVERY field (template + both texts) to built-in defaults, locally; Save persists. */
async function resetAll() {
  try {
    await ElMessageBox.confirm(
      'Reset every field of the brigadir agent template and both instruction texts to the built-in defaults? Nothing is saved until you press Save.',
      'Reset all to defaults',
      { confirmButtonText: 'Reset all', cancelButtonText: 'Cancel', type: 'warning' },
    );
  } catch {
    return; // cancelled
  }
  const d = DEFAULT_BRIGADIR_AGENT_TEMPLATE;
  name.value = d.name;
  role.value = d.role;
  enabled.value = d.enabled;
  timeoutMinutes.value = d.timeout_minutes;
  maxAttempts.value = d.max_attempts;
  maxBudgetUsd.value = d.max_budget_usd;
  triageExecutor.value = d.triage.executor;
  triageWorkspaceMode.value = 'none';
  triageBehaviorRest = {};
  setupExecutor.value = d.setup.executor;
  setupTimeoutMinutes.value = d.setup.timeout_minutes;
  setupBehavior = { ...d.setup.behavior };
  resetRouting();
  resetSetup();
}

function buildPayload(): BrigadirAgentSettings {
  return {
    template: {
      schema_version: 1,
      name: name.value,
      role: role.value,
      enabled: enabled.value,
      timeout_minutes: timeoutMinutes.value,
      max_attempts: maxAttempts.value,
      max_budget_usd: maxBudgetUsd.value,
      triage: {
        executor: triageExecutor.value,
        behavior:
          triageWorkspaceMode.value === 'none'
            ? { ...triageBehaviorRest, workspace_mode: 'none' }
            : { ...triageBehaviorRest },
      },
      setup: {
        executor: setupExecutor.value,
        behavior: setupBehavior,
        timeout_minutes: setupTimeoutMinutes.value,
      },
    },
    routing_instruction: routingInstruction.value,
    workspace_setup_instruction: setupInstruction.value,
  };
}

const serverIssues = ref<ErrorIssue[]>([]);

async function save() {
  serverIssues.value = [];
  try {
    await update.mutateAsync(buildPayload());
    ElMessage.success('Brigadir agent settings saved.');
  } catch (err) {
    if (err instanceof ApiError && err.issues?.length) {
      serverIssues.value = err.issues;
    }
    const msg = err instanceof ApiError ? err.message : (err as Error)?.message ?? 'Save failed.';
    ElMessage.error(msg);
  }
}
</script>

<template>
  <div class="settings-brigadir-agent" v-loading="query.isLoading.value">
    <div class="panel-header">
      <h3>Brigadir agent</h3>
      <el-button size="small" text bg data-test="reset-all-defaults" @click="resetAll">
        Reset all to defaults
      </el-button>
    </div>
    <p class="hint">
      The template of the default <strong>brigadir</strong> orchestrator. Identity, triage profile
      and limits are copied into every workspace created AFTER a save — existing workspaces are
      never modified (edit their agent directly instead). The setup profile and the agent-creation
      instruction apply live to the next “Generate agents” run in every workspace.
    </p>

    <el-alert
      v-if="serverIssues.length"
      type="error"
      :closable="false"
      class="issues-alert"
      data-test="settings-issues"
    >
      <ul class="issues-list">
        <li v-for="(issue, i) in serverIssues" :key="i">
          <code>{{ issue.path.join('.') }}</code> — {{ issue.message }}
        </li>
      </ul>
    </el-alert>

    <div class="field-grid">
      <div>
        <label class="field-label" for="template-name">Name</label>
        <el-input id="template-name" v-model="name" data-test="template-name" />
      </div>
      <div>
        <label class="field-label" for="template-role">Role</label>
        <el-input id="template-role" v-model="role" placeholder="teamlead" data-test="template-role" />
      </div>
    </div>

    <label class="field-label">Triage executor profile</label>
    <p class="hint">Runs routing/triage — keep it cheap and repository-less.</p>
    <el-select
      v-model="triageExecutor"
      filterable
      class="executor-select"
      data-test="template-triage-executor"
    >
      <el-option
        v-for="ex in executorOptions"
        :key="ex.id"
        :value="ex.name"
        :label="executorLabel(ex)"
        :disabled="!ex.enabled"
      />
    </el-select>

    <label class="field-label">Triage workspace mode</label>
    <el-radio-group v-model="triageWorkspaceMode" size="small" data-test="template-workspace-mode">
      <el-radio-button value="none">No repository</el-radio-button>
      <el-radio-button value="default_repo">Workspace default repo</el-radio-button>
    </el-radio-group>

    <div class="field-grid limits">
      <div>
        <label class="field-label" for="template-timeout">Timeout (minutes)</label>
        <el-input-number
          id="template-timeout"
          v-model="timeoutMinutes"
          :min="1"
          data-test="template-timeout"
        />
      </div>
      <div>
        <label class="field-label" for="template-max-attempts">Max attempts</label>
        <el-input-number
          id="template-max-attempts"
          v-model="maxAttempts"
          :min="1"
          data-test="template-max-attempts"
        />
      </div>
      <div>
        <label class="field-label" for="template-budget">Max budget (USD)</label>
        <el-input-number
          id="template-budget"
          v-model="maxBudgetUsd"
          :min="0"
          :step="0.5"
          :value-on-clear="null"
          placeholder="no cap"
          data-test="template-budget"
        />
      </div>
      <div>
        <label class="field-label" for="template-enabled">Enabled</label>
        <div>
          <el-switch id="template-enabled" v-model="enabled" data-test="template-enabled" />
        </div>
      </div>
    </div>

    <h4 class="section-title">Setup runs (“Generate agents”)</h4>
    <p class="hint">
      Applied live to every workspace-setup run: a capable model, a larger turn budget and the
      workspace's default repository mounted for recon (read-only — a setup run never pushes).
    </p>
    <div class="field-grid">
      <div>
        <label class="field-label">Setup executor profile</label>
        <el-select
          v-model="setupExecutor"
          filterable
          class="executor-select"
          data-test="setup-executor"
        >
          <el-option
            v-for="ex in executorOptions"
            :key="ex.id"
            :value="ex.name"
            :label="executorLabel(ex)"
            :disabled="!ex.enabled"
          />
        </el-select>
      </div>
      <div>
        <label class="field-label" for="setup-timeout">Setup timeout (minutes)</label>
        <el-input-number
          id="setup-timeout"
          v-model="setupTimeoutMinutes"
          :min="1"
          data-test="setup-timeout"
        />
      </div>
    </div>

    <div class="instruction-header">
      <label class="field-label" for="default-orch-instruction">
        Routing instruction (triage)
      </label>
      <el-button
        size="small"
        text
        bg
        :disabled="routingIsDefault"
        data-test="reset-routing-instruction"
        @click="resetRouting"
      >
        Reset to default
      </el-button>
    </div>
    <p class="hint">
      How <strong>brigadir</strong> triages a failed worker run or a human answer. Copied into each
      new workspace's orchestrator at creation time — changing it affects only workspaces created
      afterward; existing orchestrators keep their instruction (editable per agent).
    </p>
    <el-input
      id="default-orch-instruction"
      v-model="routingInstruction"
      type="textarea"
      :rows="12"
      data-test="default-orchestrator-instruction"
    />

    <div class="instruction-header">
      <label class="field-label" for="workspace-setup-instruction">
        Agent-creation instruction (workspace setup)
      </label>
      <el-button
        size="small"
        text
        bg
        :disabled="setupIsDefault"
        data-test="reset-setup-instruction"
        @click="resetSetup"
      >
        Reset to default
      </el-button>
    </div>
    <p class="hint">
      The study/name/deliver protocol <strong>brigadir</strong> follows when generating a
      workspace's agent team. Read live on every “Generate agents” run — changing it affects the
      next run in every workspace.
    </p>
    <el-input
      id="workspace-setup-instruction"
      v-model="setupInstruction"
      type="textarea"
      :rows="12"
      data-test="workspace-setup-instruction"
    />

    <div class="actions">
      <el-button
        type="primary"
        :loading="update.isPending.value"
        data-test="save-brigadir-agent-settings"
        @click="save"
      >
        Save
      </el-button>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.settings-brigadir-agent {
  max-width: 820px;
}
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $space-sm;

  h3 {
    margin: 0;
  }
}
.hint {
  color: var(--el-text-color-secondary);
  margin-bottom: $space-md;
}
.field-label {
  display: block;
  font-weight: $font-weight-medium;
  margin-bottom: $space-xs;
}
.field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: $space-md;
  margin-bottom: $space-md;

  &.limits {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
.executor-select {
  width: 100%;
  margin-bottom: $space-md;
}
.section-title {
  margin: $space-lg 0 $space-xs;
}
.issues-alert {
  margin-bottom: $space-md;
}
.issues-list {
  margin: 0;
  padding-left: $space-md;
}
.actions {
  margin-top: $space-md;
}
.instruction-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $space-sm;
  margin-top: $space-lg;

  .field-label {
    margin-bottom: 0;
  }
}
</style>
