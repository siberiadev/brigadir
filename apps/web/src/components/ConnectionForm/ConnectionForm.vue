<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useRotateConnection } from '../../composables/useWorkspaces';
import { ApiError } from '../../api/client';
import { defaultExpiry } from '../../utils/date';

/**
 * Reconnect / re-verify form body (feature 008, US2) — extracted verbatim from
 * the old standalone WorkspaceSettings so the Jira-connection block's Edit modal
 * hosts it inside the shared FormDialog. A dialog-agnostic body that exposes
 * `submit()`/`saving` for the hosting FormDialog footer and emits `saved` on a
 * successful rotation — mirrors ExecutorForm.
 *
 * The email seeds from the PERSISTED `bot_email` (never a hard-coded default), so
 * reopening the modal shows the live connection identity. A re-verify failure
 * keeps the OLD credentials (the server retains them); we surface the message
 * inline and leave the working connection intact.
 */
const props = defineProps<{ workspaceId: string; botEmail: string | null }>();
const emit = defineEmits<{ saved: [] }>();

const rotate = useRotateConnection(props.workspaceId);
const form = reactive({ jira_email: props.botEmail ?? '', jira_api_token: '' });
const expiry = ref<Date>(defaultExpiry());
const error = ref('');

const saving = computed(() => rotate.isPending.value);

async function submit() {
  error.value = '';
  try {
    await rotate.mutateAsync({
      jira_email: form.jira_email,
      jira_api_token: form.jira_api_token,
      expires_at: expiry.value.toISOString(),
    });
    form.jira_api_token = '';
    emit('saved');
  } catch (err) {
    if (err instanceof ApiError) {
      error.value = err.issueFor('jira_api_token')?.message ?? err.message;
    } else {
      error.value = (err as Error)?.message ?? 'Reconnect failed.';
    }
  }
}

defineExpose({ submit, saving });
</script>

<template>
  <el-form label-position="top" class="connection-form">
    <el-form-item label="Bot email">
      <el-input v-model="form.jira_email" data-test="rotate-email" />
    </el-form-item>
    <el-form-item label="New API token">
      <el-input v-model="form.jira_api_token" type="password" data-test="rotate-token" />
    </el-form-item>
    <el-form-item label="Token expiry">
      <el-date-picker v-model="expiry" type="date" data-test="rotate-expiry" />
    </el-form-item>

    <div v-if="error" class="field-error" data-test="rotate-error">{{ error }}</div>
  </el-form>
</template>

<style scoped lang="scss">
.connection-form {
  max-width: 640px;
}
.field-error {
  font-size: 12px;
  color: var(--el-color-danger);
  margin: 8px 0;
}
</style>
