<script setup lang="ts">
/**
 * The /home landing dashboard (feature 017). Block hierarchy per the mock
 * (docs/mockups/home-dashboard.html): tiles row → hero + needs-attention |
 * live runs + spend columns → workspace grid. Exactly four polled sources for
 * the page (summary, global runs ×2, home-workspaces) plus the hero reusing
 * the open human-tasks query; each block degrades independently (FR-024).
 *
 * The summary query lives HERE (not in StatTiles/SpendCard) so the tiles and
 * the spend block provably render from the same atomic response (FR-010).
 */
import StatTiles from '../components/Home/StatTiles.vue';
import HumanQueueHero from '../components/Home/HumanQueueHero.vue';
import NeedsAttentionList from '../components/Home/NeedsAttentionList.vue';
import LiveRunsList from '../components/Home/LiveRunsList.vue';
import SpendCard from '../components/Home/SpendCard.vue';
import WorkspaceCardsGrid from '../components/Home/WorkspaceCardsGrid.vue';
import { useHomeSummary } from '../composables/useHomeSummary';

const summaryQuery = useHomeSummary();
</script>

<template>
  <section class="home" data-test="home-page">
    <div class="header-row">
      <h2>Home</h2>
    </div>

    <StatTiles :summary="summaryQuery.data.value" :error="summaryQuery.isError.value" />

    <div class="cols">
      <div class="col">
        <HumanQueueHero />
        <NeedsAttentionList />
      </div>
      <div class="col">
        <LiveRunsList />
        <SpendCard :summary="summaryQuery.data.value" :error="summaryQuery.isError.value" />
      </div>
    </div>

    <WorkspaceCardsGrid />
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.home {
  display: flex;
  flex-direction: column;
  gap: $space-xl;
}
.header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;

  h2 {
    margin: 0;
  }
}
// Hero column slightly wider than the live column, per the mock's hierarchy.
.cols {
  display: grid;
  grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
  gap: $space-xl;
  align-items: start;

  @media (max-width: 1080px) {
    grid-template-columns: 1fr;
  }
}
.col {
  display: flex;
  flex-direction: column;
  gap: $space-xl;
  min-width: 0;
}
</style>
