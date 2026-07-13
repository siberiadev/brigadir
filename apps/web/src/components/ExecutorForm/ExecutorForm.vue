<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import type {
  ExecutorCreateRequest,
  ExecutorResponse,
  ExecutorType,
  WorkspaceRepository,
} from '@brigadir/contracts';
import { useCreateExecutor, useUpdateExecutor } from '../../composables/useExecutors';
import { ApiError } from '../../api/client';

// Typed per-type executor config form (US4), driven by the shared
// `executor.schema` union — the field set switches on `type` (mock carries only
// concurrency; claude_cli carries the CLI runtime fields). Mirrors AgentForm:
// a dialog-agnostic body exposing submit()/saving for the hosting FormDialog.
const props = defineProps<{
  workspaceId: string;
  executor?: ExecutorResponse | null;
  repositories: WorkspaceRepository[];
}>();
const emit = defineEmits<{ saved: [] }>();

const e = props.executor;
const cfg = (e?.config ?? {}) as Record<string, unknown>;

const form = reactive({
  type: (e?.type ?? 'claude_cli') as ExecutorType,
  name: e?.name ?? '',
  concurrency_limit: e?.concurrency_limit ?? 1,
  // claude_cli fields
  model: (cfg.model as string | undefined) ?? 'claude-sonnet-5',
  cli_path: (cfg.cli_path as string | undefined) ?? 'claude',
  repository: (cfg.repository as string | undefined) ?? '',
  use_callback_channel: (cfg.use_callback_channel as boolean | undefined) ?? true,
  keep_failed_worktrees: (cfg.keep_failed_worktrees as boolean | undefined) ?? false,
  max_turns: (cfg.max_turns as number | undefined) ?? 30,
});

const fieldErrors = reactive<Record<string, string>>({});
const generalError = ref('');

const create = useCreateExecutor(props.workspaceId);
const update = useUpdateExecutor(props.workspaceId);
const saving = computed(() => create.isPending.value || update.isPending.value);

function buildRequest(): ExecutorCreateRequest {
  if (form.type === 'mock') {
    return { type: 'mock', name: form.name, concurrency_limit: form.concurrency_limit };
  }
  return {
    type: 'claude_cli',
    name: form.name,
    model: form.model,
    cli_path: form.cli_path,
    repository: form.repository,
    use_callback_channel: form.use_callback_channel,
    keep_failed_worktrees: form.keep_failed_worktrees,
    max_turns: form.max_turns,
    concurrency_limit: form.concurrency_limit,
  };
}

async function submit() {
  for (const k of Object.keys(fieldErrors)) delete fieldErrors[k];
  generalError.value = '';
  const body = buildRequest();
  try {
    if (props.executor) {
      await update.mutateAsync({ id: props.executor.id, body });
    } else {
      await create.mutateAsync(body);
    }
    emit('saved');
  } catch (err) {
    if (err instanceof ApiError && err.issues.length) {
      for (const issue of err.issues) fieldErrors[String(issue.path[0])] = issue.message;
      if (!err.issues.some((i) => i.path.length)) generalError.value = err.message;
    } else if (err instanceof ApiError) {
      generalError.value = err.message;
    } else {
      generalError.value = (err as Error)?.message ?? 'Save failed.';
    }
  }
}

defineExpose({ submit, saving });
</script>

<template>
  <el-form label-position="top" class="executor-form">
    <div class="two-col">
      <el-form-item label="Name" :error="fieldErrors.name">
        <el-input v-model="form.name" data-test="executor-name" />
      </el-form-item>
      <el-form-item label="Type">
        <el-select v-model="form.type" data-test="executor-type">
          <el-option label="claude_cli" value="claude_cli" />
          <el-option label="mock" value="mock" />
        </el-select>
      </el-form-item>
    </div>

    <!-- claude_cli-only fields -->
    <template v-if="form.type === 'claude_cli'">
      <div class="two-col">
        <el-form-item label="Model" :error="fieldErrors.model">
          <el-input v-model="form.model" data-test="executor-model" />
        </el-form-item>
        <el-form-item label="CLI path" :error="fieldErrors.cli_path">
          <el-input v-model="form.cli_path" data-test="executor-cli-path" />
        </el-form-item>
      </div>

      <el-form-item label="Repository" :error="fieldErrors.repository">
        <el-select
          v-model="form.repository"
          clearable
          placeholder="workspace default"
          data-test="executor-repository"
        >
          <el-option v-for="r in repositories" :key="r.name" :label="r.name" :value="r.name" />
        </el-select>
      </el-form-item>

      <div class="two-col">
        <el-form-item label="Max turns">
          <el-input-number v-model="form.max_turns" :min="1" data-test="executor-max-turns" />
        </el-form-item>
        <el-form-item label="Concurrency limit">
          <el-input-number v-model="form.concurrency_limit" :min="1" data-test="executor-concurrency" />
        </el-form-item>
      </div>

      <el-form-item label="Use callback channel">
        <el-switch v-model="form.use_callback_channel" data-test="executor-callback" />
      </el-form-item>
      <el-form-item label="Keep failed worktrees">
        <el-switch v-model="form.keep_failed_worktrees" data-test="executor-keep-worktrees" />
      </el-form-item>
    </template>

    <!-- mock-only fields -->
    <template v-else>
      <el-form-item label="Concurrency limit">
        <el-input-number v-model="form.concurrency_limit" :min="1" data-test="executor-concurrency" />
      </el-form-item>
    </template>

    <el-alert v-if="generalError" type="error" :closable="false" data-test="executor-error">
      {{ generalError }}
    </el-alert>
  </el-form>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.executor-form {
  max-width: 640px;
}
.two-col {
  display: flex;
  gap: $space-lg;
}
.two-col > * {
  flex: 1;
}
</style>
