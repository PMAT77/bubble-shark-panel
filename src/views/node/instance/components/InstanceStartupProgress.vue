<script setup lang="ts">
import { NButton } from 'naive-ui'
import type { InstanceStartupSnapshot } from '@/api/modules/instance'
import { startupPhaseLabel } from '../startupPresentation'
import { formatMemoryMb, formatUptime } from '../instanceDisplay'
defineProps<{ startup?: InstanceStartupSnapshot | null, showResources?: boolean }>()
defineEmits<{ resources: [] }>()
const shardStates = { pending: '待启动', loading: '加载中', ready: '已就绪', failed: '失败', disabled: '未启用' }
</script>

<template>
  <div v-if="startup" class="rounded-md border border-border bg-muted/30 p-3 space-y-2 text-sm" aria-live="polite">
    <div class="flex flex-wrap gap-x-4 gap-y-1">
      <strong>{{ startupPhaseLabel(startup) }}</strong>
      <span class="text-muted-foreground">已等待 {{ formatUptime(startup.elapsedSeconds) }}</span>
      <span v-if="startup.remainingSeconds !== null && startup.status === 'running'" class="text-muted-foreground">本阶段剩余 {{ formatUptime(startup.remainingSeconds) }}</span>
    </div>
    <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs">
      <span>主世界：{{ shardStates[startup.master.state] }} · 峰值 {{ formatMemoryMb(startup.master.memoryPeakMb) }}</span>
      <span>洞穴：{{ shardStates[startup.caves.state] }}<template v-if="startup.caves.state !== 'disabled'"> · 峰值 {{ formatMemoryMb(startup.caves.memoryPeakMb) }}</template></span>
    </div>
    <p v-if="startup.diagnosis" class="text-amber-600 dark:text-amber-400">{{ startup.diagnosis.message }}</p>
    <p v-if="startup.protectionStop" role="alert" class="text-red-500">{{ startup.protectionStop.message }}。{{ startup.protectionStop.cleanupCompleted ? '两片已清理，请检查资源后手动启动。' : '清理未完成，请先再次停止实例。' }}</p>
    <NButton v-if="showResources && (startup.diagnosis || startup.protectionStop)" text size="tiny" @click="$emit('resources')">查看资源与启动等待设置</NButton>
  </div>
</template>
