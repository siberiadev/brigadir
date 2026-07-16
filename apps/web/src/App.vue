<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import { useAuthStore } from './stores/auth';
import { useHumanTaskCount } from './composables/useHumanTasks';
import { useTheme } from './composables/useTheme';
import AppSidebar from './components/AppSidebar.vue';

// Apply the persisted theme (light/dark/auto) from app start, not only after
// the Settings page instantiates the composable.
useTheme();

// Runtime token gate: the shared dashboard bearer is entered here (kept in
// sessionStorage), never compiled into the bundle (research R1 / Constitution V).
const auth = useAuthStore();
const tokenInput = ref('');

function saveToken() {
  if (tokenInput.value.trim()) {
    auth.setToken(tokenInput.value.trim());
    tokenInput.value = '';
  }
}

// Live open-task badge (US1) — polled only once authenticated (no bearer in a URL).
// Passed down to AppSidebar as `openCount`; the query itself STAYS here (FR-014)
// because the 006 landing watch below consumes the same source.
const authed = computed(() => !!auth.token);
const countQuery = useHumanTaskCount(authed);
const openCount = computed(() => countQuery.data.value?.open ?? 0);

// Landing rule (FR-002/FR-005): the FIRST time the count resolves with open > 0
// while sitting on the workspaces root, jump to the queue. One-shot so it never
// fights the operator navigating back to workspaces.
const route = useRoute();
const router = useRouter();
let landingApplied = false;
watch(
  () => countQuery.data.value?.open,
  (open) => {
    if (landingApplied || open == null) return;
    landingApplied = true;
    if (open > 0 && route.path === '/') router.replace('/human-queue');
  },
);
</script>

<template>
  <div v-if="!auth.token" class="token-gate">
    <el-card class="token-card">
      <template #header>BRIGADIR Dashboard</template>
      <p>Enter the dashboard access token to continue.</p>
      <el-input
        v-model="tokenInput"
        type="password"
        placeholder="Dashboard token"
        data-test="token-input"
        @keyup.enter="saveToken"
      />
      <el-button type="primary" data-test="token-submit" style="margin-top: 12px" @click="saveToken">
        Continue
      </el-button>
    </el-card>
  </div>

  <div v-else class="app-shell">
    <AppSidebar :open-count="openCount" @sign-out="auth.clear()" />
    <main class="app-main">
      <RouterView />
    </main>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.token-gate {
  display: flex;
  justify-content: center;
  padding-top: 12vh;
}
.token-card {
  width: 360px;
}
// The sidebar is `position: fixed` at 70px; offset the main region by exactly the
// rail width so nothing renders under it (research R5 / SC-006).
.app-main {
  margin-left: 70px;
  padding: $space-lg;
}
</style>
