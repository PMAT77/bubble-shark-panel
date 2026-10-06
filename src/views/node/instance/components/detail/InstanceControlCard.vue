<script setup lang="ts">
import type { InstanceItem } from '@/api/modules/instance'
import { NButton, NCard, NModal, NStatistic, NTooltip, useMessage, useNotification } from 'naive-ui'
import { computed, h, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import { routeToInstanceConsole } from '@/navigation/game-routes'
import { statusBadgeClass } from '@/constants/statusDictionary'
import { copyTextToClipboard } from '@/utils/copyToClipboard'
import { HOST_MEMORY_PRESSURE_EXPAND_SWAP_COMMAND } from '@/utils/hostMemoryPressure'
import {
  computeUptimeSecondsFromStartedAt,
  formatMemoryMb,
  formatUptime,
  getInstanceState,
  isInstanceInstallingStatus,
  resolveRuntimeReadinessView,
} from '../../instanceDisplay'
import {
  canUpdateInstance,
  getUpdateInstanceButtonTitle,
  useInstanceLifecycleActions,
} from '../../composables/useInstanceLifecycleActions'
import { useInstanceRuntimeObservability } from '../../composables/useInstanceRuntimeObservability'
import InstanceInstallLogModal from '../InstanceInstallLogModal.vue'
import apiInstance from '@/api/modules/instance'
import { canRetryInstanceInstall, resolveInstanceUpdateState, buildInstanceUpdateCheckNotice } from '../../instanceUpdatePresentation'
import { waitForInstanceUpdateCheckJob } from '../../composables/instanceUpdateCheckJob'
import { formatDateTime } from '../../utils'

defineOptions({
  name: 'InstanceDetailControlCard',
})

/**
 * 这张卡片上的每个按钮都是写操作（控制台是读，但它的路由也按权限注册——
 * 没权限时点进去会落到 404），所以逐个按权限点决定是否出现。
 * 只读账号（游客角色）能看状态与指标，但一个按钮都点不到。
 */
const { auth: hasPermission } = useAppAuth()

const props = defineProps<{
  instance: InstanceItem | null
}>()

const emit = defineEmits<{
  refreshed: []
}>()

const router = useRouter()
const route = useRoute()
const installLogVisible = ref(false)
const updateCheckLoading = ref(false)
let updateCheckController: AbortController | undefined
let pageActive = false

const {
  isActionLoading,
  isInstanceActionRunning,
  confirmStartInstance,
  confirmUpdateInstance,
  confirmDangerousInstanceAction,
} = useInstanceLifecycleActions({
  refresh: () => emit('refreshed'),
  onUpdateAccepted: () => {
    if (hasPermission('instance.install-log:read')) installLogVisible.value = true
  },
})

/** 单实例指标轮询（复用列表页同一套可观测性实现） */
const instanceListRef = computed(() => (props.instance ? [props.instance] : []))
const {
  uptimeNowMs,
  syncRuntimeObservabilityPolling,
  stopRuntimeObservability,
  getMetricsForInstance,
} = useInstanceRuntimeObservability(instanceListRef)

watch(() => props.instance?.status, () => { if (pageActive) syncRuntimeObservabilityPolling() })
function activateObservability() {
  pageActive = route.name === 'nodeInstanceDetail'
  if (pageActive) syncRuntimeObservabilityPolling()
}
onMounted(activateObservability)
/**
 * 本卡片挂在「实例详情」页内，而详情页开了 `keepAlive`：从详情页切走时父页面只会 `deactivate`，
 * 卡片自身不会 unmount，只写 `onBeforeUnmount` 的话两个定时器（指标轮询 + 每秒一次的运行时长 tick）
 * 会留在后台一直跑——用户看到的是「人都走了，这个实例的请求还在发」。
 * 激活与停用必须成对补齐，`syncRuntimeObservabilityPolling` 自身是幂等的，重复调用安全。
 */
onActivated(activateObservability)
function deactivateObservability() {
  pageActive = false
  stopRuntimeObservability()
  installLogVisible.value = false
  updateCheckController?.abort()
}
onDeactivated(deactivateObservability)
onBeforeUnmount(deactivateObservability)
watch(() => route.name, (name) => {
  if (name !== 'nodeInstanceDetail') deactivateObservability()
}, { flush: 'sync' })
watch(() => props.instance?.id, () => updateCheckController?.abort())

const state = computed(() => (props.instance ? getInstanceState(props.instance) : null))

/**
 * 运行期异常（进程反复重启、分片残留）。独立字段：lastError 会被启动失败与
 * 状态对账反复覆盖，实测出现过刚写入就被清空、服主永远看不到的情况。
 * 老数据里这类文案曾写在 lastError，保留前缀兼容，避免升级后旧告警消失。
 */
const runtimeWarning = computed(() => {
  const warning = props.instance?.runtimeWarning?.trim()
  if (warning) {
    return warning
  }
  const legacy = props.instance?.lastError?.trim() ?? ''
  return legacy.startsWith('实例进程反复重启') || legacy.startsWith('主世界分片已停止') ? legacy : null
})

/** 世界是否已就绪：运行中不等于能接客（玩家要等世界加载完才搜得到房间） */
const readiness = computed(() => (props.instance ? resolveRuntimeReadinessView(props.instance) : null))

/**
 * 内存导致的启动失败：主动问一次「要不要加缓存区」。
 *
 * 用通知而不是卡片里常驻一条说明：这是个需要用户做决定的询问，不该混在状态信息里被当背景读过去。
 * 同一实例在状态没变化前只问一次——反复弹同一条只会让人条件反射地关掉它；失败状态消失后
 * 重新计数，下次再失败还会问。
 *
 * 只有「内存」这一种归因才会问：后端给的 `runtimeFailureKind` 带证据（cgroup OOM 计数、
 * 反复重启且可用缓冲见底…），Mod 报错之类的未就绪走另一套措辞，避免白折腾一轮缓存区。
 */
const notification = useNotification()
const swapGuideVisible = ref(false)
const message = useMessage()
const promptedMemoryFailure = new Set<string>()

function askAboutSwapGuide() {
  const notice = notification.warning({
    title: '实例内存不足',
    content: '是否尝试增加缓存区大小？',
    duration: 0,
    closable: true,
    action: () => h('div', { class: 'flex items-center gap-2' }, [
      h(
        NButton,
        {
          size: 'tiny',
          type: 'warning',
          secondary: true,
          onClick: () => {
            notice.destroy()
            swapGuideVisible.value = true
          },
        },
        { default: () => '增加缓存区' },
      ),
      h(NButton, { size: 'tiny', secondary: true, onClick: () => notice.destroy() }, { default: () => '取消' }),
    ]),
  })
}

watch(
  () => [props.instance?.id, props.instance?.runtimeFailureKind] as const,
  ([instanceId, failureKind]) => {
    if (!instanceId) {
      return
    }
    if (failureKind !== 'memory') {
      promptedMemoryFailure.delete(instanceId)
      return
    }
    if (promptedMemoryFailure.has(instanceId)) {
      return
    }
    promptedMemoryFailure.add(instanceId)
    askAboutSwapGuide()
  },
  { immediate: true },
)

async function copySwapCommand() {
  const copied = await copyTextToClipboard(HOST_MEMORY_PRESSURE_EXPAND_SWAP_COMMAND)
  if (copied) {
    message.success('命令已复制')
    return
  }
  message.warning('复制失败，请手动选中命令复制')
}
const actionRunning = computed(() => Boolean(props.instance && isInstanceActionRunning(props.instance.id)))

const isInstalling = computed(() => Boolean(props.instance && isInstanceInstallingStatus(props.instance.status)))

const updateState = computed(() => props.instance ? resolveInstanceUpdateState(props.instance) : 'unchecked')

async function checkUpdates() {
  if (!props.instance || updateCheckLoading.value) return
  updateCheckController = new AbortController()
  const signal = updateCheckController.signal
  updateCheckLoading.value = true
  try {
    const res = await apiInstance.checkInstanceUpdates([props.instance.id], { signal })
    const status = res.data.checking ? await waitForInstanceUpdateCheckJob(signal) : res.data
    if (signal.aborted) return
    emit('refreshed')
    if (status.error) message.error(status.error)
    else {
      const notice = buildInstanceUpdateCheckNotice(status.result?.items ?? [])
      message[notice.tone](notice.message)
    }
  }
  catch (error) {
    if (!signal.aborted) message.error(error instanceof Error ? error.message : '检查更新失败')
  }
  finally { updateCheckLoading.value = false }
}

const metrics = computed(() => (props.instance ? getMetricsForInstance(props.instance.id) : null))

const uptimeSeconds = computed(() => {
  if (!props.instance || props.instance.status !== 'running') {
    return null
  }
  const metricsUptime = metrics.value?.uptimeSeconds ?? null
  if (metricsUptime !== null) {
    return metricsUptime
  }
  return computeUptimeSecondsFromStartedAt(props.instance.runtimeStartedAt, uptimeNowMs.value)
})

function canStart() {
  if (!props.instance) {
    return false
  }
  return !actionRunning.value
    && props.instance.status !== 'running'
    && props.instance.status !== 'pending_install'
    && props.instance.status !== 'installing'
}

function canStop() {
  if (!props.instance) {
    return false
  }
  return !actionRunning.value
    && props.instance.status !== 'stopped'
    && props.instance.status !== 'error'
}

function canRestart() {
  if (!props.instance) {
    return false
  }
  return !actionRunning.value
    && props.instance.status !== 'pending_install'
    && props.instance.status !== 'installing'
}

function canDelete() {
  if (!props.instance) {
    return false
  }
  return !actionRunning.value
    && props.instance.status !== 'pending_install'
    && props.instance.status !== 'installing'
}

/** 更新动作按当前状态给出确认语义（修复安装 vs 更新） */
function requestUpdate() {
  if (props.instance) {
    confirmUpdateInstance(props.instance)
  }
}

function requestDangerous(action: 'stop' | 'cancel_install' | 'restart' | 'delete') {
  if (props.instance) {
    confirmDangerousInstanceAction(props.instance, action)
  }
}

function goConsole() {
  if (props.instance) {
    router.push(routeToInstanceConsole(props.instance.id))
  }
}
</script>

<template>
  <NCard title="实例控制" size="small">
    <template v-if="instance && state">
      <div class="flex flex-wrap items-center gap-2 mb-4">
        <span
          class="text-xs px-2 py-0.5 rounded-full"
          :class="statusBadgeClass(state.tone)"
        >
          {{ state.label }}
        </span>
        <span v-if="updateState === 'available'" class="text-xs text-amber-600 dark:text-amber-400">
          服务端需要更新
        </span>
        <span v-else-if="updateState === 'unknown'" class="text-xs text-amber-600 dark:text-amber-400">
          版本未知：{{ instance.updateCheckError || '无法确认版本，请重新检查更新' }}
        </span>
        <span v-else class="text-xs text-muted-foreground">{{ updateState === 'current' ? '已是最新版本' : '尚未检查版本' }}</span>
        <span v-if="instance.updateCheckedAt" class="text-xs text-muted-foreground">检查时间：{{ formatDateTime(instance.updateCheckedAt) }}</span>
        <span
          v-if="readiness"
          class="text-xs"
          :class="readiness.tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'"
        >
          {{ readiness.label }}
        </span>
      </div>

      <p
        v-if="runtimeWarning"
        class="mb-4 rounded-md px-3 py-2 text-xs leading-relaxed break-all bg-amber-500/10 text-amber-700 dark:text-amber-400"
      >
        {{ runtimeWarning }}
      </p>

      <p
        v-if="instance.lastError?.trim() && !isInstalling"
        class="mb-4 rounded-md px-3 py-2 text-xs leading-relaxed break-all bg-muted/50 text-muted-foreground"
      >
        {{ instance.lastError }}
      </p>

      <p v-if="isInstalling" class="mb-4 text-xs text-muted-foreground">安装中，当前阶段请查看日志。</p>

      <div class="grid grid-cols-3 gap-x-4 gap-y-3 mb-4">
        <NStatistic label="CPU（单核基准）">
          {{ instance.status === 'running' && metrics?.cpuUsageRate != null ? `${metrics.cpuUsageRate.toFixed(1)}%` : '—' }}
        </NStatistic>
        <NStatistic label="内存（主世界进程）">
          {{ instance.status === 'running' ? formatMemoryMb(metrics?.memoryMb) : '—' }}
        </NStatistic>
        <NStatistic label="运行时长">
          {{ formatUptime(uptimeSeconds) }}
        </NStatistic>
      </div>

      <div class="flex flex-wrap gap-2">
        <NButton size="small" secondary :loading="updateCheckLoading" :disabled="isInstalling || actionRunning" @click="checkUpdates" v-if="hasPermission('instance:update')">检查更新</NButton>
        <NButton size="small" secondary @click="installLogVisible = true" v-if="hasPermission('instance.install-log:read')">
          查看日志
        </NButton>
        <NButton
          size="small"
          type="primary"
          secondary
          :loading="isActionLoading(instance.id, 'start')"
          :disabled="!canStart()"
          @click="confirmStartInstance(instance)"
          v-if="hasPermission('instance:lifecycle')"
        >
          启动
        </NButton>
        <NButton
          size="small"
          type="warning"
          secondary
          :loading="isActionLoading(instance.id, 'stop')"
          :disabled="!canStop()"
          @click="requestDangerous(instance.status === 'installing' || instance.status === 'pending_install' ? 'cancel_install' : 'stop')"
          v-if="hasPermission('instance:lifecycle')"
        >
          {{ isInstalling ? '取消安装' : '停止' }}
        </NButton>
        <NButton
          size="small"
          secondary
          :loading="isActionLoading(instance.id, 'restart')"
          :disabled="!canRestart()"
          @click="requestDangerous('restart')"
          v-if="hasPermission('instance:lifecycle')"
        >
          重启
        </NButton>
        <NTooltip trigger="hover" :disabled="canUpdateInstance(instance)" v-if="hasPermission('instance:update')">
          <template #trigger>
            <NButton
              size="small"
              type="warning"
              secondary
              :loading="isActionLoading(instance.id, 'update')"
              :disabled="actionRunning || !canUpdateInstance(instance)"
              @click="requestUpdate"
            >
              {{ canRetryInstanceInstall(instance) ? '重试安装' : '更新服务端' }}
            </NButton>
          </template>
          {{ getUpdateInstanceButtonTitle(instance) }}
        </NTooltip>
        <NButton size="small" secondary :disabled="isInstalling" @click="goConsole" v-if="hasPermission('instance.console:read')">
          控制台
        </NButton>
        <NButton
          size="small"
          type="error"
          secondary
          :disabled="!canDelete()"
          @click="requestDangerous('delete')"
          v-if="hasPermission('instance:delete')"
        >
          删除
        </NButton>
      </div>
    </template>
    <p v-else class="text-sm text-muted-foreground">
      未找到实例。
    </p>

    <InstanceInstallLogModal
      v-if="instance && hasPermission('instance.install-log:read')"
      v-model:show="installLogVisible"
      :instance-id="instance.id"
      :instance-name="instance.name"
      @terminal="emit('refreshed')"
    />

    <NModal
      v-model:show="swapGuideVisible"
      preset="card"
      title="增加缓存区"
      class="max-w-lg"
    >
      <div class="space-y-3 text-sm leading-relaxed">
        <p>
          实例最近因为内存不足被系统终止。
        </p>
        <p class="font-medium">
          1. 停止实例
        </p>
        <div class="space-y-2">
          <p class="font-medium">
            2. 在服务器上执行以下命令（需要 root 权限）
          </p>
          <div class="rounded-md bg-muted/60 px-3 py-2 font-mono text-xs break-all">
            {{ HOST_MEMORY_PRESSURE_EXPAND_SWAP_COMMAND }}
          </div>
          <NButton size="tiny" secondary @click="copySwapCommand">
            复制命令
          </NButton>
          <p class="text-muted-foreground">
            若你用的不是 /swapfile-bsp，把命令里的路径换成 swapon --show 里显示的名字。
          </p>
        </div>
        <p class="font-medium">
          3. 重启实例
        </p>
      </div>
    </NModal>
  </NCard>
</template>
