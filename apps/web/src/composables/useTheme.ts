import { useColorMode } from '@vueuse/core';

/**
 * Theme preference for the whole app: 'light' | 'dark' | 'auto' (follows the
 * OS via prefers-color-scheme). Element Plus switches its --el-* palette off
 * the `dark` class on <html>, which useColorMode manages.
 *
 * The choice is a device-level setting persisted to localStorage; the
 * pre-hydration script in index.html reads the same key to avoid a light
 * flash before Vue mounts. Keep the key and the auto-resolution logic in
 * both places in sync.
 */
export type ThemeMode = 'light' | 'dark' | 'auto';

export const THEME_STORAGE_KEY = 'brigadir-theme';

// Module-level singleton so Settings and the App.vue bootstrap share one ref.
const mode = useColorMode({
  selector: 'html',
  attribute: 'class',
  storageKey: THEME_STORAGE_KEY,
  emitAuto: true,
});

export function useTheme() {
  return { mode };
}
