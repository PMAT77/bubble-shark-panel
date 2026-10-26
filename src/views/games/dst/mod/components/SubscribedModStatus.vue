<script setup lang="ts">
import { NButton, NPopover, NTag } from 'naive-ui'

defineProps<{
  name: string
  label: string
  tone: 'default' | 'success' | 'warning' | 'error'
  version: string
  versionHint: string
  error?: string | null
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
    <details v-if="error" class="text-rose-600 dark:text-rose-400">
      <summary class="cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-primary">失败原因</summary>
      <p class="mt-1 break-words">{{ error }}</p>
    </details>
  </div>
</template>
