<script setup lang="ts">
import { computed, ref } from 'vue';
import { RouterView } from 'vue-router';
import { useAuthStore } from './stores/auth';
import { useChannelHealth } from './composables/useChannelHealth';
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

// Feature 027 (US4): channel-health агрегат для индикатора в сайдбаре — тот же
// паттерн, что openCount: query здесь, сайдбар остаётся презентационным.
const channelHealthQuery = useChannelHealth(authed);
const channelHealth = computed(() => channelHealthQuery.data.value ?? null);

// The 006 one-shot `/` → `/human-queue` landing redirect is gone (feature 017):
// `/` now lands on /home, whose hero widget IS the "does the system need me"
// answer — bouncing past it would defeat the landing page.
</script>

<template>
  <div v-if="!auth.token" class="token-gate">
    <div class="token-form">
      <span class="brand-wordmark"><img src="/logo_inline.svg" alt="" class="brand-logo" /> BRIGADIR</span>
      <p>Enter the dashboard access token to continue.</p>
      <el-input
        v-model="tokenInput"
        type="password"
        placeholder="Dashboard token"
        data-test="token-input"
        @keyup.enter="saveToken"
      />
      <el-button type="primary" data-test="token-submit" @click="saveToken"> Continue </el-button>
    </div>
  </div>

  <div v-else class="app-shell">
    <AppSidebar :open-count="openCount" :channel-health="channelHealth" @sign-out="auth.clear()" />
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
  align-items: center;
  min-height: 100vh;
}
// No card wrapper — the form sits bare, centred on the page.
.token-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 360px;

  p {
    margin: 0;
  }
  // Extra breathing room above the primary action, beyond the 12px column gap.
  .el-button {
    margin-top: 12px;
  }
}
// The `BRIGADIR` wordmark: monospace, with the amber inline logo mark ahead of it.
.brand-wordmark {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: $font-family-mono;
  font-weight: $font-weight-bold;
  font-size: 18px;
  letter-spacing: 0.04em;
}
.brand-logo {
  height: 1.4em;
  width: auto;
}
// The sidebar is `position: fixed` at 70px; offset the main region by exactly the
// rail width so nothing renders under it (research R5 / SC-006).
.app-main {
  margin-left: 70px;
  padding: $space-lg;
}
</style>
