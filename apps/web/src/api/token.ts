/**
 * Dashboard bearer token — provided at RUNTIME, never baked into the build
 * output (research R1 / Constitution V). Resolution order:
 *   1. a runtime global the host page may inject (`window.__BRIGADIR_DASHBOARD_TOKEN__`)
 *   2. sessionStorage (set by the in-app token gate)
 * There is deliberately no compile-time env var — `grep dist` for the token
 * (T157) must never find it.
 */
const STORAGE_KEY = 'brigadir.dashboardToken';

interface RuntimeWindow {
  __BRIGADIR_DASHBOARD_TOKEN__?: string;
}

export function getDashboardToken(): string {
  const injected = (globalThis as unknown as RuntimeWindow).__BRIGADIR_DASHBOARD_TOKEN__;
  if (injected) return injected;
  try {
    return sessionStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setDashboardToken(token: string): void {
  sessionStorage.setItem(STORAGE_KEY, token);
}

export function clearDashboardToken(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}

export function hasDashboardToken(): boolean {
  return getDashboardToken().length > 0;
}
