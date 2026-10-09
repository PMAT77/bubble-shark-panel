<script setup lang="ts">
import type { PermissionKey } from '../../../../../shared/constants/permissions'
import type { DataTableColumns, DataTableRowKey, FormInst, FormRules } from 'naive-ui'
import type { CreateInstancePayload, InstallableGameItem, InstanceItem, InstanceStatus, InstanceStatusCounts, InstanceUpdateCheckJobPayload } from '@/api/modules/instance'
import type { NodeListItem } from '@/api/modules/node'
import type { NotificationReactive } from 'naive-ui'
import type { DropdownOption } from 'naive-ui'
import type { DirectoryItem } from '@/api/modules/system'
import { NButton, NButtonGroup, NCheckbox, NDropdown, NStatistic, NTag, NTooltip, useNotification } from 'naive-ui'
import AdminListToolbar from '@/components/AdminListToolbar.vue'
import { statusBadgeClass } from '@/constants/statusDictionary'
import { computed, h, nextTick, onBeforeUnmount, onMounted, reactive, ref, toRefs, watch } from 'vue'
import apiInstance from '@/api/modules/instance'
import apiSystem from '@/api/modules/system'
import {
  routeToConsoleMonitor,
  routeToDstRoomSettings,
  routeToDstWorldSettings,
  routeToInstanceConsole,
  routeToInstanceDetail,
} from '@/navigation/game-routes'
import { blurFocusedElement } from '@/utils'
import {
  tryNotifyHostMemoryPressure,
} from '@/utils/hostMemoryPressure'
import {
  canOpenInstallLog,
  computeUptimeSecondsFromStartedAt,
  formatMemoryMb,
  formatUptime,
  getInstanceState,
  isInstanceInstallingStatus,
  resolveRuntimeReadinessView,
} from '../instanceDisplay'
import {
  buildInstallResultNotification,
  shouldShowPostCreateInstallGuide,
} from '../instanceInstallGuide'
import {
  canForceUpdateInstance,
  canUpdateInstance,
  getUpdateInstanceButtonTitle,
  useInstanceLifecycleActions,
} from '../composables/useInstanceLifecycleActions'
import { useInstanceRuntimeObservability } from '../composables/useInstanceRuntimeObservability'
import { formatDateTime } from '../utils'
import { buildInstanceUpdateCheckNotice, canRetryInstanceInstall, resolveInstanceUpdateState } from '../instanceUpdatePresentation'
import { waitForInstanceUpdateCheckJob } from '../composables/instanceUpdateCheckJob'
import InstanceInstallLogModal from './InstanceInstallLogModal.vue'

defineOptions({
  name: 'NodeInstanceManagementPanel',
})

const props = defineProps<Props>()

interface Props {
  nodes: NodeListItem[]
  steamcmdInstalled: boolean
}

const { nodes, steamcmdInstalled } = toRefs(props)

const notification = useNotification()
const router = useRouter()

const appSettingsStore = useAppSettingsStore()
const isMobileMode = computed(() => appSettingsStore.mode === 'mobile')

const instanceLoading = ref(false)
const updateCheckLoading = ref(false)
const createLoading = ref(false)
const instances = ref<InstanceItem[]>([])
const checkedInstanceIds = ref<DataTableRowKey[]>([])
const selectedInstances = computed(() => instances.value.filter(row => checkedInstanceIds.value.includes(row.id)))
const forceUpdateDisabledReason = computed(() => {
  if (forceUpdateLoading.value) return '正在提交强制校验并更新'
  if (updateCheckLoading.value) return '正在检查更新'
  if (!selectedInstances.value.length) return '请先勾选实例'
  if (selectedInstances.value.some(row => !canForceUpdateInstance(row))) return '请先停止所选实例'
  if (selectedInstances.value.some(row => isInstanceActionRunning(row.id))) return '所选实例正在执行操作'
  return ''
})
const updateMenuOptions = computed<DropdownOption[]>(() => [{
  key: 'force-update',
  label: !selectedInstances.value.length
    ? '强制校验并更新所选实例'
    : forceUpdateDisabledReason.value
      ? `强制校验并更新所选实例（${forceUpdateDisabledReason.value}）`
      : `强制校验并更新所选实例（${selectedInstances.value.length}）`,
  disabled: Boolean(forceUpdateDisabledReason.value) || !steamcmdInstalled.value,
}])

function selectUpdateMenu(key: string) {
  if (key === 'force-update' && !forceUpdateDisabledReason.value && steamcmdInstalled.value) {
    confirmForceUpdateInstances([...selectedInstances.value])
  }
}

function toggleInstanceSelection(id: string, checked: boolean) {
  checkedInstanceIds.value = checked
    ? [...new Set([...checkedInstanceIds.value, id])]
    : checkedInstanceIds.value.filter(key => key !== id)
}

/** 实例生命周期操作：列表页与详情页共用同一套确认/引导/端口冲突处理逻辑 */
const {
  isActionLoading,
  isInstanceActionRunning,
  confirmStartInstance,
  confirmUpdateInstance,
  confirmForceUpdateInstances,
  forceUpdateLoading,
  confirmDangerousInstanceAction,
} = useInstanceLifecycleActions({
  refresh: fetchInstances,
  onBeforeUpdate: suppressInstanceUpdateNotificationForCurrentBatch,
  onUpdateAccepted: openInstallLogModal,
})

const {
  uptimeNowMs,
  syncRuntimeObservabilityPolling,
  stopRuntimeObservability,
  getMetricsForInstance,
} = useInstanceRuntimeObservability(instances)

const keywordFilter = ref('')
const statusFilter = ref<'all' | InstanceStatus>('all')
const selectedNodeId = ref<string>('all')
const createModalVisible = ref(false)
const createGuideVisible = ref(false)
const createFormRef = ref<FormInst | null>(null)
const installableGames = ref<InstallableGameItem[]>([])
const createGuideTarget = ref<{ id: string, name: string } | null>(null)
const installLogVisible = ref(false)
const installLogInstanceName = ref('')
const installLogTargetId = ref('')
/** 安装结束后的列表/版本刷新去重，避免 watch、日志轮询与列表边沿重复触发 */
let installTerminalRefreshInFlight: Promise<void> | null = null
/** 曾处于安装中的实例，用于在列表刷新后补发完成/失败提示 */
const installNotifyPendingIds = new Set<string>()

// --- 常量 ---
/** 列宽总和，启用横向滚动，避免中间列被挤压为 0（操作列移动端收拢为「更多」） */
const INSTANCE_TABLE_SCROLL_X = computed(() => (isMobileMode.value ? 1038 : 1108))
const INSTANCE_INSTALL_POLL_MS = 2000
/** 用户手动关闭通知后记录签名，避免同一批更新反复弹出 */
const UPDATE_NOTIFY_DISMISSED_KEY = 'bsp-instance-update-dismissed'
/** 记录手动关闭通知，跨会话生效（localStorage） */
/** @deprecated 旧版在弹出 toast 时即写入，会阻止通知显示，挂载时清理 */
const UPDATE_NOTIFY_STORAGE_KEY_LEGACY = 'bsp-instance-update-notified'

/** 统计卡：key 对应 statusCounts 字段与状态筛选值，点击即筛选 */
const STAT_CARDS = [
  { key: 'total' as const, label: '全部', filter: 'all' },
  { key: 'pendingInstall' as const, label: '未安装', filter: 'pending_install' },
  { key: 'installing' as const, label: '安装中', filter: 'installing' },
  { key: 'running' as const, label: '运行中', filter: 'running' },
  { key: 'stopped' as const, label: '已停止', filter: 'stopped' },
  { key: 'error' as const, label: '异常', filter: 'error' },
] as const

const instanceUpdateNotificationRef = ref<NotificationReactive | null>(null)
/** 当前已展示通知对应的签名，避免轮询刷新列表时反复销毁/重建 */
const instanceUpdateNotifySignature = ref<string | null>(null)

const createForm = reactive<CreateInstancePayload>({
  nodeId: '',
  name: '',
  gameCode: '',
  installPath: '',
})

/** 单节点部署（本面板的常态）：隐藏「节点」概念，避免新用户困惑 */
const isSingleNode = computed(() => nodes.value.length <= 1)

const nodeOptions = computed(() => {
  return [
    { label: '全部节点', value: 'all' },
    ...nodes.value.map(node => ({ label: node.name, value: node.id })),
  ]
})

const createNodeOptions = computed(() => {
  return nodes.value.map(node => ({ label: node.name, value: node.id }))
})

const createGameOptions = computed(() => {
  return installableGames.value.map(game => ({
    label: `${game.name} (${game.appId})`,
    value: game.appId,
  }))
})

const statusFilterOptions = [
  { label: '全部', value: 'all' },
  { label: '未安装', value: 'pending_install' },
  { label: '运行中', value: 'running' },
  { label: '已停止', value: 'stopped' },
  { label: '安装中', value: 'installing' },
  { label: '异常', value: 'error' },
]

const createFormRules: FormRules = {
  nodeId: [
    {
      required: true,
      message: '请选择节点',
      trigger: ['change', 'blur'],
    },
  ],
  name: [
    {
      required: true,
      trigger: ['input', 'blur'],
      validator: (_rule, value: string) => {
        if (value?.trim()) {
          return true
        }
        return new Error('请输入实例名称')
      },
    },
  ],
  gameCode: [
    {
      required: true,
      trigger: ['change', 'blur'],
      validator: (_rule, value: string) => {
        if (value?.trim()) {
          return true
        }
        return new Error('请选择游戏')
      },
    },
  ],
}

/** 统计卡计数：由后端按节点/关键词范围全量统计，不受状态筛选影响，切换标签时数字保持稳定 */
const statusCounts = ref<InstanceStatusCounts>({
  total: 0,
  pendingInstall: 0,
  running: 0,
  stopped: 0,
  installing: 0,
  error: 0,
})

/** 拉取统计卡计数（跟随节点/关键词范围，刻意不含状态筛选） */
async function fetchStatusCounts() {
  try {
    const res = await apiInstance.getInstanceStatusCounts({
      nodeId: selectedNodeId.value !== 'all' ? selectedNodeId.value : undefined,
      keyword: keywordFilter.value.trim() || undefined,
    })
    statusCounts.value = res.data && typeof res.data === 'object' ? res.data : statusCounts.value
  }
  catch {
    // 全局拦截器已提示错误原因；失败时保留旧计数
  }
}

const instancesWithUpdate = computed(() =>
  instances.value.filter(item => resolveInstanceUpdateState(item) === 'available'),
)

/** 点击统计卡 → 应用对应状态筛选 */
function applyStatusFilter(filter: 'all' | InstanceStatus) {
  statusFilter.value = filter
  void fetchInstances()
}

const instanceColumns = computed<DataTableColumns<InstanceItem>>(() => {
  return [
    ...(hasPermission('instance:update') ? [{ type: 'selection' as const }] : []),
    {
      title: '实例名称',
      key: 'name',
      width: 200,
      render: (row) => {
        const children = [h('span', {
          class: 'cursor-pointer hover:text-primary transition-colors',
          title: '查看实例详情',
          onClick: () => router.push(routeToInstanceDetail(row.id)),
        }, row.name)]
        if (resolveInstanceUpdateState(row) === 'available') {
          children.push(
            h(NTag, { type: 'warning', size: 'small', round: true }, { default: () => '需要更新' }),
          )
        }
        return h('div', { class: 'flex flex-wrap items-center gap-2' }, children)
      },
    },
    {
      title: '游戏',
      key: 'gameCode',
      width: 140,
    },
    ...isSingleNode.value
      ? []
      : [{
          title: '节点',
          key: 'nodeId',
          width: 180,
          render: (row: InstanceItem) => getNodeName(row.nodeId),
        }],
    {
      title: 'CPU',
      key: 'cpu',
      width: 90,
      render: row => renderInstanceCpuColumn(row),
    },
    {
      title: '内存',
      key: 'memory',
      width: 100,
      render: row => renderInstanceMemoryColumn(row),
    },
    {
      title: '运行时长',
      key: 'uptime',
      width: 110,
      render: row => renderInstanceUptimeColumn(row),
    },
    {
      title: '状态',
      key: 'status',
      width: 110,
      render: row => renderInstanceStateColumn(row),
    },
    {
      title: '日志',
      key: 'installLog',
      width: 108,
      render: (row) => {
        const canOpen = canOpenInstallLog(row)
        return h(
          NButton,
          {
            size: 'small',
            secondary: true,
            disabled: !canOpen,
            title: canOpen ? '查看安装日志' : '暂无安装日志',
            onClick: () => openInstallLogModal(row),
          },
          { default: () => '查看日志' },
        )
      },
    },
    {
      title: '更新时间',
      key: 'updatedAt',
      width: 180,
      render: row => formatDateTime(row.updatedAt),
    },
    {
      title: '操作',
      key: 'actions',
      width: isMobileMode.value ? 88 : 180,
      fixed: 'right',
      render: row => renderInstanceRowActions(row),
    },
  ]
})

watch(nodes, (list) => {
  if (!createForm.nodeId && list.length > 0) {
    createForm.nodeId = list[0].id
  }
}, { immediate: true })

/** 数据表行唯一键 */
function getInstanceRowKey(row: InstanceItem) {
  return row.id
}

interface InstanceRowAction {
  key: string
  label: string
  disabled?: boolean
  loading?: boolean
  title?: string
  type?: 'default' | 'error'
  /** 仅桌面端操作列内联展示（不进入「更多」下拉） */
  inlineOnly?: boolean
  /** 仅收进下拉（桌面端操作列不内联展示） */
  menuOnly?: boolean
  onClick: () => void
}

/** 拿当前账号的权限判定；自动导入，无需显式 import */
const { auth: hasPermission } = useAppAuth()

/**
 * 行操作 → 所需权限点。
 *
 * 详情与控制台只要"能读这个实例"，所以用 instance:read —— 它们不改变任何状态；
 * 启停与重启归 instance:lifecycle，更新归 instance:update，删除归 instance:delete。
 */
const INSTANCE_ACTION_PERMISSIONS: Record<InstanceRowAction['key'], PermissionKey> = {
  detail: 'instance:read',
  console: 'instance.console:read',
  update: 'instance:update',
  start: 'instance:lifecycle',
  stop: 'instance:lifecycle',
  restart: 'instance:lifecycle',
  delete: 'instance:delete',
}

/**
 * 行操作全集：详情/控制台/启停在操作列内联展示，
 * 更新/重启/删除收进「更多」下拉；房间设置入口已移入实例详情页。
 *
 * **没有权限的动作直接不生成**：给一个点了必然失败的按钮，比不给更让人困惑。
 */
function buildInstanceRowActions(row: InstanceItem): InstanceRowAction[] {
  const stopAction = row.status === 'installing' || row.status === 'pending_install' ? 'cancel_install' : 'stop'
  const stopLabel = stopAction === 'cancel_install' ? '取消安装' : '停止'
  const instanceActionRunning = isInstanceActionRunning(row.id)
  const actions: InstanceRowAction[] = [
    {
      key: 'detail',
      label: '详情',
      inlineOnly: true,
      onClick: () => router.push(routeToInstanceDetail(row.id)),
    },
    {
      key: 'console',
      label: '控制台',
      inlineOnly: true,
      disabled: instanceActionRunning || row.status === 'pending_install' || row.status === 'installing',
      onClick: () => router.push(routeToInstanceConsole(row.id)),
    },
    {
      key: 'update',
      label: canRetryInstanceInstall(row) ? '重试安装' : '更新',
      menuOnly: true,
      loading: isActionLoading(row.id, 'update'),
      disabled: instanceActionRunning || !canUpdateInstance(row),
      title: getUpdateInstanceButtonTitle(row),
      onClick: () => confirmUpdateInstance(row),
    },
    {
      key: 'start',
      label: '启动',
      menuOnly: true,
      loading: isActionLoading(row.id, 'start'),
      disabled: instanceActionRunning || row.status === 'running' || row.status === 'pending_install' || row.status === 'installing',
      onClick: () => confirmStartInstance(row),
    },
    {
      key: 'stop',
      label: stopLabel,
      menuOnly: true,
      loading: isActionLoading(row.id, 'stop'),
      disabled: instanceActionRunning || row.status === 'stopped' || row.status === 'error',
      onClick: () => confirmDangerousInstanceAction(row, stopAction),
    },
    {
      key: 'restart',
      label: '重启',
      menuOnly: true,
      loading: isActionLoading(row.id, 'restart'),
      disabled: instanceActionRunning || row.status === 'pending_install' || row.status === 'installing',
      onClick: () => confirmDangerousInstanceAction(row, 'restart'),
    },
    {
      key: 'delete',
      label: '删除',
      menuOnly: true,
      type: 'error',
      disabled: instanceActionRunning || row.status === 'pending_install' || row.status === 'installing',
      onClick: () => confirmDangerousInstanceAction(row, 'delete'),
    },
  ]
  return actions.filter(action => hasPermission(INSTANCE_ACTION_PERMISSIONS[action.key]))
}

function actionToDropdownOption(action: InstanceRowAction): DropdownOption {
  const option: DropdownOption = {
    label: action.loading ? `${action.label}…` : action.label,
    key: action.key,
    disabled: Boolean(action.disabled || action.loading),
  }
  if (action.type === 'error') {
    option.props = { class: 'text-red-600 dark:text-red-400' }
  }
  return option
}

/** 「更多」下拉按钮（含 loading 汇总与动作分发） */
function renderActionDropdown(actions: InstanceRowAction[], loadingActions: InstanceRowAction[]) {
  const options = actions.map(actionToDropdownOption)
  const hasLoading = loadingActions.some(action => action.loading)
  return h(
    NDropdown,
    {
      trigger: 'click',
      options,
      onSelect: (key: string) => {
        const action = actions.find(item => item.key === key)
        if (!action || action.disabled || action.loading) {
          return
        }
        action.onClick()
      },
    },
    {
      default: () => h(
        NButton,
        {
          size: 'small',
          secondary: true,
          loading: hasLoading,
        },
        { default: () => '更多' },
      ),
    },
  )
}

function renderInstanceRowActions(row: InstanceItem) {
  const actions = buildInstanceRowActions(row)
  if (!isMobileMode.value) {
    const inlineActions = actions.filter(action => !action.menuOnly)
    const menuActions = actions.filter(action => action.menuOnly)
    const children = inlineActions.map(action => createTextActionButton(action))
    if (menuActions.length > 0) {
      children.push(renderActionDropdown(menuActions, actions))
    }
    return h(
      'div',
      { class: 'flex flex-wrap gap-4' },
      children,
    )
  }

  // 移动端：卡片上已有「详情」「控制台」按钮，下拉提供其余生命周期动作
  const mobileActions = actions.filter(action => !action.inlineOnly)
  return renderActionDropdown(mobileActions, actions)
}

function mobileActionOptions(row: InstanceItem): DropdownOption[] {
  return buildInstanceRowActions(row).filter(action => !action.inlineOnly).map(actionToDropdownOption)
}

function selectMobileAction(row: InstanceItem, key: string) {
  const action = buildInstanceRowActions(row).find(item => item.key === key)
  if (!action || action.disabled || action.loading) {
    return
  }
  action.onClick()
}

function hasMobileActionLoading(row: InstanceItem): boolean {
  return buildInstanceRowActions(row).some(action => action.loading)
}

/** 渲染表格操作列中的文本按钮 */
function createTextActionButton(options: {
  label: string
  disabled?: boolean
  loading?: boolean
  title?: string
  type?: 'default' | 'error'
  onClick: () => void
}) {
  return h(
    NButton,
    {
      size: 'small',
      text: true,
      type: options.type,
      disabled: options.disabled,
      loading: options.loading,
      title: options.title,
      onClick: options.onClick,
    },
    { default: () => options.label },
  )
}

/** 状态列：词典化标签 + 异常退出徽标 + 失败原因摘要（tooltip） */
function renderInstanceStateColumn(row: InstanceItem) {
  const state = getInstanceState(row)
  const tag = h(
    'span',
    {
      class: `text-xs px-2 py-0.5 rounded-full ${statusBadgeClass(state.tone)}`,
    },
    state.label,
  )
  const badges: ReturnType<typeof h>[] = [tag]
  /**
   * 运行中但世界还没就绪：大厅里搜不到这个房间，列表上必须能一眼看出，
   * 否则服主会以为「已经在跑」而去查别的地方。
   */
  const readiness = resolveRuntimeReadinessView(row)
  if (readiness && !row.runtimeReadyAt) {
    badges.push(
      h(
        NTooltip,
        { trigger: 'hover' },
        {
          trigger: () => h(
            'span',
            {
              class: readiness.tone === 'warn'
                ? 'text-xs px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400'
                : 'text-xs px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground',
            },
            readiness.tone === 'warn' ? '未就绪' : '加载中',
          ),
          default: () => `${readiness.label}：加载完成前，玩家在大厅搜不到这个房间`,
        },
      ),
    )
  }
  const unexpectedExitAt = row.unexpectedExitAt?.trim()
  if (unexpectedExitAt) {
    badges.push(
      h(
        NTooltip,
        { trigger: 'hover' },
        {
          trigger: () => h('span', { class: 'text-xs px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-500' }, '异常退出'),
          default: () => `上次运行异常退出（${unexpectedExitAt.replace('T', ' ').slice(0, 19)}）`,
        },
      ),
    )
  }
  const badgeGroup = h('span', { class: 'inline-flex items-center gap-1' }, badges)
  const errorText = row.lastError?.trim()
  if (!errorText || isInstanceInstallingStatus(row.status)) {
    return badgeGroup
  }
  return h(
    NTooltip,
    { trigger: 'hover' },
    {
      trigger: () => badgeGroup,
      default: () => errorText.length > 160 ? `${errorText.slice(0, 160)}…` : errorText,
    },
  )
}

/** 根据节点 ID 解析节点名称 */
function getNodeName(nodeId: string) {
  return nodes.value.find(node => node.id === nodeId)?.name ?? nodeId
}

function formatCpuPercent(rate: number | null | undefined) {
  if (rate === null || typeof rate === 'undefined' || !Number.isFinite(rate)) {
    return '—'
  }
  return `${rate.toFixed(1)}%`
}

function renderRuntimePlaceholder() {
  return h('span', { class: 'text-sm text-muted-foreground' }, '—')
}

function renderInstanceCpuColumn(row: InstanceItem) {
  if (row.status !== 'running') {
    return renderRuntimePlaceholder()
  }
  const metrics = getMetricsForInstance(row.id)
  if (metrics?.cpuUsageRate === null || typeof metrics?.cpuUsageRate === 'undefined') {
    return renderRuntimePlaceholder()
  }
  return h(
    'span',
    {
      class: 'text-sm',
      title: '该实例主世界进程的 CPU 占用（100% 表示占满一个核心）',
    },
    formatCpuPercent(metrics.cpuUsageRate),
  )
}

function renderInstanceMemoryColumn(row: InstanceItem) {
  if (row.status !== 'running') {
    return renderRuntimePlaceholder()
  }
  const metrics = getMetricsForInstance(row.id)
  return h(
    'span',
    {
      class: 'text-sm',
      title: '该实例主世界进程占用的内存',
    },
    formatMemoryMb(metrics?.memoryMb),
  )
}

function getUptimeSecondsForRow(row: InstanceItem) {
  if (row.status !== 'running') {
    return null
  }
  const metricsUptime = getMetricsForInstance(row.id)?.uptimeSeconds ?? null
  if (metricsUptime !== null) {
    return metricsUptime
  }
  return computeUptimeSecondsFromStartedAt(row.runtimeStartedAt, uptimeNowMs.value)
}

function renderInstanceUptimeColumn(row: InstanceItem) {
  if (row.status !== 'running') {
    return renderRuntimePlaceholder()
  }
  return h(
    'span',
    {
      class: 'text-sm',
      title: '自本次启动以来的运行时长',
    },
    formatUptime(getUptimeSecondsForRow(row)),
  )
}

function suppressInstanceUpdateNotificationForCurrentBatch() {
  const signature = buildUpdateNotifySignature(instances.value)
  if (signature) {
    localStorage.setItem(UPDATE_NOTIFY_DISMISSED_KEY, signature)
  }
  dismissInstanceUpdateNotification()
}

function resetCreateForm() {
  createForm.name = ''
  createForm.gameCode = ''
  createForm.installPath = ''
}

function openCreateModal() {
  blurFocusedElement()
  if (!createForm.nodeId && nodes.value.length > 0) {
    createForm.nodeId = nodes.value[0].id
  }
  resetCreateForm()
  if (installableGames.value.length > 0) {
    createForm.gameCode = installableGames.value[0].appId
  }
  createModalVisible.value = true
  nextTick(() => {
    createFormRef.value?.restoreValidation()
  })
}

function closeCreateModal() {
  createModalVisible.value = false
  createFormRef.value?.restoreValidation()
}

// --- 安装目录选择 ---
const dirBrowseVisible = ref(false)
const dirBrowseLoading = ref(false)
/** 当前列出的目录；空串表示最外层的位置列表 */
const dirBrowsePath = ref('')
const dirBrowseItems = ref<DirectoryItem[]>([])
/** 上一级目录；null 表示已在最外层，再往上就回到位置列表 */
const dirBrowseParentPath = ref<string | null>(null)
const dirBrowseError = ref('')
/** 磁盘根（如 D:\ 或 /）：实例不能直接装在根上，这里提前挡掉 */
const isRootBrowsePath = computed(() => /^([a-z]:[\\/]|[\\/])$/i.test(dirBrowsePath.value.trim()))
/** 读取失败或停在根位置时，不允许把当前路径写回表单 */
const canApplyBrowseDirectory = computed(() => (
  Boolean(dirBrowsePath.value) && !dirBrowseError.value && !isRootBrowsePath.value
))

/** 计算上一级目录；已到根（如 / 或 D:\）时返回空串，表示回到根目录列表 */
function resolveParentDirectory(targetPath: string): string {
  const trimmed = targetPath.replace(/[\\/]+$/, '')
  const separatorIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (!trimmed || separatorIndex < 0) {
    return ''
  }
  const parent = trimmed.slice(0, separatorIndex)
  // 'D:' 这类盘符本身不是可列出的目录，同样回到根目录列表
  if (!parent || /^[a-z]:$/i.test(parent)) {
    return ''
  }
  return parent
}

/** 列出目标目录下的子目录：返回 false 表示这次没读到，调用方可以退回根目录列表 */
async function loadBrowseDirectories(targetPath?: string): Promise<boolean> {
  dirBrowseLoading.value = true
  dirBrowseError.value = ''
  try {
    const res = await apiSystem.getDirectoryList(targetPath)
    dirBrowseItems.value = (res.data ?? []).filter(item => item.type === 'directory')
    dirBrowsePath.value = targetPath?.trim() ?? ''
    dirBrowseParentPath.value = dirBrowsePath.value ? resolveParentDirectory(dirBrowsePath.value) : null
    return true
  }
  catch {
    // 具体原因（目录不存在、没有读取权限等）由请求层统一提示，这里只补一句可操作的说明
    dirBrowseItems.value = []
    dirBrowsePath.value = targetPath?.trim() ?? ''
    dirBrowseParentPath.value = dirBrowsePath.value ? resolveParentDirectory(dirBrowsePath.value) : null
    dirBrowseError.value = '这个目录打不开，可以返回上一级或换一个目录再试'
    return false
  }
  finally {
    dirBrowseLoading.value = false
  }
}

async function openDirectoryBrowser() {
  blurFocusedElement()
  dirBrowseVisible.value = true
  const preferredPath = createForm.installPath?.trim()
  // 已填写安装目录时优先定位到它；打不开就退回根目录列表，不把用户留在空列表里
  if (!preferredPath || !(await loadBrowseDirectories(preferredPath))) {
    await loadBrowseDirectories()
  }
}

function enterBrowseDirectory(item: DirectoryItem) {
  if (item.type !== 'directory') {
    return
  }
  void loadBrowseDirectories(item.path)
}

function goBrowseParentDirectory() {
  if (dirBrowseParentPath.value === null) {
    return
  }
  void loadBrowseDirectories(dirBrowseParentPath.value || undefined)
}

function applyBrowseDirectory() {
  if (!canApplyBrowseDirectory.value) {
    return
  }
  createForm.installPath = dirBrowsePath.value
  dirBrowseVisible.value = false
}

function closeDirectoryBrowser() {
  dirBrowseVisible.value = false
}

function closeCreateGuideModal() {
  createGuideVisible.value = false
}

function openPostCreateGuide(instance: Pick<InstanceItem, 'id' | 'name' | 'gameCode' | 'status'>) {
  if (!shouldShowPostCreateInstallGuide(instance)) {
    return
  }
  createGuideTarget.value = { id: instance.id, name: instance.name }
  createGuideVisible.value = true
}

function goToRoomSettingsFromCreateGuide() {
  const target = createGuideTarget.value
  if (!target) {
    return
  }
  createGuideVisible.value = false
  router.push(routeToDstRoomSettings(target.id))
}

function goToWorldSettingsFromCreateGuide() {
  const target = createGuideTarget.value
  if (!target) {
    return
  }
  createGuideVisible.value = false
  router.push(routeToDstWorldSettings(target.id))
}

async function fetchInstallableGames() {
  const res = await apiInstance.getInstallableGames()
  installableGames.value = res.data
}

/** 安装/更新结束后是否应检查 Steam 远端版本（仅成功且已停止） */
function shouldCheckVersionAfterInstall(instanceId: string) {
  if (!steamcmdInstalled.value) {
    return false
  }
  const row = instances.value.find(item => item.id === instanceId)
  if (row?.status === 'error') {
    return false
  }
  return row?.status === 'stopped'
}

/** 安装结束后立即刷新列表（成功或失败），不阻塞于版本检查 */
async function refreshInstancesAfterInstallTerminal() {
  try {
    const res = await apiInstance.getInstanceList({
      nodeId: selectedNodeId.value !== 'all' ? selectedNodeId.value : undefined,
      keyword: keywordFilter.value.trim() || undefined,
    })
    syncInstallTerminalNotifications(res.data)
  }
  catch {
    // 提示补发失败不阻断列表刷新
  }
  await fetchInstances({ silent: true })
}

/** 安装成功后同步 Build ID 与更新通知（后台执行，不阻塞 UI） */
async function refreshVersionStatusAfterSuccessfulInstall(instanceId: string) {
  if (!shouldCheckVersionAfterInstall(instanceId)) {
    return
  }
  void apiInstance.checkInstanceUpdates([instanceId]).catch(() => {})
  await fetchInstances({ silent: true })
}

function notifyInstanceUpdateCheckResult(status: InstanceUpdateCheckJobPayload) {
  if (status.error) {
    faToast.error(status.error)
    return
  }
  const notice = buildInstanceUpdateCheckNotice(status.result?.items ?? [])
  faToast[notice.tone](notice.message)
}

/** 安装结束统一入口：先刷新列表，成功时再检查版本（去重） */
function handleInstallTerminal(preferredInstanceId?: string) {
  if (installTerminalRefreshInFlight) {
    return installTerminalRefreshInFlight
  }
  installTerminalRefreshInFlight = (async () => {
    const instanceId = preferredInstanceId?.trim() || installLogTargetId.value || undefined
    await refreshInstancesAfterInstallTerminal()
    if (instanceId) {
      await refreshVersionStatusAfterSuccessfulInstall(instanceId)
    }
  })().finally(() => {
    installTerminalRefreshInFlight = null
  })
  return installTerminalRefreshInFlight
}

async function openInstallLogModal(instance: InstanceItem) {
  blurFocusedElement()
  installLogTargetId.value = instance.id
  installLogInstanceName.value = instance.name
  installLogVisible.value = true
}

function buildUpdateNotifySignature(list: InstanceItem[]) {
  return list
    .filter(item => resolveInstanceUpdateState(item) === 'available')
    .map(item => `${item.id}:${item.remoteBuildId ?? ''}`)
    .sort()
    .join('|')
}

/** 关闭版本更新全局通知 */
function dismissInstanceUpdateNotification() {
  instanceUpdateNotificationRef.value?.destroy()
  instanceUpdateNotificationRef.value = null
  instanceUpdateNotifySignature.value = null
}

/** 同步「有新版本」全局通知（尊重用户手动关闭记录） */
function syncInstanceUpdateNotification(pending: InstanceItem[]) {
  if (pending.length === 0) {
    dismissInstanceUpdateNotification()
    return
  }
  const signature = buildUpdateNotifySignature(instances.value)
  if (!signature) {
    return
  }
  if (localStorage.getItem(UPDATE_NOTIFY_DISMISSED_KEY) === signature) {
    dismissInstanceUpdateNotification()
    return
  }
  if (instances.value.some(item => isInstanceInstallingStatus(item.status))) {
    dismissInstanceUpdateNotification()
    return
  }
  if (instanceUpdateNotificationRef.value && instanceUpdateNotifySignature.value === signature) {
    return
  }
  const names = pending.map(item => item.name).join('、')
  dismissInstanceUpdateNotification()
  instanceUpdateNotifySignature.value = signature
  instanceUpdateNotificationRef.value = notification.warning({
    title: '游戏服务端需要更新',
    content: `${names} 的版本或游戏文件需要更新。请先停止实例，使用「更多 → 更新」更新后再启动。`,
    duration: 0,
    closable: true,
    onClose: () => {
      localStorage.setItem(UPDATE_NOTIFY_DISMISSED_KEY, signature)
      dismissInstanceUpdateNotification()
    },
  })
}

watch(
  instancesWithUpdate,
  pending => syncInstanceUpdateNotification(pending),
  { deep: true, immediate: true },
)

/** 记录安装中实例，并在其离开安装态后提示结果 */
function syncInstallTerminalNotifications(list: InstanceItem[]) {
  for (const item of list) {
    if (isInstanceInstallingStatus(item.status)) {
      installNotifyPendingIds.add(item.id)
    }
  }
  for (const id of installNotifyPendingIds) {
    const row = list.find(item => item.id === id)
    if (!row) {
      installNotifyPendingIds.delete(id)
      continue
    }
    if (isInstanceInstallingStatus(row.status)) {
      continue
    }
    installNotifyPendingIds.delete(id)
    const notifyPayload = buildInstallResultNotification(row)
    if (!notifyPayload) {
      continue
    }
    if (notifyPayload.type === 'success') {
      notification.success({
        title: notifyPayload.title,
        content: notifyPayload.content,
        duration: notifyPayload.durationMs,
      })
    }
    else {
      notification.error({
        title: notifyPayload.title,
        content: notifyPayload.content,
        duration: notifyPayload.durationMs,
      })
    }
  }
}

/** 按当前筛选条件拉取实例列表 */
async function fetchInstances(options?: { silent?: boolean }) {
  if (!options?.silent) {
    instanceLoading.value = true
  }
  try {
    const [res] = await Promise.all([
      apiInstance.getInstanceList({
        nodeId: selectedNodeId.value !== 'all' ? selectedNodeId.value : undefined,
        status: statusFilter.value !== 'all' ? statusFilter.value : undefined,
        keyword: keywordFilter.value.trim() || undefined,
      }),
      fetchStatusCounts(),
    ])
    // 接口异常时 data 可能不是数组：这里兜一次，否则下游 .filter/.some 会抛错，
    // 而页面组件渲染抛错会让整个内容区停止更新（只能刷新恢复）
    instances.value = Array.isArray(res.data) ? res.data : []
    checkedInstanceIds.value = checkedInstanceIds.value.filter(id => instances.value.some(row => row.id === id))
    syncInstallTerminalNotifications(instances.value)
    syncRuntimeObservabilityPolling()
  }
  catch {
    // 全局拦截器已提示错误原因；轮询/刷新失败时保留旧列表，避免安装进度闪空
  }
  finally {
    if (!options?.silent) {
      instanceLoading.value = false
    }
  }
}

/** 关键词搜索：触发列表刷新 */
async function searchInstances() {
  await fetchInstances()
}

async function checkAllInstanceUpdates() {
  // 按钮在未就绪时已禁用并带说明；此处仅兜底
  if (!steamcmdInstalled.value || instances.value.length === 0) {
    return
  }
  updateCheckLoading.value = true
  faToast.info('正在检查更新…', {
    duration: 6000,
  })
  try {
    const startRes = await apiInstance.checkInstanceUpdates()
    const finalStatus = startRes.data.checking
      ? await waitForInstanceUpdateCheckJob()
      : startRes.data
    await fetchInstances()
    notifyInstanceUpdateCheckResult(finalStatus)
  }
  catch (error) {
    faToast.error(error instanceof Error ? error.message : '版本检查失败，请稍后重试')
  }
  finally {
    updateCheckLoading.value = false
  }
}

async function refreshInstancesAndResetKeyword() {
  keywordFilter.value = ''
  await fetchInstances()
}

async function createInstance() {
  try {
    await createFormRef.value?.validate()
  }
  catch {
    return
  }

  createLoading.value = true
  try {
    const created = await apiInstance.createInstance({
      nodeId: createForm.nodeId,
      name: createForm.name.trim(),
      gameCode: createForm.gameCode,
      installPath: createForm.installPath?.trim() || undefined,
    })
    faToast.success('实例创建成功，正在安装')
    createModalVisible.value = false
    resetCreateForm()
    await fetchInstances()
    openPostCreateGuide(created.data as InstanceItem)
  }
  catch (error) {
    if (tryNotifyHostMemoryPressure(notification, error, () => router.push(routeToConsoleMonitor()))) {
      return
    }
  }
  finally {
    createLoading.value = false
  }
}

onMounted(async () => {
  sessionStorage.removeItem(UPDATE_NOTIFY_STORAGE_KEY_LEGACY)
  localStorage.removeItem(UPDATE_NOTIFY_STORAGE_KEY_LEGACY)
  await Promise.all([
    fetchInstallableGames(),
    fetchInstances(),
  ])
  syncRuntimeObservabilityPolling()
})

let hadInstallingInstance = false
const instancePollingTimer = setInterval(() => {
  const hasInstalling = instances.value.some(item => isInstanceInstallingStatus(item.status))
  if (hasInstalling) {
    hadInstallingInstance = true
    void fetchInstances({ silent: true })
    return
  }
  if (hadInstallingInstance) {
    hadInstallingInstance = false
    void handleInstallTerminal()
  }
}, INSTANCE_INSTALL_POLL_MS)

onBeforeUnmount(() => {
  clearInterval(instancePollingTimer)
  stopRuntimeObservability()
  dismissInstanceUpdateNotification()
})
</script>

<template>
  <FaPageMain title="实例管理">
    <section class="p-4 border border-border rounded-xl bg-card space-y-4">
      <div class="gap-3 grid grid-cols-3 md:grid-cols-6">
        <button
          v-for="card in STAT_CARDS"
          :key="card.key"
          type="button"
          class="p-3 rounded-md bg-muted/40 text-left transition-colors hover:bg-muted/70 cursor-pointer"
          :class="{ 'ring-2 ring-primary/60': statusFilter === card.filter }"
          :title="`只看「${card.label}」实例`"
          @click="applyStatusFilter(card.filter)"
        >
          <NStatistic :label="card.label" tabular-nums>
            <template #default>
              <span
                class="text-lg font-semibold"
                :class="{
                  'text-emerald-600 dark:text-emerald-400': card.key === 'running',
                  'text-sky-600 dark:text-sky-400': card.key === 'installing',
                  'text-slate-600 dark:text-slate-300': card.key === 'stopped' || card.key === 'pendingInstall',
                  'text-red-600 dark:text-red-400': card.key === 'error',
                }"
              >
                {{ statusCounts[card.key] }}
              </span>
            </template>
          </NStatistic>
        </button>
      </div>

      <AdminListToolbar
        v-model:keyword="keywordFilter"
        keyword-placeholder="实例名称 / 游戏"
        :search-loading="instanceLoading"
        :reset-disabled="!keywordFilter && selectedNodeId === 'all' && statusFilter === 'all'"
        @search="searchInstances"
        @reset="refreshInstancesAndResetKeyword"
      >
        <template #filters>
          <NSelect
            v-if="!isSingleNode"
            v-model:value="selectedNodeId"
            :options="nodeOptions"
            class="w-full md:w-44"
            placeholder="节点"
            @update:value="fetchInstances"
          />
          <NSelect
            v-model:value="statusFilter"
            :options="statusFilterOptions"
            class="w-full md:w-44"
            placeholder="状态"
            @update:value="fetchInstances"
          />
        </template>
        <template #actions>
          <!-- 检查更新只是查询，但后端这条接口也要 instance:update（结果只对"能更新的人"有意义） -->
          <AppAuth value="instance:update">
            <NButtonGroup class="flex-1 min-w-0 md:flex-none">
              <NButton
                class="flex-1"
                type="warning"
                strong
                secondary
                :loading="updateCheckLoading"
                :disabled="!steamcmdInstalled || instances.length === 0 || forceUpdateLoading"
                @click="checkAllInstanceUpdates"
              >
                <template #icon>
                  <FaIcon name="i-ri:refresh-line" />
                </template>
                检查更新
              </NButton>
              <NDropdown trigger="click" :options="updateMenuOptions" @select="selectUpdateMenu">
                <NButton
                  type="warning"
                  secondary
                  aria-label="更新操作菜单"
                  :loading="forceUpdateLoading"
                  :disabled="!steamcmdInstalled || instances.length === 0 || updateCheckLoading || forceUpdateLoading"
                >
                  <template #icon><FaIcon name="i-ri:arrow-down-s-line" /></template>
                </NButton>
              </NDropdown>
            </NButtonGroup>
            <span v-if="checkedInstanceIds.length" class="self-center text-xs text-muted-foreground">已选 {{ checkedInstanceIds.length }} 个实例</span>
          </AppAuth>
          <AppAuth value="instance:create">
            <NButton class="flex-1 min-w-0 md:flex-none" type="primary" @click="openCreateModal">
              <template #icon>
                <FaIcon name="i-ri:add-line" />
              </template>
              创建实例
            </NButton>
          </AppAuth>
        </template>
      </AdminListToolbar>

      <div v-if="isMobileMode" class="min-h-80 space-y-3" :aria-busy="instanceLoading">
        <div v-if="!instanceLoading && instances.length === 0" class="py-10 px-4 mx-auto max-w-md text-center space-y-3">
          <p class="text-base font-medium">
            三步开启你的饥荒服务器
          </p>
          <ol class="list-decimal list-inside space-y-1 text-sm text-muted-foreground text-left">
            <li>创建实例 —— 选择游戏，自动完成安装</li>
            <li>配置房间与世界 —— 服务器名、密码、地图</li>
            <li>启动实例 —— 把服务器名告诉朋友即可加入</li>
          </ol>
          <AppAuth value="instance:create">
            <NButton type="primary" @click="openCreateModal">
                创建第一个实例
            </NButton>
          </AppAuth>
        </div>
        <article
          v-for="instance in instances"
          :key="instance.id"
          class="rounded-lg border border-border bg-card p-4 space-y-3"
        >
          <div class="flex items-start justify-between gap-3">
            <AppAuth value="instance:update">
              <NCheckbox
                :checked="checkedInstanceIds.includes(instance.id)"
                :aria-label="`选择实例 ${instance.name}`"
                @update:checked="checked => toggleInstanceSelection(instance.id, checked)"
              />
            </AppAuth>
            <div class="min-w-0">
              <h2 class="truncate font-medium">
                {{ instance.name }}
              </h2>
              <p class="mt-1 truncate text-xs text-muted-foreground">
                {{ getNodeName(instance.nodeId) }} · {{ instance.gameCode }}
              </p>
            </div>
            <NTag size="small" :bordered="false" :class="statusBadgeClass(getInstanceState(instance).tone)">
              {{ getInstanceState(instance).label }}
            </NTag>
          </div>
          <dl class="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
            <div>
              <dt class="text-muted-foreground">CPU（单核基准）</dt>
              <dd>{{ formatCpuPercent(getMetricsForInstance(instance.id)?.cpuUsageRate) }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">内存（主世界进程）</dt>
              <dd>{{ getMetricsForInstance(instance.id)?.memoryMb == null ? '—' : formatMemoryMb(getMetricsForInstance(instance.id)?.memoryMb ?? 0) }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">运行时长</dt>
              <dd>{{ formatUptime(computeUptimeSecondsFromStartedAt(instance.runtimeStartedAt, uptimeNowMs)) }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">更新时间</dt>
              <dd>{{ formatDateTime(instance.updatedAt) }}</dd>
            </div>
          </dl>
          <div class="flex gap-2">
            <NButton class="flex-1" type="primary" secondary @click="router.push(routeToInstanceDetail(instance.id))">
              详情
            </NButton>
            <NButton class="flex-1" :disabled="instance.status === 'pending_install' || instance.status === 'installing'" @click="router.push(routeToInstanceConsole(instance.id))">
              控制台
            </NButton>
            <NDropdown
              trigger="click"
              :options="mobileActionOptions(instance)"
              @select="key => selectMobileAction(instance, String(key))"
            >
              <NButton secondary :loading="hasMobileActionLoading(instance)">
                更多
              </NButton>
            </NDropdown>
          </div>
        </article>
      </div>
      <div v-else class="min-h-80 overflow-x-auto">
        <NDataTable
          v-model:checked-row-keys="checkedInstanceIds"
          :bordered="false"
          :single-line="false"
          size="small"
          :scroll-x="INSTANCE_TABLE_SCROLL_X"
          :columns="instanceColumns"
          :data="instances"
          :row-key="getInstanceRowKey"
          :loading="instanceLoading"
          class="w-full"
        >
          <template #empty>
            <div class="py-10 mx-auto max-w-md text-center space-y-3">
              <p class="text-base font-medium">
                三步开启你的饥荒服务器
              </p>
              <ol class="list-decimal list-inside space-y-1 text-sm text-muted-foreground text-left">
                <li>创建实例 —— 选择游戏，自动完成安装</li>
                <li>配置房间与世界 —— 服务器名、密码、地图</li>
                <li>启动实例 —— 把服务器名告诉朋友即可加入</li>
              </ol>
              <NButton type="primary" @click="openCreateModal">
                创建第一个实例
              </NButton>
            </div>
          </template>
        </NDataTable>
      </div>
    </section>

    <NModal
      v-model:show="createModalVisible"
      preset="card"
      title="创建实例"
      :style="{ width: '640px' }"
    >
      <NForm
        ref="createFormRef"
        :model="createForm"
        :rules="createFormRules"
        label-placement="left"
        class="space-y-3"
      >
        <NFormItem v-if="!isSingleNode" label="目标节点" path="nodeId">
          <NSelect
            v-model:value="createForm.nodeId"
            :options="createNodeOptions"
            placeholder="请选择目标节点"
          />
        </NFormItem>
        <NFormItem label="实例名称" path="name">
          <NInput v-model:value="createForm.name" placeholder="如：饥荒联机#1" />
        </NFormItem>
        <NFormItem label="游戏" path="gameCode">
          <NSelect
            v-model:value="createForm.gameCode"
            :options="createGameOptions"
            placeholder="请选择要安装的游戏"
          />
        </NFormItem>
        <NCollapse class="mt-1">
          <NCollapseItem title="高级选项" name="advanced">
            <p class="mb-2 text-xs text-muted-foreground">
              保持默认即可；如需自定义安装目录再填写。
            </p>
            <NFormItem label="安装目录" path="installPath">
              <div class="flex items-center gap-2 w-full">
                <NInput v-model:value="createForm.installPath" class="flex-1" placeholder="默认自动分配" />
                <!--
                  目录浏览走的是 `/app/system/filesystem/directories`（settings:write）：
                  没有这个权限就把入口收起来，输入框仍可手填路径——点开只会报 403。
                -->
                <AppAuth value="settings:write">
                  <NButton class="shrink-0" @click="openDirectoryBrowser">
                    浏览
                  </NButton>
                </AppAuth>
              </div>
            </NFormItem>
          </NCollapseItem>
        </NCollapse>
      </NForm>

      <template #footer>
        <NSpace justify="end">
          <NButton @click="closeCreateModal">
            取消
          </NButton>
          <NButton type="primary" :loading="createLoading" @click="createInstance">
            确定
          </NButton>
        </NSpace>
      </template>
    </NModal>

    <NModal
      v-model:show="dirBrowseVisible"
      preset="card"
      title="选择安装目录"
      :style="{ width: '560px' }"
    >
      <div class="space-y-3">
        <div class="flex items-center gap-2">
          <div class="flex-1 min-w-0 text-xs text-muted-foreground truncate">
            {{ dirBrowsePath || '选择要安装到的位置' }}
          </div>
          <NButton
            size="small"
            secondary
            :disabled="dirBrowseParentPath === null"
            @click="goBrowseParentDirectory"
          >
            返回上一级
          </NButton>
        </div>

        <div class="h-64 overflow-auto border border-border/70 rounded-lg">
          <div v-if="dirBrowseLoading" class="py-10 text-center text-sm text-muted-foreground">
            正在读取…
          </div>
          <div v-else-if="dirBrowseError" class="p-4 text-center text-sm text-rose-600 dark:text-rose-400">
            {{ dirBrowseError }}
          </div>
          <div v-else-if="dirBrowseItems.length === 0" class="py-10 text-center text-sm text-muted-foreground">
            这个目录下没有子目录
          </div>
          <button
            v-for="item in dirBrowseItems"
            :key="item.path"
            type="button"
            class="flex items-center w-full px-3 py-2 text-sm text-left transition-colors hover:bg-muted/70 cursor-pointer"
            @click="enterBrowseDirectory(item)"
          >
            <span class="truncate">{{ item.name }}</span>
          </button>
        </div>

        <p v-if="isRootBrowsePath" class="text-xs text-amber-600 dark:text-amber-400">
          磁盘根目录不能直接作为安装目录，请进入一个子目录后再选择。
        </p>
        <p v-else class="text-xs text-muted-foreground">
          点开子目录后，可以用「选择当前目录」把所在位置填到安装目录里。
        </p>
      </div>

      <template #footer>
        <NSpace justify="end">
          <NButton @click="closeDirectoryBrowser">
            取消
          </NButton>
          <NButton type="primary" :disabled="!canApplyBrowseDirectory" @click="applyBrowseDirectory">
            选择当前目录
          </NButton>
        </NSpace>
      </template>
    </NModal>

    <NModal
      v-model:show="createGuideVisible"
      preset="card"
      title="安装进行中"
      :style="{ width: '560px' }"
      :mask-closable="false"
    >
      <div class="space-y-3 text-sm leading-relaxed text-foreground">
        <p>
          实例「{{ createGuideTarget?.name || 'DST 实例' }}」正在安装，可能需要几分钟，完成后会提醒你。
        </p>
        <p>
          等待期间可以先配置房间与世界参数。
        </p>
      </div>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="closeCreateGuideModal">
            稍后再说
          </NButton>
          <!--
            这两个入口各指向另一个模块的页面（世界管理 / 房间管理），且都是**按路由名**跳转。
            面板的路由按权限动态注册：目标模块无权时那条路由不存在，点了会在解析阶段抛 No match，
            看起来就是按钮失灵——所以无权时直接不出现。
          -->
          <NButton v-if="hasPermission('world:read')" @click="goToWorldSettingsFromCreateGuide">
            去配置世界
          </NButton>
          <NButton v-if="hasPermission('room:read')" type="primary" @click="goToRoomSettingsFromCreateGuide">
            去配置房间
          </NButton>
        </NSpace>
      </template>
    </NModal>

    <InstanceInstallLogModal
      v-model:show="installLogVisible"
      :instance-id="installLogTargetId"
      :instance-name="installLogInstanceName"
      @terminal="handleInstallTerminal"
    />
  </FaPageMain>
</template>

