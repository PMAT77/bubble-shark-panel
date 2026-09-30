<script setup lang="ts">
import HeroGeometric from './HeroGeometric.vue'
import type { AppHelloProps } from './types'
import { DEFAULT_APP_HELLO } from './types'

defineOptions({
  name: 'AppHello',
})

const props = withDefaults(defineProps<AppHelloProps>(), {
  title: DEFAULT_APP_HELLO.title,
  subtitle: DEFAULT_APP_HELLO.subtitle,
  description: DEFAULT_APP_HELLO.description,
})
</script>

<template>
  <HeroGeometric
    class="h-full w-full"
    :badge="props.badge"
    :title="props.title"
    :subtitle="props.subtitle"
    :description="props.description"
    :compact="props.compact"
  />
</template>
