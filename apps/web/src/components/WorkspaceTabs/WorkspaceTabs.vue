<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { TabPaneName } from 'element-plus';

/**
 * Shared, reusable router-driven tab strip (FR-013). The active tab is derived
 * from the current route name — the URL is the single source of truth (FR-008),
 * there is no internal mutable active-tab state. Selecting a tab pushes the named
 * route; the route change is what flips the active tab.
 */
const props = defineProps<{
  id: string;
  tabs: { name: string; label: string }[];
}>();

const route = useRoute();
const router = useRouter();

// The active tab is the route name, EXCEPT a route may pin itself to a parent
// tab via `meta.tab` — feature 031: the settings sub-routes (settings-general,
// settings-environment, …) all set `meta.tab: 'settings'` so the Settings tab
// stays highlighted on any settings sub-page.
const active = computed<string>(
  () =>
    (route.meta.tab as string | undefined) ??
    (route.name as string | undefined) ??
    props.tabs[0]?.name ??
    '',
);

function onTabChange(name: TabPaneName): void {
  router.push({ name: String(name), params: { id: props.id } });
}
</script>

<template>
  <el-tabs
    :model-value="active"
    class="workspace-tabs"
    data-test="workspace-tabs"
    @tab-change="onTabChange"
  >
    <el-tab-pane v-for="tab in tabs" :key="tab.name" :name="tab.name">
      <template #label>
        <span :data-test="`workspace-tab-${tab.name}`">{{ tab.label }}</span>
      </template>
    </el-tab-pane>
  </el-tabs>
</template>

<style scoped lang="scss">
.workspace-tabs {
  margin-bottom: 8px;
}
</style>
