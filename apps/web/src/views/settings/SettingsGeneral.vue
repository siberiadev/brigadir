<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import {
  DEFAULT_ORCHESTRATOR_INSTRUCTION,
  DEFAULT_WORKSPACE_SETUP_INSTRUCTION,
} from '@brigadir/contracts/orchestrator-defaults';
import { useGeneralSettings, useUpdateGeneralSettings } from '../../composables/useGeneralSettings';
import { useTheme } from '../../composables/useTheme';
import { ApiError } from '../../api/client';

/**
 * General panel of the platform Settings page (feature 010, FR-021). Holds the
 * two editable brigadir instruction texts (2026-07-16):
 * - routing (triage) — copied into a workspace's "brigadir" orchestrator at
 *   creation time; edits affect only workspaces created afterward (SC-006);
 * - agent creation (workspace setup) — read live by every generate-agents run.
 * Each field has a "Reset to default" that restores the built-in text locally;
 * Save persists both.
 */
const query = useGeneralSettings();
const update = useUpdateGeneralSettings();

// Theme is a device-level preference (localStorage via useTheme), applied
// instantly — it does not participate in the Save round-trip below.
const { mode: themeMode } = useTheme();

const routingInstruction = ref('');
const setupInstruction = ref('');

// Seed the editable fields from the loaded value (once, and on refetch while pristine).
watch(
  () => query.data.value,
  (value) => {
    if (!value) return;
    routingInstruction.value = value.default_orchestrator_instruction;
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

async function save() {
  try {
    await update.mutateAsync({
      default_orchestrator_instruction: routingInstruction.value,
      workspace_setup_instruction: setupInstruction.value,
    });
    ElMessage.success('Brigadir instructions saved.');
  } catch (err) {
    const msg = err instanceof ApiError ? err.message : (err as Error)?.message ?? 'Save failed.';
    ElMessage.error(msg);
  }
}
</script>

<template>
  <div class="settings-general" v-loading="query.isLoading.value">
    <h3>General</h3>

    <label class="field-label">Theme</label>
    <p class="hint">Applies immediately on this device. “System” follows the OS setting.</p>
    <el-radio-group v-model="themeMode" size="small" data-test="theme-mode">
      <el-radio-button value="light" data-test="theme-mode-light">Light</el-radio-button>
      <el-radio-button value="dark" data-test="theme-mode-dark">Dark</el-radio-button>
      <el-radio-button value="auto" data-test="theme-mode-auto">System</el-radio-button>
    </el-radio-group>

    <div class="instruction-header">
      <label class="field-label" for="default-orch-instruction">
        Brigadir routing instruction (triage)
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
        Brigadir agent-creation instruction (workspace setup)
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
        data-test="save-general-settings"
        @click="save"
      >
        Save
      </el-button>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.settings-general {
  max-width: 820px;
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
