<script setup lang="ts">
import { ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useGeneralSettings, useUpdateGeneralSettings } from '../../composables/useGeneralSettings';
import { ApiError } from '../../api/client';

/**
 * General panel of the platform Settings page (feature 010, FR-021). Holds the
 * default orchestrator instruction copied into a workspace's "brigadir"
 * orchestrator at creation time — changing it affects only workspaces created
 * afterward (SC-006).
 */
const query = useGeneralSettings();
const update = useUpdateGeneralSettings();

const instruction = ref('');

// Seed the editable field from the loaded value (once, and on refetch while pristine).
watch(
  () => query.data.value?.default_orchestrator_instruction,
  (value) => {
    if (value !== undefined) instruction.value = value;
  },
  { immediate: true },
);

async function save() {
  try {
    await update.mutateAsync({ default_orchestrator_instruction: instruction.value });
    ElMessage.success('Default orchestrator instruction saved.');
  } catch (err) {
    const msg = err instanceof ApiError ? err.message : (err as Error)?.message ?? 'Save failed.';
    ElMessage.error(msg);
  }
}
</script>

<template>
  <div class="settings-general" v-loading="query.isLoading.value">
    <h3>General</h3>
    <p class="hint">
      The default instruction copied into each new workspace's <strong>brigadir</strong> orchestrator
      when it is created. Changing it affects only workspaces created afterward; existing
      orchestrators keep their instruction.
    </p>

    <label class="field-label" for="default-orch-instruction">Default orchestrator instruction</label>
    <el-input
      id="default-orch-instruction"
      v-model="instruction"
      type="textarea"
      :rows="12"
      data-test="default-orchestrator-instruction"
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
</style>
