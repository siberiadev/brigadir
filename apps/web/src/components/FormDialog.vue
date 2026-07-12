<script setup lang="ts">
// Shared modal wrapper for every create/edit form, so all dialogs behave and
// look the same: title + close "X" in the header, an optional footer for
// Cancel/Submit, and NO close on an outside click (only the X, ESC, or an
// explicit footer button dismisses it).
//
// The dialog is teleported to <body> (append-to-body), so a footer rendered
// here lands outside the form component's own subtree — form bodies stay
// dialog-agnostic and expose an imperative submit() the parent wires up.
withDefaults(
  defineProps<{
    modelValue: boolean;
    title: string;
    width?: string | number;
  }>(),
  { width: '640px' },
);

defineEmits<{ 'update:modelValue': [value: boolean] }>();
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="title"
    :width="width"
    :close-on-click-modal="false"
    append-to-body
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <slot />
    <template v-if="$slots.footer" #footer>
      <slot name="footer" />
    </template>
  </el-dialog>
</template>
