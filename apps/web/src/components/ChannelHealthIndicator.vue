<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { Activity } from 'lucide-vue-next';
import type { ChannelHealthResponse } from '@brigadir/contracts';

/**
 * Компактный индикатор здоровья callback-канала (feature 027, US4 / FR-013).
 * PURE presentational — данные приходят пропом (query живёт в App.vue, как
 * openCount). Здоровый — приглушённая статичная иконка; degraded — danger-токен
 * + точка-бейдж. Клик открывает поповер: последний успешный callback, оконные
 * счётчики, вердикт deployment guard'а и затронутые прогоны со ссылками.
 * Иконка статичная (hover-анимация — только у пунктов меню; это state-индикатор,
 * как пульс RunStatusTag). Палитра — только через --el-color-* токены.
 */
const props = defineProps<{ health: ChannelHealthResponse | null }>();

const degraded = computed(() => props.health?.status === 'degraded');

const lastSuccess = computed(() => {
  const at = props.health?.last_successful_callback_at;
  return at ? new Date(at).toLocaleString() : '—';
});

const windowMinutes = computed(() =>
  props.health ? Math.round(props.health.window_ms / 60_000) : null,
);

const guardLabel = computed(() => {
  const guard = props.health?.deployment_guard;
  if (!guard) return '—';
  if (guard.ok) return 'ok';
  return guard.reason === 'missing' ? 'artifact missing' : 'artifact stale';
});

/** Cap — часть контракта: при заполненном списке подписываем «top 20». */
const atCap = computed(() => (props.health?.affected_runs.length ?? 0) >= 20);
</script>

<template>
  <el-popover placement="right" :width="300" trigger="click">
    <template #reference>
      <button
        type="button"
        class="indicator nav-item"
        :class="{ 'is-degraded': degraded }"
        data-test="channel-health-indicator"
        :title="degraded ? 'Callback channel: degraded' : 'Callback channel: healthy'"
      >
        <Activity class="nav-icon" />
        <span v-if="degraded" class="dot" data-test="channel-health-dot" />
      </button>
    </template>

    <div class="popover" data-test="channel-health-popover">
      <p class="status-line">
        Callback channel:
        <strong :class="degraded ? 'text-degraded' : 'text-healthy'" data-test="channel-health-status">
          {{ degraded ? 'degraded' : 'healthy' }}
        </strong>
        <span v-if="windowMinutes" class="muted">(window {{ windowMinutes }} min)</span>
      </p>
      <template v-if="health">
        <dl class="facts">
          <dt>last successful callback</dt>
          <dd data-test="channel-health-last-success">{{ lastSuccess }}</dd>
          <dt>delivery failures in window</dt>
          <dd data-test="channel-health-failures">{{ health.channel_failures_in_window }}</dd>
          <dt>pre-flight probe failures</dt>
          <dd data-test="channel-health-probes">{{ health.probe_failures_in_window }}</dd>
          <dt>deployment guard</dt>
          <dd data-test="channel-health-guard">{{ guardLabel }}</dd>
        </dl>
        <template v-if="health.affected_runs.length > 0">
          <p class="affected-title">
            Affected runs<span v-if="atCap" class="muted"> (top 20)</span>:
          </p>
          <ul class="affected">
            <li v-for="run in health.affected_runs" :key="run.run_id">
              <RouterLink :to="`/runs/${run.run_id}`" :data-test="`channel-health-run-${run.run_id}`">
                {{ run.ticket_key ?? run.run_id.slice(0, 8) }}
              </RouterLink>
              <span class="muted">{{ new Date(run.last_event_at).toLocaleTimeString() }}</span>
            </li>
          </ul>
        </template>
      </template>
      <p v-else class="muted">No data (aggregate not loaded yet).</p>
    </div>
  </el-popover>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.indicator {
  position: relative;
  background: none;
  border: none;
  cursor: pointer;

  &.is-degraded .nav-icon {
    color: var(--el-color-danger);
  }
}

.dot {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--el-color-danger);
}

.popover {
  font-size: 12px;

  .status-line {
    margin: 0 0 $space-xs;
  }
  .text-degraded {
    color: var(--el-color-danger);
  }
  .text-healthy {
    color: var(--el-color-success);
  }
  .muted {
    color: var(--el-text-color-secondary);
  }

  .facts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px $space-sm;
    margin: 0 0 $space-xs;

    dt {
      color: var(--el-text-color-secondary);
    }
    dd {
      margin: 0;
    }
  }

  .affected-title {
    margin: 0 0 2px;
  }
  .affected {
    margin: 0;
    padding: 0;
    list-style: none;

    li {
      display: flex;
      justify-content: space-between;
      gap: $space-sm;
    }
  }
}
</style>
