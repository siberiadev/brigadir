<script setup lang="ts">
import { ref } from 'vue';
import { RouterLink, RouterView } from 'vue-router';
import { useAuthStore } from './stores/auth';

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

  <el-container v-else class="app-shell">
    <el-header class="app-header">
      <span class="brand">BRIGADIR</span>
      <nav class="app-nav">
        <RouterLink to="/">Workspaces</RouterLink>
        <RouterLink to="/runs">Runs</RouterLink>
        <RouterLink to="/human-queue">Human queue</RouterLink>
      </nav>
      <el-button link type="info" @click="auth.clear()">Sign out</el-button>
    </el-header>
    <el-main>
      <RouterView />
    </el-main>
  </el-container>
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
.app-header {
  display: flex;
  align-items: center;
  gap: 24px;
  border-bottom: 1px solid var(--el-border-color);
}
.brand {
  font-weight: $font-weight-bold;
}
.app-nav {
  display: flex;
  gap: 16px;
  flex: 1;
}
</style>
