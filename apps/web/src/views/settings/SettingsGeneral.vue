<script setup lang="ts">
import { useTheme } from '../../composables/useTheme';

/**
 * General panel of the platform Settings page. Since feature 015 it holds only
 * the Theme control — both brigadir instruction texts moved to the "Brigadir
 * agent" section (SettingsBrigadirAgent.vue) together with the orchestrator
 * template. Theme is a device-level preference (localStorage via useTheme),
 * applied instantly — nothing on this panel round-trips to the server.
 */
const { mode: themeMode } = useTheme();
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
</style>
