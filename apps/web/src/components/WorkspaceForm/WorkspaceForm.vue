<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import type { ErrorIssue, VerifyResponse, WorkspaceRepository } from '@brigadir/contracts';
import { useVerifyWorkspace, useCreateWorkspace } from '../../composables/useWorkspaces';
import { ApiError } from '../../api/client';
import { defaultExpiry } from '../../utils/date';

// Flat create form (the former multi-step WorkspaceWizard, collapsed to one
// screen). Verify stays an inline action; Create lives in the hosting
// FormDialog footer, so we expose submit()/saving/canSubmit for it to drive.
const emit = defineEmits<{ created: [workspaceId: string, warnings?: ErrorIssue[]] }>();

const form = reactive({
  name: '',
  jira_site_url: '',
  jira_email: '',
  jira_api_token: '',
  board: '',
});

// User-entered expiry defaulting to +1y from today (FR-004). Kept as a Date;
// serialized to a full ISO datetime on submit (the API expects RFC3339).
const expiresAt = ref<Date>(defaultExpiry());

const repositories = ref<WorkspaceRepository[]>([
  { name: '', git_url: '', default_branch: 'main' },
]);

const verify = useVerifyWorkspace();
const create = useCreateWorkspace();

const verifyResult = ref<VerifyResponse | null>(null);
const fieldErrors = reactive<Record<string, string>>({});
const generalError = ref('');

function clearVerifyState() {
  verifyResult.value = null;
  generalError.value = '';
  delete fieldErrors.jira_api_token;
  delete fieldErrors.board;
}

function applyIssues(err: unknown) {
  if (err instanceof ApiError && err.issues.length) {
    for (const issue of err.issues) {
      fieldErrors[String(issue.path[0])] = issue.message;
    }
  } else {
    generalError.value = (err as Error)?.message ?? 'Request failed.';
  }
}

async function runVerify() {
  clearVerifyState();
  try {
    verifyResult.value = await verify.mutateAsync({
      jira_site_url: form.jira_site_url,
      jira_email: form.jira_email,
      jira_api_token: form.jira_api_token,
      board: form.board,
    });
  } catch (err) {
    applyIssues(err);
  }
}

// Create only after a clean Verify surfaced the identity (invariant kept from
// the wizard, which gated the final step behind a successful verify).
const canSubmit = computed(
  () =>
    verifyResult.value !== null &&
    !fieldErrors.jira_api_token &&
    !fieldErrors.board &&
    !!form.name,
);

const saving = computed(() => create.isPending.value);

function addRepository() {
  repositories.value.push({ name: '', git_url: '', default_branch: 'main' });
}

function removeRepository(index: number) {
  repositories.value.splice(index, 1);
}

async function submit() {
  generalError.value = '';
  const repos = repositories.value.filter((r) => r.name && r.git_url && r.default_branch);
  try {
    const ws = await create.mutateAsync({
      name: form.name,
      jira_site_url: form.jira_site_url,
      jira_email: form.jira_email,
      jira_api_token: form.jira_api_token,
      expires_at: expiresAt.value.toISOString(),
      board: form.board,
      repositories: repos,
    });
    emit('created', ws.id, ws.warnings);
  } catch (err) {
    applyIssues(err);
  }
}

defineExpose({ submit, saving, canSubmit });
</script>

<template>
  <el-form label-position="top" class="workspace-form">
    <el-form-item label="Workspace name">
      <el-input v-model="form.name" data-test="name-input" placeholder="Acme" />
    </el-form-item>

    <el-divider content-position="left">Jira connection</el-divider>

    <el-form-item label="Jira site URL">
      <el-input
        v-model="form.jira_site_url"
        data-test="site-url-input"
        placeholder="https://acme.atlassian.net"
      />
    </el-form-item>
    <el-form-item label="Bot email">
      <el-input v-model="form.jira_email" data-test="email-input" placeholder="bot@acme.com" />
    </el-form-item>
    <el-form-item label="API token" :error="fieldErrors.jira_api_token">
      <el-input
        v-model="form.jira_api_token"
        type="password"
        data-test="token-input"
        @input="clearVerifyState"
      />
      <div v-if="fieldErrors.jira_api_token" class="field-error" data-test="token-error">
        {{ fieldErrors.jira_api_token }}
      </div>
      <div class="hint">
        Create a token at <strong>id.atlassian.com → Security → API tokens</strong>.
      </div>
    </el-form-item>
    <el-form-item label="Token expiry">
      <el-date-picker
        v-model="expiresAt"
        type="date"
        data-test="expires-input"
        placeholder="Expiry date"
      />
      <div class="hint">
        Atlassian exposes no expiry via API — copy the date you set (default: +1 year).
      </div>
    </el-form-item>
    <el-form-item label="Board (id or URL)" :error="fieldErrors.board">
      <el-input
        v-model="form.board"
        data-test="board-input"
        placeholder="42 or a RapidBoard URL"
        @input="clearVerifyState"
      />
      <div v-if="fieldErrors.board" class="field-error" data-test="board-error">
        {{ fieldErrors.board }}
      </div>
    </el-form-item>

    <el-button data-test="verify-button" :loading="verify.isPending.value" @click="runVerify">
      Verify
    </el-button>

    <el-alert
      v-if="verifyResult"
      type="success"
      :closable="false"
      data-test="verify-identity"
      class="verify-identity"
    >
      Connected as <strong>{{ verifyResult.bot_display_name }}</strong> · project
      <strong>{{ verifyResult.project_key }}</strong> · {{ verifyResult.board_type }} board
    </el-alert>

    <el-divider content-position="left">Repositories (first = default)</el-divider>

    <div
      v-for="(repo, i) in repositories"
      :key="i"
      class="repo-row"
      :data-test="`repo-row-${i}`"
    >
      <el-input v-model="repo.name" placeholder="name" :data-test="`repo-name-${i}`" />
      <el-input v-model="repo.git_url" placeholder="git@…" :data-test="`repo-url-${i}`" />
      <el-input v-model="repo.default_branch" placeholder="main" :data-test="`repo-branch-${i}`" />
      <el-button
        v-if="repositories.length > 1"
        link
        type="danger"
        :data-test="`repo-remove-${i}`"
        @click="removeRepository(i)"
      >
        Remove
      </el-button>
    </div>
    <el-button data-test="add-repo" @click="addRepository">Add repository</el-button>

    <el-alert v-if="generalError" type="error" :closable="false" data-test="general-error">
      {{ generalError }}
    </el-alert>
  </el-form>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: $space-xs;
}
.field-error {
  font-size: 12px;
  color: var(--el-color-danger);
  margin-top: $space-xs;
}
.verify-identity {
  margin-top: $space-md;
}
.repo-row {
  display: flex;
  gap: $space-sm;
  align-items: center;
  margin-bottom: $space-sm;
}
</style>
