<script setup lang="ts">
import type { InstanceItem } from '@/api/modules/instance'
import { NButton, NCard, NDropdown, NModal, NStatistic, useMessage } from 'naive-ui'
import type { DropdownOption } from 'naive-ui'
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import { routeToInstanceConsole } from '@/navigation/game-routes'
import { statusBadgeClass } from '@/constants/statusDictionary'
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
import { canRetryInstanceInstall, resolveInstanceUpdateState, buildInstanceUpdateCheckNotice, INSTANCE_VERSION_UNKNOWN_NOTICE } from '../../instanceUpdatePresentation'
import { waitForInstanceUpdateCheckJob } from '../../composables/instanceUpdateCheckJob'
import { formatDateTime } from '../../utils'
import { isStartupActive } from '../../startupPresentation'
import { useInstanceAnomalyNotice } from '../../composables/useInstanceAnomalyNotice'
import { instanceAnomalyText } from '../../instanceAnomalies'

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
const pageActive = ref(false)
const { anomalies, detailsVisible, showDetails } = useInstanceAnomalyNotice(computed(() => props.instance), pageActive)

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

watch(() => props.instance?.status, () => { if (pageActive.value) syncRuntimeObservabilityPolling() })
function activateObservability() {
  pageActive.value = route.name === 'nodeInstanceDetail'
  if (pageActive.value) syncRuntimeObservabilityPolling()
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
  pageActive.value = false
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

/** 世界是否已就绪：运行中不等于能接客（玩家要等世界加载完才搜得到房间） */
const readiness = computed(() => {
  const view = props.instance ? resolveRuntimeReadinessView(props.instance) : null
  return view?.label === state.value?.label ? null : view
})

const message = useMessage()

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
    if (status.error) message.error(INSTANCE_VERSION_UNKNOWN_NOTICE)
    else {
      const notice = buildInstanceUpdateCheckNotice(status.result?.items ?? [])
      message[notice.tone](notice.message)
    }
  }
  catch {
    if (!signal.aborted) message.error(INSTANCE_VERSION_UNKNOWN_NOTICE)
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
    && !isStartupActive(props.instance.startup)
    && (props.instance.status !== 'running' || (props.instance.startup?.master.state === 'ready' && ['failed', 'stopped'].includes(props.instance.startup.caves.state)))
    && props.instance.status !== 'pending_install'
    && props.instance.status !== 'installing'
}

function canStop() {
  if (!props.instance) {
    return false
  }
  return !actionRunning.value
    && (isStartupActive(props.instance.startup) || (props.instance.status !== 'stopped' && props.instance.status !== 'error'))
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

const maintenanceOptions = computed(() => {
  const options: DropdownOption[] = []
  if (hasPermission('instance:update')) {
    options.push({ key: 'check', label: updateCheckLoading.value ? '正在检查更新…' : '检查更新', disabled: isInstalling.value || actionRunning.value || updateCheckLoading.value })
    const target = props.instance
    if (target) options.push({
      key: 'update', label: canRetryInstanceInstall(target) ? '重试安装' : '更新服务端',
      disabled: actionRunning.value || !canUpdateInstance(target),
      props: { title: getUpdateInstanceButtonTitle(target) },
    })
  }
  if (hasPermission('instance.install-log:read')) options.push({ key: 'log', label: '安装日志' })
  if (hasPermission('instance:delete')) {
    if (options.length) options.push({ key: 'divider', type: 'divider' })
    options.push({ key: 'delete', label: '删除实例', disabled: !canDelete(), props: { class: 'text-rose-600 dark:text-rose-400' } })
  }
  return options
})
function runMaintenance(key: string) {
  if (key === 'check') void checkUpdates()
  else if (key === 'update') requestUpdate()
  else if (key === 'log') installLogVisible.value = true
  else if (key === 'delete') requestDangerous('delete')
}
</script>

<template>
  <NCard size="small" aria-label="实例状态与控制">
    <template v-if="instance && state">
      <div class="flex flex-wrap items-center gap-2 mb-4">
        <span
          class="text-sm px-2 py-0.5 rounded-full"
          :class="statusBadgeClass(state.tone)"
        >
          {{ state.label }}
        </span>
        <NButton v-if="anomalies.length" size="tiny" quaternary @click="showDetails">异常详情</NButton>
        <span v-if="updateState === 'available'" class="text-xs text-amber-600 dark:text-amber-400">
          服务端需要更新
        </span>
        <span v-else-if="updateState === 'unknown'" class="text-sm text-amber-600 dark:text-amber-400 break-words">
          {{ INSTANCE_VERSION_UNKNOWN_NOTICE }}
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

      <div class="instance-resource-grid mb-4">
        <NStatistic label="CPU（单核）">
          {{ instance.status === 'running' && metrics?.cpuUsageRate != null ? `${metrics.cpuUsageRate.toFixed(1)}%` : '—' }}
        </NStatistic>
        <NStatistic label="内存（地上）">
          {{ instance.status === 'running' ? formatMemoryMb(metrics?.memoryMb) : '—' }}
        </NStatistic>
        <NStatistic label="运行时长">
          {{ formatUptime(uptimeSeconds) }}
        </NStatistic>
      </div>
      <div class="flex flex-wrap gap-2">
        <NButton
          size="small"
          type="primary"
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
        <NButton size="small" secondary :disabled="isInstalling" @click="goConsole" v-if="hasPermission('instance.console:read')">
          控制台
        </NButton>
        <NDropdown v-if="maintenanceOptions.length" trigger="click" :options="maintenanceOptions" @select="runMaintenance">
          <NButton size="small" :loading="updateCheckLoading || isActionLoading(instance.id, 'update')" :aria-label="`${instance.name} 的维护操作`">
            维护 <FaIcon name="i-lucide:chevron-down" class="ml-1" />
          </NButton>
        </NDropdown>
      </div>
    </template>
    <p v-else class="text-sm text-muted-foreground">
      未找到实例。
    </p>

    <NModal
      v-model:show="detailsVisible"
      preset="card"
      :title="`${instance?.name ?? '实例'} · 异常详情`"
      class="w-[calc(100%_-_32px)] max-w-xl"
      :auto-focus="true"
    >
      <div class="space-y-3 max-h-[60vh] overflow-auto text-sm leading-relaxed break-words whitespace-pre-wrap">
        <p v-for="anomaly in anomalies" :key="instanceAnomalyText(anomaly)">{{ instanceAnomalyText(anomaly) }}</p>
      </div>
      <template #footer>
        <div class="flex justify-end">
          <NButton size="small" @click="detailsVisible = false">关闭</NButton>
        </div>
      </template>
    </NModal>

    <InstanceInstallLogModal
      v-if="instance && hasPermission('instance.install-log:read')"
      v-model:show="installLogVisible"
      :instance-id="instance.id"
      :instance-name="instance.name"
      @terminal="emit('refreshed')"
    />


  </NCard>
</template>

<style scoped>
.instance-resource-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 8rem), 1fr));
  gap: 12px 24px;
  font-variant-numeric: tabular-nums;
}
</style>
