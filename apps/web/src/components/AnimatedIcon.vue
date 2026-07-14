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
     * spin   — turns 120° while hovered, turns back on leave (gears, loaders)
     * dip    — one-shot downward bounce (inboxes, downloads)
     * pop    — one-shot scale pulse (default; fits anything)
     * wiggle — one-shot ±8° shake (bells, alerts)
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

// spin is transition-based (reverses smoothly on unhover); the one-shot
// effects are keyframe animations that restart on each hover entry.
.animated-icon--spin :deep(svg) {
  transition: transform 0.45s cubic-bezier(0.4, 0, 0.2, 1);
}
.animated-icon--spin:hover :deep(svg),
:global(.anim-trigger:hover) .animated-icon--spin :deep(svg) {
  transform: rotate(120deg);
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
