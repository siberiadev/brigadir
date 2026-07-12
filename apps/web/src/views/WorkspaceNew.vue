<script setup lang="ts">
import { useRouter } from 'vue-router';
import WorkspaceWizard from '../components/WorkspaceWizard/WorkspaceWizard.vue';

const router = useRouter();

function onDone(workspaceId: string) {
  // Give the operator a moment on the completion step, then route to agents.
  setTimeout(() => router.push(`/workspaces/${workspaceId}/agents`), 1200);
}
</script>

<template>
  <section>
    <h2>New workspace</h2>
    <WorkspaceWizard @done="onDone" />
  </section>
</template>
