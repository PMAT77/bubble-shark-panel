<script setup lang="ts">
import logoImage from '@/assets/images/logo.png'

defineOptions({
  name: 'AppLogoMark',
})

withDefaults(
  defineProps<{
    /** Tailwind 尺寸类，如 `h-[30px] w-[35px]` */
    sizeClass?: string
  }>(),
  {
    sizeClass: 'h-[30px] w-[35px]',
  },
)
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center justify-center"
    :class="sizeClass"
    :style="{ '--brand-logo': `url(${logoImage})` }"
    aria-hidden="true"
  >
    <span class="brand-logo h-full w-full" />
  </span>
</template>

<style scoped>
.brand-logo {
  background-color: oklch(var(--foreground));
  -webkit-mask: var(--brand-logo) center / contain no-repeat;
  mask: var(--brand-logo) center / contain no-repeat;
}
</style>
