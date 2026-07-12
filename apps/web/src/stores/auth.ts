import { defineStore } from 'pinia';
import { ref } from 'vue';
import { getDashboardToken, setDashboardToken, clearDashboardToken } from '../api/token';

/**
 * Holds the runtime dashboard bearer token (never baked into the build). The
 * token gate in App.vue writes it here; the api client reads it from
 * sessionStorage via {@link getDashboardToken}.
 */
export const useAuthStore = defineStore('auth', () => {
  const token = ref(getDashboardToken());

  function setToken(value: string) {
    setDashboardToken(value);
    token.value = value;
  }

  function clear() {
    clearDashboardToken();
    token.value = '';
  }

  return { token, setToken, clear };
});
