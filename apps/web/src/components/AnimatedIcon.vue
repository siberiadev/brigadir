<script setup lang="ts">
/**
 * Generic hover animation for ANY lucide (or other inline-SVG) icon placed in
 * the default slot — the whole-icon tier of our two-tier icon-animation
 * convention (CLAUDE.md "UI-конвенции"):
 *
 *  - WHOLE-ICON effects (this wrapper): glyph-agnostic transforms of the full
 *    SVG — pick one via the `effect` prop. Works for any icon, zero CSS.
 *  - PER-PART effects (bespoke): animating individual paths (grid tiles
 *    popping, an arrow sliding out of a door) depends on the glyph's SVG
 *    anatomy and stays hand-written CSS at the usage site — see
 *    AppSidebar.vue for reference implementations.
 *
 * Trigger: the effect fires when the wrapper itself is hovered OR when the
 * nearest ancestor carrying the `anim-trigger` class is (so a 44px button can
 * trigger its 22px icon). Honors prefers-reduced-motion.
 */
withDefaults(
  defineProps<{
    /**
     * All effects are ONE-SHOT on hover entry and end exactly where they
     * started — nothing plays on unhover. (spin was transition-based at first
     * and rotated BACK after the cursor left: a delayed, spooky reverse spin
     * "at the end" — reported as a bug 2026-07-14. A full 360° one-shot ends
     * identical to its start, so there is nothing to reverse.)
     *
     * spin   — one full 360° turn (gears, loaders, refresh)
     * dip    — downward bounce (inboxes, downloads)
     * pop    — scale pulse (default; fits anything)
     * wiggle — ±8° shake (bells, alerts)
     */
    effect?: 'spin' | 'dip' | 'pop' | 'wiggle';
  }>(),
  { effect: 'pop' },
);
</script>

<template>
  <span class="animated-icon" :class="`animated-icon--${effect}`" data-test="animated-icon">
    <slot />
  </span>
</template>

<style scoped lang="scss">
.animated-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;

  :deep(svg) {
    transform-box: view-box;
    transform-origin: center;
  }
}

// Every effect is a one-shot keyframe animation triggered on hover entry;
// fill-mode stays `none` and every keyframe track ends at its 0% value, so an
// animation that finishes leaves NO residual transform and unhover plays
// nothing. Never use a transition-to-hover-state here: it animates BACK when
// the hover ends — a delayed reverse motion long after the user moved on.
@keyframes ai-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.animated-icon--spin:hover :deep(svg),
:global(.anim-trigger:hover) .animated-icon--spin :deep(svg) {
  animation: ai-spin 0.6s cubic-bezier(0.4, 0, 0.2, 1);
}

@keyframes ai-dip {
  0% { transform: translateY(0); }
  45% { transform: translateY(2.5px); }
  100% { transform: translateY(0); }
}
.animated-icon--dip:hover :deep(svg),
:global(.anim-trigger:hover) .animated-icon--dip :deep(svg) {
  animation: ai-dip 0.4s ease;
}

@keyframes ai-pop {
  0% { transform: scale(1); }
  40% { transform: scale(0.82); }
  100% { transform: scale(1); }
}
.animated-icon--pop:hover :deep(svg),
:global(.anim-trigger:hover) .animated-icon--pop :deep(svg) {
  animation: ai-pop 0.35s ease;
}

@keyframes ai-wiggle {
  0% { transform: rotate(0); }
  25% { transform: rotate(-8deg); }
  60% { transform: rotate(8deg); }
  100% { transform: rotate(0); }
}
.animated-icon--wiggle:hover :deep(svg),
:global(.anim-trigger:hover) .animated-icon--wiggle :deep(svg) {
  animation: ai-wiggle 0.4s ease;
}

@media (prefers-reduced-motion: reduce) {
  .animated-icon :deep(svg) {
    animation: none !important;
    transition: none !important;
  }
}
</style>
