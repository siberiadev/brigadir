<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useUpdateSettings, useTicketCount } from '../../composables/useWorkspaces';

/**
 * General workspace settings form (feature 031 settings restructure) — the
 * branch prefix and the advanced scope JQL (with its live ticket-count preview).
 * Extracted from the old ConfigForm when the workspace Settings page split into
 * sidebar sections (General / Jira / Environment / Agents); repositories + env
 * moved to EnvironmentForm. Exposes `submit()`/`saving`, emits `saved`.
 *
 * Inputs SEED from the persisted response (FR-014): an unset `branch_prefix`
 * seeds EMPTY, never the hard-coded `feat`. Save PATCHes only these keys, so it
 * never touches repositories or env (settings jsonb is shallow-merged).
 */
const props = defineProps<{
  workspaceId: string;
  branchPrefix: string | null;
  scopeJql: string | null;
}>();
const emit = defineEmits<{ saved: [] }>();

const form = reactive({
  branch_prefix: props.branchPrefix ?? '',
  scope_jql: props.scopeJql ?? '',
});
// Open the advanced pane when a scope filter is already set.
const showAdvanced = ref(!!props.scopeJql);

const updateSettings = useUpdateSettings(props.workspaceId);
const saving = computed(() => updateSettings.isPending.value);

async function submit() {
  await updateSettings.mutateAsync({
    branch_prefix: form.branch_prefix || undefined,
    scope_jql: form.scope_jql || undefined,
  });
  emit('saved');
}

// --- live-Jira scope preview (only meaningful when scope_jql is unchanged) ---
const ticketCount = useTicketCount(props.workspaceId);
const previewResult = ref('');
const scopeDirty = computed(() => (form.scope_jql || '') !== (props.scopeJql ?? ''));

async function previewCount() {
  previewResult.value = '';
  try {
    const res = await ticketCount.mutateAsync({});
    previewResult.value =
      res.active_sprint_ids.length === 0 && res.count === 0
        ? 'No active sprint on this board — nothing in scope.'
        : `${res.count} ticket(s) in scope.`;
  } catch (err) {
    previewResult.value = (err as Error)?.message ?? 'Preview failed.';
  }
}

defineExpose({ submit, saving });
</script>

<template>
  <el-form label-position="top" class="general-form">
    <el-form-item label="Default branch prefix">
      <el-input v-model="form.branch_prefix" placeholder="feat" data-test="branch-prefix" />
    </el-form-item>

    <el-divider>
      <el-button link data-test="toggle-advanced" @click="showAdvanced = !showAdvanced">
        {{ showAdvanced ? 'Hide' : 'Show' }} advanced
      </el-button>
    </el-divider>
    <el-form-item v-if="showAdvanced" label="Scope JQL (advanced)">
      <el-input v-model="form.scope_jql" data-test="scope-jql">
        <template #append>
          <el-button
            data-test="scope-preview-button"
            :loading="ticketCount.isPending.value"
            :disabled="scopeDirty"
            @click="previewCount"
          >
            Preview ticket count
          </el-button>
        </template>
      </el-input>
      <div v-if="scopeDirty" class="preview-hint" data-test="scope-preview-dirty">
        Save to preview the new scope.
      </div>
      <div v-else-if="previewResult" class="preview-hint" data-test="scope-preview-result">
        {{ previewResult }}
      </div>
    </el-form-item>
  </el-form>
</template>

<style scoped lang="scss">
.general-form {
  max-width: 640px;
}
.preview-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 4px;
}
</style>
