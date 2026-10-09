<script setup lang="ts">
import type { InstanceInstallLogPayload } from '@/api/modules/instance'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import apiInstance from '@/api/modules/instance'
import { getInstallLogStatusLabel } from '../instanceDisplay'
import { formatInstallLogForDisplay } from '../installLogFormat'
import { formatDateTime } from '../utils'

const props = defineProps<{ show: boolean, instanceId: string, instanceName: string }>()
const emit = defineEmits<{ 'update:show': [value: boolean], terminal: [instanceId: string] }>()

const loading = ref(false)
const downloading = ref(false)
const meta = ref<InstanceInstallLogPayload | null>(null)
const rawContent = ref('')
const rawTruncated = ref(false)
const rawExpanded = ref(false)
const fetchError = ref('')
const now = ref(Date.now())
const viewportRef = ref<HTMLElement | null>(null)
const eventsRef = ref<HTMLElement | null>(null)
const progress = computed(() => meta.value?.progress)
const formattedContent = computed(() => formatInstallLogForDisplay(rawContent.value))
const percentLabel = computed(() => progress.value?.percent == null ? '' : `${Number(progress.value.percent.toFixed(2))}%`)
const phaseLabel = computed(() => progress.value?.phase || meta.value?.phase || getInstallLogStatusLabel(meta.value?.status))
const lastOutputHint = computed(() => {
  const at = progress.value?.updatedAt ?? meta.value?.updatedAt
  const time = at ? Date.parse(at) : Number.NaN
  if (!Number.isFinite(time)) return '等待安装输出'
  const seconds = Math.max(0, Math.floor((now.value - time) / 1000))
  return seconds < 1 ? '刚刚收到输出' : `最近输出：${seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分钟`}前`
})
const retryHint = computed(() => {
  if (!progress.value?.retryAt || meta.value?.status !== 'running') return ''
  const seconds = Math.max(0, Math.ceil((Date.parse(progress.value.retryAt) - now.value) / 1000))
  return seconds > 0 ? `${seconds} 秒后重试，已下载内容会保留` : '正在准备重试，已下载内容会保留'
})

let pollTimer: ReturnType<typeof setInterval> | undefined
let epoch = 0
let activeRequest: Promise<void> | undefined

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = undefined
}

function atBottom(el: HTMLElement | null) {
  return !el || el.scrollHeight - el.scrollTop - el.clientHeight <= 24
}

async function fetchContent(options?: { silent?: boolean }) {
  if (!props.show || !props.instanceId) return
  if (activeRequest) {
    if (options?.silent) return
    await activeRequest
    return fetchContent(options)
  }
  const currentEpoch = epoch
  const id = props.instanceId
  const includeRaw = rawExpanded.value
  if (!options?.silent) loading.value = true
  activeRequest = (async () => {
    try {
      const [summary, raw] = await Promise.all([
        apiInstance.getInstanceInstallLog(id, 'summary'),
        includeRaw ? apiInstance.getInstanceInstallLog(id, 'raw') : Promise.resolve(null),
      ])
      if (currentEpoch !== epoch || !props.show) return
      const rawAtBottom = atBottom(viewportRef.value)
      const eventsAtBottom = atBottom(eventsRef.value)
      const wasRunning = meta.value?.status === 'running'
      meta.value = summary.data
      if (raw) {
        rawContent.value = raw.data.content
        rawTruncated.value = raw.data.rawTruncated ?? false
      }
      fetchError.value = ''
      now.value = Date.now()
      if (wasRunning && summary.data.status !== 'running') {
        stopPolling()
        emit('terminal', id)
      }
      if (summary.data.status === 'running' && !pollTimer) startPolling()
      await nextTick()
      if (currentEpoch !== epoch) return
      if (rawAtBottom && viewportRef.value) viewportRef.value.scrollTop = viewportRef.value.scrollHeight
      if (eventsAtBottom && eventsRef.value) eventsRef.value.scrollTop = eventsRef.value.scrollHeight
    }
    catch {
      if (currentEpoch === epoch) fetchError.value = '日志刷新失败，将保留当前内容；可点击刷新重试。'
    }
    finally {
      if (currentEpoch === epoch) { loading.value = false; activeRequest = undefined }
    }
  })()
  await activeRequest
}

function startPolling() {
  stopPolling()
  if (!props.show || meta.value?.status !== 'running') return
  pollTimer = setInterval(() => {
    now.value = Date.now()
    void fetchContent({ silent: true })
  }, 1000)
}

function closeModal() {
  epoch++
  activeRequest = undefined
  stopPolling()
  emit('update:show', false)
}

function onRawToggle(event: Event) {
  const open = (event.target as HTMLDetailsElement).open
  if (open === rawExpanded.value) return
  rawExpanded.value = open
  if (open) void fetchContent()
}

async function downloadLog() {
  if (downloading.value) return
  downloading.value = true
  try {
    const { data } = await apiInstance.downloadInstanceInstallLog(props.instanceId)
    const url = URL.createObjectURL(data)
    const link = document.createElement('a')
    link.href = url
    link.download = `${props.instanceName || props.instanceId}-install.log`
    link.click()
    URL.revokeObjectURL(url)
  }
  catch { fetchError.value = '安装日志下载失败，请刷新后重试。' }
  finally { downloading.value = false }
}

watch(() => [props.show, props.instanceId] as const, async ([visible, id]) => {
  epoch++
  const currentEpoch = epoch
  activeRequest = undefined
  stopPolling()
  if (!visible || !id) return
  meta.value = null
  rawContent.value = ''
  rawTruncated.value = false
  rawExpanded.value = false
  fetchError.value = ''
  await fetchContent()
  if (currentEpoch === epoch) startPolling()
}, { immediate: true })

onBeforeUnmount(() => { epoch++; stopPolling() })
defineExpose({ stopPolling })
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    :title="`安装日志 - ${instanceName || '实例'}`"
    :style="{ width: '760px', maxWidth: 'calc(100vw - 32px)' }"
    @update:show="(value: boolean) => { if (!value) closeModal() }"
    @after-leave="stopPolling"
  >
    <div class="space-y-4">
      <section class="rounded-md border border-border bg-muted/30 p-4 space-y-2">
        <div class="flex items-center justify-between gap-3">
          <p class="font-medium" aria-live="polite">{{ phaseLabel }}<span v-if="percentLabel"> · {{ percentLabel }}</span></p>
          <NTag size="small" :type="meta?.status === 'failed' ? 'error' : meta?.status === 'success' ? 'success' : 'info'">
            {{ getInstallLogStatusLabel(meta?.status) }}
          </NTag>
        </div>
        <NProgress
          v-if="meta?.status === 'running' && progress?.percent != null"
          type="line"
          :percentage="progress.percent"
          :show-indicator="false"
          :processing="true"
        />
        <p v-else-if="meta?.status === 'running'" class="text-sm text-muted-foreground">正在处理，等待当前阶段的进度输出…</p>
        <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{{ lastOutputHint }}</span>
          <span v-if="progress && meta?.status === 'running'">第 {{ progress.attempt }}/{{ progress.maxAttempts }} 次尝试</span>
          <span v-if="meta?.status === 'running'">每 1 秒自动刷新</span>
        </div>
        <p v-if="percentLabel && meta?.status === 'running'" class="text-xs text-muted-foreground">百分比为当前阶段进度，后续可能仍需校验和准备启动文件。</p>
        <p v-if="retryHint" class="text-sm text-amber-600 dark:text-amber-400">{{ retryHint }}</p>
        <div v-if="meta?.status === 'failed' && progress?.failure" class="text-sm text-red-600 dark:text-red-400 space-y-1">
          <p>{{ progress.failure.message }}</p>
          <p>{{ progress.failure.advice }}</p>
        </div>
      </section>

      <section v-if="progress?.events.length" class="space-y-2">
        <h3 class="text-sm font-medium">安装过程</h3>
        <ol ref="eventsRef" class="max-h-64 overflow-auto space-y-2 text-sm">
          <li v-for="(event, index) in progress.events" :key="index" class="flex gap-3">
            <time class="shrink-0 text-xs text-muted-foreground pt-0.5">{{ formatDateTime(event.at) }}</time>
            <span class="break-words" :class="event.level === 'error' ? 'text-red-600 dark:text-red-400' : event.level === 'warning' ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'">{{ event.message }}</span>
          </li>
        </ol>
      </section>
      <div v-else class="text-sm text-muted-foreground space-y-2">
        <p>暂无阶段记录，已有日志可在下方展开查看。</p>
        <pre v-if="meta?.content" class="whitespace-pre-wrap break-words font-sans">{{ meta.content }}</pre>
      </div>

      <details :open="rawExpanded" class="rounded-md border border-border p-3" @toggle="onRawToggle">
        <summary class="cursor-pointer text-sm font-medium">原始日志</summary>
        <div class="mt-3 space-y-2">
          <div class="flex items-center justify-between gap-3">
            <p class="text-xs text-muted-foreground">显示最近日志，最多 64 KiB / 500 行<span v-if="rawTruncated">；较早内容请下载查看</span>。</p>
            <NButton size="small" :loading="downloading" :disabled="!meta?.rawAvailable" @click="downloadLog">下载完整日志</NButton>
          </div>
          <NSpin :show="loading">
            <pre ref="viewportRef" class="max-h-72 overflow-auto rounded-md bg-muted/30 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-foreground">{{ formattedContent || '暂无原始日志' }}</pre>
          </NSpin>
        </div>
      </details>
      <p v-if="fetchError" role="alert" class="text-sm text-amber-600 dark:text-amber-400">{{ fetchError }}</p>
    </div>
    <template #footer>
      <NSpace justify="end">
        <NButton :loading="loading" @click="fetchContent()">刷新</NButton>
        <NButton @click="closeModal">关闭</NButton>
      </NSpace>
    </template>
  </NModal>
</template>
