import { onMounted, onUnmounted, ref, type Ref } from 'vue';

/**
 * A reactive clock ticking every `intervalMs` (default 1 s) — drives the live
 * Duration counter on `running` runs (Runs table + RunCard header). Component
 * lifecycle owns the interval; no @vueuse dependency for a single ref.
 */
export function useNow(intervalMs = 1000): Ref<Date> {
  const now = ref(new Date());
  let timer: ReturnType<typeof setInterval> | undefined;
  onMounted(() => {
    timer = setInterval(() => {
      now.value = new Date();
    }, intervalMs);
  });
  onUnmounted(() => clearInterval(timer));
  return now;
}
