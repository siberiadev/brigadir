<script setup lang="ts">
import { computed } from 'vue';
import type { CredentialStatus } from '@brigadir/contracts';

// Expiry badge (FR-021). State is server-derived (`credential_status`) so the
// client never recomputes the threshold — it only maps state → label/colour.
const props = defineProps<{ status: CredentialStatus }>();

const meta = computed(() => {
  switch (props.status) {
    case 'expired':
      return { type: 'danger' as const, label: 'Token expired' };
    case 'warn_7':
      return { type: 'danger' as const, label: 'Expires ≤ 7 days' };
    case 'warn_30':
      return { type: 'warning' as const, label: 'Expires ≤ 30 days' };
    default:
      return { type: 'success' as const, label: 'Token OK' };
  }
});
</script>

<template>
  <el-tag :type="meta.type" data-test="credential-badge" :data-status="status">{{ meta.label }}</el-tag>
</template>
