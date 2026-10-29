<script setup lang="ts">
import { NButton, NPopover, NTag } from 'naive-ui'

defineProps<{
  name: string
  label: string
  tone: 'default' | 'success' | 'warning' | 'error'
  version: string
  versionHint: string
}>()
</script>

<template>
  <div class="min-w-0 space-y-1 text-sm">
    <NTag size="small" :bordered="false" :type="tone">{{ label }}</NTag>
    <div>
      <NPopover trigger="click" class="max-w-xs">
        <template #trigger>
          <NButton text size="small" :aria-label="`${name} 的版本信息：${version}`">版本：{{ version }}</NButton>
        </template>
        {{ versionHint }}
      </NPopover>
    </div>
  </div>
</template>
