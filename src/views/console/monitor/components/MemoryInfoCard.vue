<script setup lang="ts">
import type { SystemInfoData } from './types'
import { NPopover, NProgress, NSpace } from 'naive-ui'

defineOptions({
  name: 'MemoryInfoCard',
})

const props = withDefaults(defineProps<{
  loading: boolean
  info: SystemInfoData | null
  mode?: 'info' | 'charts'
}>(), {
  mode: 'info',
})

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))
}

/** 后端给的是数字（尾随零会被去掉），这里统一补成两位，免得出现「1.54 / 2 GB」 */
function formatGb(value: number | null | undefined) {
  return value === null || value === undefined ? '--' : value.toFixed(2)
}

const memoryPercent = computed(() => clampPercent(props.info?.memory.usageRate ?? 0))
const memoryGuidance = computed(() => props.info?.memoryGuidance ?? null)
/** 未配置缓存区时后端给 null：显示「未配置」，而不是伪装成 0% */
const swap = computed(() => props.info?.memory.swap ?? null)

/**
 * 可用缓冲 = 可用内存 + 缓存区余量。
 *
 * 这正是启动守卫判断「还能不能再起一个分片」的那个和：只看内存占用百分比，
 * 会把「内存吃满但有 swap 兜底」和「内存与 swap 都见底」看成同一件事。
 * 分级阈值对着守卫的估算下界取整：单分片 0 Mod 约需 896 MiB，分片与 Mod 越多要求越高。
 */
const usableBufferGb = computed(() => {
  const memory = props.info?.memory
  if (!memory) {
    return null
  }
  return (memory.availableGb ?? memory.freeGb) + (memory.swap?.freeGb ?? 0)
})

const bufferLevel = computed(() => {
  const buffer = usableBufferGb.value
  if (buffer === null) {
    return 'unknown'
  }
  if (buffer < 0.5) {
    return 'critical'
  }
  if (buffer < 1) {
    return 'warning'
  }
  return 'ok'
})

const bufferClass = computed(() => {
  if (bufferLevel.value === 'critical') {
    return 'text-red-600 dark:text-red-400'
  }
  if (bufferLevel.value === 'warning') {
    return 'text-amber-600 dark:text-amber-400'
  }
  return 'text-muted-foreground'
})

const bufferText = computed(() => (
  usableBufferGb.value === null ? '--' : usableBufferGb.value.toFixed(2)
))

const bufferHint = computed(() => {
  if (bufferLevel.value === 'critical') {
    return '，重启实例很可能被拦下'
  }
  if (bufferLevel.value === 'warning') {
    return '，重启实例可能被拦下'
  }
  return ''
})
</script>

<template>
  <div v-if="mode === 'info'" class="p-3 border rounded-lg">
    <div class="text-xs text-muted-foreground mb-2">
      内存
    </div>
    <div>
      <div class="font-semibold">
        {{ formatGb(info?.memory.usedGb) }} / {{ formatGb(info?.memory.totalGb) }} GB
      </div>
      <div class="text-xs text-muted-foreground mt-1">
        使用率 {{ info?.memory.usageRate ?? '--' }}% · 可用 {{ formatGb(info?.memory.freeGb) }} GB
      </div>
      <div class="text-xs mt-1" :class="bufferClass">
        <template v-if="swap">
          缓存区 {{ formatGb(swap.usedGb) }} / {{ formatGb(swap.totalGb) }} GB
        </template>
        <template v-else>
          未配置缓存区
        </template>
        · 可用缓冲 {{ bufferText }} GB
      </div>
    </div>
  </div>
  <NPopover
    v-if="mode === 'charts'"
    trigger="hover"
    placement="top"
    :disabled="!memoryGuidance"
  >
    <template #trigger>
      <div
        class="p-3 rounded-lg flex flex-col items-center justify-center"
        :class="memoryGuidance ? 'cursor-help' : ''"
      >
        <NProgress
          type="circle"
          :percentage="memoryPercent"
          :height="110"
          :stroke-width="8"
          :offset-degree="180"
          :show-indicator="true"
        >
          <NSpace vertical align="center" :size="0">
            <span class="text-lg text-muted-foreground">
              {{ memoryPercent.toFixed(2) }}%
            </span>
            <span class="text-xs text-muted-foreground">
              内存
            </span>
          </NSpace>
        </NProgress>
        <span class="text-xs text-muted-foreground mt-4">{{ formatGb(info?.memory.usedGb) }} / {{ formatGb(info?.memory.totalGb) }} GB · 可用 {{ formatGb(info?.memory.freeGb) }} GB</span>
        <span class="text-xs text-muted-foreground mt-1">
          <template v-if="swap">
            缓存区 {{ formatGb(swap.usedGb) }} / {{ formatGb(swap.totalGb) }} GB
          </template>
          <template v-else>
            未配置缓存区
          </template>
        </span>
        <span class="text-xs mt-1" :class="bufferClass">
          可用缓冲 {{ bufferText }} GB{{ bufferHint }}
        </span>
      </div>
    </template>
    <div v-if="memoryGuidance" class="max-w-xs text-sm leading-relaxed">
      <p class="font-medium">
        内存档位：{{ memoryGuidance.tierLabelZh }}
      </p>
      <p class="text-muted-foreground mt-1">
        {{ memoryGuidance.summaryZh }}
      </p>
      <p class="text-muted-foreground mt-1">
        「可用缓冲」= 可用内存 + 缓存区余量，是启动新分片前真正能用的部分。
      </p>
    </div>
  </NPopover>
</template>
