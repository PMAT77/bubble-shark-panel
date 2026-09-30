<script setup lang="ts">
import ElegantShape from './ElegantShape.vue'
import { useFadeUp } from './composables/useFadeUp'
import type { AppHelloProps } from './types'
import { DEFAULT_APP_HELLO, HERO_SHAPES } from './types'

defineOptions({
  name: 'AppHelloHeroGeometric',
})

const props = withDefaults(defineProps<AppHelloProps>(), {
  title: DEFAULT_APP_HELLO.title,
  subtitle: DEFAULT_APP_HELLO.subtitle,
  description: DEFAULT_APP_HELLO.description,
})

const { style: badgeStyle } = useFadeUp(0, 500)
const { style: titleStyle } = useFadeUp(0.2, 700)
const { style: descStyle } = useFadeUp(0.4, 900)
</script>

<template>
  <div class="app-hello-root">
    <div class="app-hello-hero-bg" />

    <div class="app-hello-shapes-layer">
      <ElegantShape
        v-for="shape in HERO_SHAPES"
        :key="shape.variant"
        :variant="shape.variant"
        :delay="shape.delay"
        :width="shape.width"
        :height="shape.height"
        :rotate="shape.rotate"
        :class="shape.positionClass"
      />
    </div>

    <div :class="props.compact ? 'app-hello-content-compact' : 'app-hello-content'">
      <div class="app-hello-content-inner">
        <div
          v-if="props.badge"
          :class="props.compact ? 'app-hello-badge-compact' : 'app-hello-badge'"
          :style="badgeStyle"
        >
          <span class="text-sm text-white/60 tracking-wide">{{ props.badge }}</span>
        </div>

        <div :style="titleStyle">
          <h1 :class="props.compact ? 'app-hello-title-compact' : 'app-hello-title'">
            <span class="app-hello-title-primary">{{ props.title }}</span>
            <br>
            <span class="app-hello-title-accent">{{ props.subtitle }}</span>
          </h1>
        </div>

        <div
          v-if="props.description"
          :style="descStyle"
        >
          <p :class="props.compact ? 'app-hello-desc-compact' : 'app-hello-desc'">
            {{ props.description }}
          </p>
        </div>
      </div>
    </div>

    <div class="app-hello-vignette" />
  </div>
</template>
