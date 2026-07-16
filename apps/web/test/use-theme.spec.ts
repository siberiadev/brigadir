import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { nextTick } from 'vue';

/**
 * Theme composable (dark theme, 2026-07-16): a module-level useColorMode
 * singleton drives the `dark`/`light` class on <html> and persists the choice
 * ('light' | 'dark' | 'auto') to localStorage under THEME_STORAGE_KEY.
 *
 * jsdom has no matchMedia, so a controllable stub is installed BEFORE the
 * composable module is imported (the singleton captures prefers-color-scheme
 * support at creation time).
 */

type MediaListener = (e: { matches: boolean }) => void;
const listeners = new Set<MediaListener>();
let prefersDark = false;

let useTheme: typeof import('../src/composables/useTheme').useTheme;
let THEME_STORAGE_KEY: string;

beforeAll(async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query.includes('dark') ? prefersDark : !prefersDark;
    },
    media: query,
    addEventListener: (_type: string, cb: MediaListener) => listeners.add(cb),
    removeEventListener: (_type: string, cb: MediaListener) => listeners.delete(cb),
    dispatchEvent: () => true,
  }));
  ({ useTheme, THEME_STORAGE_KEY } = await import('../src/composables/useTheme'));
});

/** Flip the stubbed OS preference and notify media-query listeners. */
async function setSystemDark(value: boolean) {
  prefersDark = value;
  listeners.forEach((cb) => cb({ matches: value }));
  await nextTick();
  await nextTick();
}

async function setMode(value: 'light' | 'dark' | 'auto') {
  useTheme().mode.value = value;
  await nextTick();
  await nextTick(); // useColorMode applies the html class in a post-flush watcher
}

beforeEach(async () => {
  await setSystemDark(false);
  await setMode('auto');
  localStorage.removeItem(THEME_STORAGE_KEY);
});

describe('useTheme', () => {
  it('defaults to auto and resolves to light when the OS is light', () => {
    expect(useTheme().mode.value).toBe('auto');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });

  it('dark: adds html.dark and persists to localStorage', async () => {
    await setMode('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('light: removes html.dark and persists to localStorage', async () => {
    await setMode('dark');
    await setMode('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('auto: follows prefers-color-scheme changes', async () => {
    await setMode('dark'); // leave 'auto' first so switching back writes storage
    await setMode('auto');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('auto');
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    await setSystemDark(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    await setSystemDark(false);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
