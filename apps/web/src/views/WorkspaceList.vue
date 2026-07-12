<script setup lang="ts">
import { RouterLink } from 'vue-router';
import { useWorkspaces } from '../composables/useWorkspaces';
import CredentialBadge from '../components/CredentialBadge.vue';

const { data: workspaces, isLoading, isError, error } = useWorkspaces();
</script>

<template>
  <section>
    <div class="header-row">
      <h2>Workspaces</h2>
      <RouterLink to="/workspaces/new">
        <el-button type="primary" data-test="new-workspace">New workspace</el-button>
      </RouterLink>
    </div>

    <el-alert v-if="isError" type="error" :closable="false" data-test="workspaces-error">
      {{ (error as Error)?.message ?? 'Failed to load workspaces.' }}
    </el-alert>

    <el-table v-else v-loading="isLoading" :data="workspaces ?? []" data-test="workspaces-table">
      <el-table-column prop="name" label="Name" />
      <el-table-column prop="project_key" label="Project" />
      <el-table-column prop="board_type" label="Board" />
      <el-table-column label="Credentials">
        <template #default="{ row }">
          <CredentialBadge :status="row.credential_status" />
        </template>
      </el-table-column>
      <el-table-column label="">
        <template #default="{ row }">
          <RouterLink :to="`/workspaces/${row.id}/agents`">
            <el-button link type="primary">Agents</el-button>
          </RouterLink>
          <RouterLink :to="`/workspaces/${row.id}/settings`">
            <el-button link type="primary">Settings</el-button>
          </RouterLink>
        </template>
      </el-table-column>
    </el-table>
  </section>
</template>

<style scoped>
.header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
</style>
