<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import type { VerifyResponse, WorkspaceRepository } from '@brigadir/contracts';
import { useVerifyWorkspace, useCreateWorkspace } from '../../composables/useWorkspaces';
import { ApiError } from '../../api/client';
import { defaultExpiry } from '../../utils/date';

const emit = defineEmits<{ done: [workspaceId: string] }>();

// 0 name · 1 connection+verify · 2 repositories · 3 completion (FR-004).
const active = ref(0);

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
const createdId = ref('');

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

// Step 2 only advances once Verify has surfaced identity with no field errors.
const canAdvanceConnection = computed(
  () => verifyResult.value !== null && !fieldErrors.jira_api_token && !fieldErrors.board,
);

function next() {
  if (active.value === 1 && !canAdvanceConnection.value) return;
  active.value += 1;
}

function back() {
  if (active.value > 0) active.value -= 1;
}

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
    createdId.value = ws.id;
    active.value = 3;
    emit('done', ws.id);
  } catch (err) {
    applyIssues(err);
  }
}
</script>

<template>
  <div class="wizard">
    <el-steps :active="active" finish-status="success" align-center>
      <el-step title="Name" />
      <el-step title="Jira connection" />
      <el-step title="Repositories" />
      <el-step title="Done" />
    </el-steps>

    <!-- Step 1: name -->
    <div v-if="active === 0" class="step">
      <el-form label-position="top">
        <el-form-item label="Workspace name">
          <el-input v-model="form.name" data-test="name-input" placeholder="Acme" />
        </el-form-item>
      </el-form>
      <el-button type="primary" data-test="next-button" :disabled="!form.name" @click="next">
        Next
      </el-button>
    </div>

    <!-- Step 2: Jira connection + Verify -->
    <div v-else-if="active === 1" class="step">
      <el-form label-position="top">
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
        <el-form-item label="Token expiry" :error="undefined">
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
      </el-form>

      <el-button
        data-test="verify-button"
        :loading="verify.isPending.value"
        @click="runVerify"
      >
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

      <el-alert
        v-if="generalError"
        type="error"
        :closable="false"
        data-test="general-error"
      >
        {{ generalError }}
      </el-alert>

      <div class="nav">
        <el-button data-test="back-button" @click="back">Back</el-button>
        <el-button
          type="primary"
          data-test="next-button"
          :disabled="!canAdvanceConnection"
          @click="next"
        >
          Next
        </el-button>
      </div>
    </div>

    <!-- Step 3: repositories (first = default) -->
    <div v-else-if="active === 2" class="step">
      <p class="hint">The first repository is the default agents inherit.</p>
      <div
        v-for="(repo, i) in repositories"
        :key="i"
        class="repo-row"
        :data-test="`repo-row-${i}`"
      >
        <el-input v-model="repo.name" placeholder="name" :data-test="`repo-name-${i}`" />
        <el-input v-model="repo.git_url" placeholder="git@…" :data-test="`repo-url-${i}`" />
        <el-input
          v-model="repo.default_branch"
          placeholder="main"
          :data-test="`repo-branch-${i}`"
        />
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

      <div class="nav">
        <el-button data-test="back-button" @click="back">Back</el-button>
        <el-button
          type="primary"
          data-test="create-button"
          :loading="create.isPending.value"
          @click="submit"
        >
          Create workspace
        </el-button>
      </div>
    </div>

    <!-- Step 4: completion -->
    <div v-else class="step">
      <el-result
        icon="success"
        title="Workspace created"
        :sub-title="`Workspace ${createdId} is ready.`"
        data-test="completion"
      />
    </div>
  </div>
</template>

<style scoped>
.step {
  margin-top: 24px;
  max-width: 520px;
}
.hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 4px;
}
.field-error {
  font-size: 12px;
  color: var(--el-color-danger);
  margin-top: 4px;
}
.verify-identity {
  margin-top: 12px;
}
.nav {
  margin-top: 20px;
  display: flex;
  gap: 12px;
}
.repo-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}
</style>
