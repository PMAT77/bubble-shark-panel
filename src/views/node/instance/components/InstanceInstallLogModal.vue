<script setup lang="ts">
import type { InstanceInstallLogPayload } from '@/api/modules/instance'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import apiInstance from '@/api/modules/instance'
import { formatPollIntervalHint, getInstallLogSourceLabel, getInstallLogStatusLabel } from '../instanceDisplay'
import { formatInstallLogForDisplay } from '../installLogFormat'
import { formatDateTime } from '../utils'

const props = defineProps<{
  show: boolean
  instanceId: string
  instanceName: string
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  terminal: [instanceId: string]
}>()

const INSTALL_LOG_POLL_MS = 1000
const INSTALL_LOG_AT_BOTTOM_THRESHOLD_PX = 24

const loading = ref(false)
const content = ref('')
const meta = ref<InstanceInstallLogPayload | null>(null)
const viewportRef = ref<HTMLElement | null>(null)
const formattedContent = computed(() => formatInstallLogForDisplay(content.value))

let pollTimer: ReturnType<typeof setInterval> | undefined

const hint = computed(() => {
  if (meta.value?.source === 'status_summary') {
    return {
      class: 'text-amber-600 dark:text-amber-400',
      text: '以下为最近状态摘要，不是完整安装日志；安装进行中请保持弹窗打开以自动刷新。',
    }
  }
  if (shouldPollInstallLog()) {
    const interval = formatPollIntervalHint(INSTALL_LOG_POLL_MS)
    return {
      class: 'text-sky-600 dark:text-sky-400',
      text: `安装进行中，${interval}自动刷新日志。`,
    }
  }
  return null
})

function shouldPollInstallLog() {
  return props.show && props.instanceId && meta.value?.status === 'running'
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = undefined
  }
}

function isViewportAtBottom(el: HTMLElement) {
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
  return distanceFromBottom <= INSTALL_LOG_AT_BOTTOM_THRESHOLD_PX
}

function scrollToBottomIfNeeded(wasAtBottom: boolean) {
  if (!props.show || !wasAtBottom) {
    return
  }
  nextTick(() => {
    const el = viewportRef.value
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  })
}

async function fetchContent(options?: { silent?: boolean }) {
  if (!props.instanceId) {
    return
  }
  if (!options?.silent) {
    loading.value = true
  }
  try {
    const res = await apiInstance.getInstanceInstallLog(props.instanceId)
    const viewport = viewportRef.value
    const wasAtBottom = !viewport || isViewportAtBottom(viewport)
    meta.value = res.data
    content.value = res.data.content || '暂无安装日志'
    scrollToBottomIfNeeded(wasAtBottom)
  }
  finally {
    if (!options?.silent) {
      loading.value = false
    }
  }
}

function startPolling() {
  stopPolling()
  if (!shouldPollInstallLog()) {
    return
  }
  pollTimer = setInterval(() => {
    if (!props.show) {
      stopPolling()
      return
    }
    if (shouldPollInstallLog()) {
      void fetchContent({ silent: true })
    }
    else {
      stopPolling()
      emit('terminal', props.instanceId)
    }
  }, INSTALL_LOG_POLL_MS)
}

function closeModal() {
  emit('update:show', false)
  stopPolling()
}

watch(
  () => [props.show, props.instanceId] as const,
  async ([visible, instanceId]) => {
    if (!visible || !instanceId) {
      stopPolling()
      return
    }
    content.value = ''
    meta.value = null
    await fetchContent()
    startPolling()
  },
)

onBeforeUnmount(() => {
  stopPolling()
})

defineExpose({
  stopPolling,
})
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    :title="`安装日志 - ${instanceName || '实例'}`"
    :style="{ width: '760px' }"
    @update:show="(value: boolean) => { if (!value) closeModal() }"
    @after-leave="stopPolling"
  >
    <div class="space-y-3">
      <div class="text-xs text-muted-foreground space-y-1">
        <p>
          <span>来源：{{ getInstallLogSourceLabel(meta?.source) }}</span>
          <span class="ml-4">状态：{{ getInstallLogStatusLabel(meta?.status) }}</span>
          <span class="ml-4">更新时间：{{ formatDateTime(meta?.updatedAt || null) }}</span>
        </p>
        <p v-if="meta?.status === 'running'">当前阶段：{{ meta.phase || '准备环境' }}。等待期间可查看下方日志。</p>
        <p v-if="hint" :class="hint.class">
          {{ hint.text }}
        </p>
      </div>
      <NSpin :show="loading">
        <pre
          ref="viewportRef"
          class="max-h-96 overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-foreground"
        >{{ formattedContent || '暂无安装日志' }}</pre>
      </NSpin>
    </div>
    <template #footer>
      <NSpace justify="end">
        <NButton :loading="loading" @click="fetchContent()">
          刷新
        </NButton>
        <NButton @click="closeModal">
          关闭
        </NButton>
      </NSpace>
    </template>
  </NModal>
</template>
