<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import type { WorkspaceRepository } from '@brigadir/contracts';
import { useUpdateSettings, useTicketCount } from '../../composables/useWorkspaces';

/**
 * Configuration form body (feature 008, US2) — branch prefix, advanced scope
 * JQL, and the ordered repository list (first = default). Extracted from the old
 * standalone WorkspaceSettings so the configuration block's Edit modal hosts it
 * inside the shared FormDialog. Exposes `submit()`/`saving` and emits `saved`,
 * mirroring ExecutorForm.
 *
 * Every input SEEDS from the persisted response values (FR-014) — an unset
 * `branch_prefix` seeds EMPTY, never the hard-coded `feat` that the old form used
 * (which could silently overwrite a customized prefix on re-save).
 */
const props = defineProps<{
  workspaceId: string;
  branchPrefix: string | null;
  scopeJql: string | null;
  repositories: WorkspaceRepository[];
}>();
const emit = defineEmits<{ saved: [] }>();

const form = reactive({
  branch_prefix: props.branchPrefix ?? '',
  scope_jql: props.scopeJql ?? '',
});
const repositories = ref<WorkspaceRepository[]>(props.repositories.map((r) => ({ ...r })));
// Open the advanced pane when a scope filter is already set, so the seeded value
// is visible without an extra click.
const showAdvanced = ref(!!props.scopeJql);

const updateSettings = useUpdateSettings(props.workspaceId);
const saving = computed(() => updateSettings.isPending.value);

function addRepository() {
  repositories.value.push({ name: '', git_url: '', default_branch: 'main' });
}
function removeRepository(index: number) {
  repositories.value.splice(index, 1);
}

async function submit() {
  const repos = repositories.value.filter((r) => r.name && r.git_url && r.default_branch);
  await updateSettings.mutateAsync({
    scope_jql: form.scope_jql || undefined,
    branch_prefix: form.branch_prefix || undefined,
    repositories: repos,
  });
  emit('saved');
}

// --- live-Jira scope preview ---
// Counts against the SAVED scope_jql, so it's only meaningful when the field is
// unchanged. A dirty scope_jql disables the button (save first, then preview).
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
  <el-form label-position="top" class="config-form">
    <el-form-item label="Default branch prefix">
      <el-input v-model="form.branch_prefix" placeholder="feat" data-test="branch-prefix" />
    </el-form-item>

    <el-divider>
      <el-button link data-test="toggle-advanced" @click="showAdvanced = !showAdvanced">
        {{ showAdvanced ? 'Hide' : 'Show' }} advanced
      </el-button>
    </el-divider>
    <el-form-item v-if="showAdvanced" label="Scope JQL (advanced)">
      <el-input v-model="form.scope_jql" data-test="scope-jql" />
      <div class="preview-row">
        <el-button
          data-test="scope-preview-button"
          :loading="ticketCount.isPending.value"
          :disabled="scopeDirty"
          @click="previewCount"
        >
          Preview ticket count
        </el-button>
        <span v-if="scopeDirty" class="preview-hint" data-test="scope-preview-dirty">
          Save to preview the new scope.
        </span>
        <span v-else-if="previewResult" class="preview-hint" data-test="scope-preview-result">
          {{ previewResult }}
        </span>
      </div>
    </el-form-item>

    <h4>Repositories (first = default)</h4>
    <div
      v-for="(repo, i) in repositories"
      :key="i"
      class="repo-row"
      :data-test="`repo-row-${i}`"
    >
      <el-input v-model="repo.name" placeholder="name" :data-test="`repo-name-${i}`" />
      <el-input v-model="repo.git_url" placeholder="git@…" :data-test="`repo-url-${i}`" />
      <el-input v-model="repo.default_branch" placeholder="main" :data-test="`repo-branch-${i}`" />
      <el-button link type="danger" :data-test="`repo-remove-${i}`" @click="removeRepository(i)">
        Remove
      </el-button>
    </div>
    <el-button data-test="add-repo" @click="addRepository">Add repository</el-button>
  </el-form>
</template>

<style scoped lang="scss">
.config-form {
  max-width: 640px;
}
.repo-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}
.preview-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.preview-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
