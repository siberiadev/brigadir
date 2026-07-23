<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useTheme } from '../../composables/useTheme';
import {
  useAgentInstructionsSettings,
  useUpdateAgentInstructionsSettings,
} from '../../composables/useAgentInstructionsSettings';
import type { AgentInstructionsGlobalUpdate } from '@brigadir/contracts';

/**
 * General panel of the platform Settings page: the Theme control (device-level,
 * feature 015) plus the GLOBAL agent role-template source (feature 030) — the
 * git repo brigadir draws role templates from when it assembles a team. Absent
 * ⇒ built-in defaults. A per-workspace override lives on the workspace's own
 * Settings tab. The token is write-only: only "stored / none" is shown.
 */
const { mode: themeMode } = useTheme();

const query = useAgentInstructionsSettings();
const update = useUpdateAgentInstructionsSettings();

const gitUrl = ref('');
const gitRef = ref('');
const subdir = ref('');
const token = ref('');

const hasToken = computed(() => query.data.value?.has_token === true);

// Seed the form from the stored source whenever it (re)loads. Token stays empty
// (write-only) — the field is a "replace" box, not the current value.
watch(
  () => query.data.value,
  (s) => {
    gitUrl.value = s?.source?.git_url ?? '';
    gitRef.value = s?.source?.git_ref ?? '';
    subdir.value = s?.source?.subdir ?? '';
  },
  { immediate: true },
);

function save() {
  const url = gitUrl.value.trim();
  const body: AgentInstructionsGlobalUpdate = {
    source: url
      ? {
          git_url: url,
          ...(gitRef.value.trim() ? { git_ref: gitRef.value.trim() } : {}),
          ...(subdir.value.trim() ? { subdir: subdir.value.trim() } : {}),
        }
      : null,
    // Only send the token when the operator typed one (absent = keep).
    ...(token.value ? { token: token.value } : {}),
  };
  update.mutate(body, {
    onSuccess: () => {
      token.value = '';
      ElMessage.success('Template source saved — effective on the next team generation.');
    },
    onError: () => ElMessage.error('Could not save the template source.'),
  });
}

function resetToBuiltin() {
  update.mutate(
    { source: null },
    {
      onSuccess: () => ElMessage.success('Reset to built-in defaults.'),
      onError: () => ElMessage.error('Could not reset the template source.'),
    },
  );
}

function clearToken() {
  update.mutate(
    { token: null },
    {
      onSuccess: () => ElMessage.success('Token cleared.'),
      onError: () => ElMessage.error('Could not clear the token.'),
    },
  );
}
</script>

<template>
  <div class="settings-general">
    <h3>General</h3>

    <label class="field-label">Theme</label>
    <p class="hint">Applies immediately on this device. “System” follows the OS setting.</p>
    <el-radio-group v-model="themeMode" size="small" data-test="theme-mode">
      <el-radio-button value="light" data-test="theme-mode-light">Light</el-radio-button>
      <el-radio-button value="dark" data-test="theme-mode-dark">Dark</el-radio-button>
      <el-radio-button value="auto" data-test="theme-mode-auto">System</el-radio-button>
    </el-radio-group>

    <el-divider />

    <h4>Agent instruction templates</h4>
    <p class="hint">
      A git repository of per-role instruction templates (<code>roles/&lt;role&gt;.md</code>)
      brigadir adapts when it builds a team. Leave empty to use the built-in defaults. A
      workspace can override this on its own Settings tab.
    </p>

    <el-form label-position="top" class="ai-form" @submit.prevent>
      <el-form-item label="Repository URL">
        <el-input
          v-model="gitUrl"
          placeholder="git@github.com:acme/agents.git  (empty = built-in defaults)"
          data-test="ai-git-url"
        />
      </el-form-item>
      <div class="ai-row">
        <el-form-item label="Branch / tag / ref (optional)" class="ai-col">
          <el-input v-model="gitRef" placeholder="main" data-test="ai-git-ref" />
        </el-form-item>
        <el-form-item label="Subfolder (optional)" class="ai-col">
          <el-input v-model="subdir" placeholder="roles" data-test="ai-subdir" />
        </el-form-item>
      </div>
      <el-form-item label="Access token (private repos only)">
        <el-input
          v-model="token"
          type="password"
          show-password
          :placeholder="hasToken ? '•••••••• stored — type to replace' : 'none stored'"
          data-test="ai-token"
        />
        <div class="token-actions">
          <span class="token-state" data-test="ai-token-state">
            {{ hasToken ? 'Token stored' : 'No token' }}
          </span>
          <el-button
            v-if="hasToken"
            link
            type="danger"
            size="small"
            data-test="ai-clear-token"
            @click="clearToken"
          >
            Clear token
          </el-button>
        </div>
      </el-form-item>
      <div class="ai-actions">
        <el-button type="primary" :loading="update.isPending.value" data-test="ai-save" @click="save">
          Save
        </el-button>
        <el-button data-test="ai-reset" @click="resetToBuiltin">Reset to built-in defaults</el-button>
      </div>
    </el-form>
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
.ai-form {
  margin-top: $space-sm;
}
.ai-row {
  display: flex;
  gap: $space-md;
}
.ai-col {
  flex: 1;
}
.token-actions {
  display: flex;
  align-items: center;
  gap: $space-md;
  margin-top: $space-xs;
}
.token-state {
  color: var(--el-text-color-secondary);
  font-size: 0.85em;
}
.ai-actions {
  display: flex;
  gap: $space-sm;
}
</style>
