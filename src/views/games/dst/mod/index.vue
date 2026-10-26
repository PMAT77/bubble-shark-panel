<script setup lang="ts">
import { createInstanceActionScope, updateModSubscription } from './modSubscriptionActions'
/** 当前账号的权限判定；按钮级隐藏用，后端仍是唯一的安全边界 */
const { auth: hasPermission } = useAppAuth()

import type { DataTableColumns } from 'naive-ui'
import type {
  ModInstallStatus,
  ModItemDto,
  SteamModListQueryResultItem,
  SteamModListMeta,
  SteamModSort,
  SteamModTrendDays,
} from '@/api/modules/mod'
import type { InstanceSummaryItem } from '@/api/modules/instance'
import { useDebounceFn, useElementSize } from '@vueuse/core'
import { GripVertical } from 'lucide-vue-next'
import { useSortable } from '@vueuse/integrations/useSortable'
import type { SortableEvent } from 'sortablejs'
import { moveModLoadOrder } from './modLoadOrder'
import { renderModPreview } from './modPreview'
import type { NotificationReactive } from 'naive-ui'
import { NAlert, NButton, NCheckbox, NDataTable, NEmpty, NImage, NInput, NPagination, NPopover, NRate, NSelect, NTabPane, NTabs, NTag, useDialog, useMessage, useNotification } from 'naive-ui'
import AdminListToolbar from '@/components/AdminListToolbar.vue'
import { computed, h, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import apiInstance from '@/api/modules/instance'
import apiMod from '@/api/modules/mod'
import type { ModDownloadQueueDto } from '@/api/modules/mod'
import { isInstallableGameInstance } from '@/composables/useGameInstance'
import { useInstanceModState } from '@/composables/useInstanceModState'
import { useTaskRowProgress, type TaskRowProgress } from '@/composables/useTaskRowProgress'
import '@/composables/taskRowProgress.css'
import ModConfigModal from '@/views/games/dst/mod/components/ModConfigModal.vue'
import LocalModImportModal from '@/views/games/dst/mod/components/LocalModImportModal.vue'
import ModAccessStatusPanel from '@/views/games/dst/mod/components/ModAccessStatusPanel.vue'
import { resolveModDownloadAction, resolveModDownloadItemLabel } from '@/views/games/dst/mod/modDownloadPresentation'
import { resolveModUpdateCheckNotice } from '@/views/games/dst/mod/modUpdateCheckPresentation'
import { countOutdatedMods, resolveUpdateIneffectiveNotice, selectUpdatableMods } from '@/views/games/dst/mod/modUpdateTargets'
import { routeToDstModDetail, routeToNodeInstance } from '@/navigation/game-routes'
import { MOD_INSTALL_STATUS, MOD_UPDATE_STATUS } from '@/constants/statusDictionary'
import { getInstanceState } from '@/views/node/instance/instanceDisplay'
import ModEnabledControl from './components/ModEnabledControl.vue'
import SubscribedModActions from './components/SubscribedModActions.vue'
import SubscribedModStatus from './components/SubscribedModStatus.vue'
import { keyboardTabProps } from '@/utils/keyboardTab'

defineOptions({
  name: 'DstModList',
})

const router = useRouter()
const route = useRoute()
const message = useMessage()
const dialog = useDialog()
const notification = useNotification()
const appSettingsStore = useAppSettingsStore()
const listElement = ref<HTMLElement | null>(null)
const { width: listWidth } = useElementSize(listElement)
const isMobileMode = computed(() => appSettingsStore.mode === 'mobile' || (listWidth.value > 0 && listWidth.value < 960))
const addModOpen = ref(false)

/** 订阅成功引导卡：持久展示，引导用户去世界设置开启 Mod */
const subscribeGuideNotificationRef = ref<NotificationReactive | null>(null)
/** 服务端下发的 Mod 风险提示横幅（加载列表/切换开关时更新） */
const riskTipBanner = ref<string | null>(null)
/** 面板请求失败与上游不可达分别展示，避免把连接问题当成搜索无结果。 */
const steamLoadError = ref<string | null>(null)

interface BusinessErrorLike {
  error?: string
  code?: string
}

const loadingInstances = ref(false)
const loadingSteam = ref(false)
const loadingInstalled = ref(false)
/** 「检查更新」进行中：期间禁用按钮，避免并发打 Steam */
const checkingUpdates = ref(false)
/** 「重试全部失败」进行中 */
const retryingFailedMods = ref(false)
const unsubscribingWorkshopIds = ref<Set<string>>(new Set())
const checkedRowKeys = ref<Array<string | number>>([])
const batchUpdating = ref(false)
/** 加载顺序保存中，避免并发提交。 */
const reorderingMods = ref(false)
const configModalShow = ref(false)
const localImportShow = ref(false)
let listRequest = 0
let renderedSteamQuery = ''
let attemptedSteamQuery = ''
let pendingSteamQuery = ''
let pageActive = true
const modInstanceStatus = ref('')
const configTarget = ref<{ workshopId: string, name: string } | null>(null)
const instances = ref<InstanceSummaryItem[]>([])
const selectedInstanceId = ref('')
const actionScope = createInstanceActionScope(() => selectedInstanceId.value)
watch(selectedInstanceId, () => {
  actionScope.invalidate()
  configModalShow.value = false
  configTarget.value = null
  localImportShow.value = false
  unsubscribingWorkshopIds.value = new Set()
  batchUpdating.value = false
  retryingFailedMods.value = false
  queueActionPending.value = false
  checkingUpdates.value = false
  reorderingMods.value = false
  addModOpen.value = false
  manualWorkshopInput.value = ''
  manualWorkshopError.value = ''
  manualSubscribing.value = false
}, { flush: 'sync' })
const {
  downloadingMods,
  downloadQueue,
  isPendingWorkshop,
  restoreInstallJobs,
  installMod,
  syncPendingWorkshopIds,
  refreshQueue,
  resetState,
} = useInstanceModState(() => selectedInstanceId.value)
const activeTab = ref<'market' | 'subscribed'>(route.query.tab === 'market' ? 'market' : 'subscribed')
const steamKeyword = ref('')
const steamSort = ref<SteamModSort>('trend')
const steamTrendDays = ref<SteamModTrendDays>(7)
const steamPage = ref(1)
const steamPageSize = ref(20)
const steamHasMore = ref(false)
const steamTotalCount = ref<number | null>(null)
const steamTotalPages = ref<number | null>(null)
const steamSourceUrl = ref('')
const steamMods = ref<SteamModListQueryResultItem[]>([])
const installedMods = ref<ModItemDto[]>([])
const taskRows = computed<TaskRowProgress[]>(() => {
  const queue = downloadQueue.value
  if (!queue || queue.instanceId !== selectedInstanceId.value) return []
  return queue.items.map(item => ({ id: item.workshopId, taskId: item.taskId, percent: item.progress?.percent,
    state: item.phase === 'ready' ? 'success' : item.phase === 'failed' ? 'failed'
      : queue.status === 'paused' || queue.status === 'pausing' || item.phase === 'retry_wait' ? 'paused'
        : queue.currentWorkshopIds.includes(item.workshopId) ? 'active' : 'inactive' }))
})
const modRowProgress = useTaskRowProgress(taskRows)
function bindModProgressSurface(element: unknown) { modRowProgress.surface.value = element as HTMLElement | null }
watch(selectedInstanceId, modRowProgress.reset, { flush: 'sync' })
watch([activeTab, isMobileMode], async () => { await nextTick(); modRowProgress.scheduleMeasure() }, { flush: 'post' })
const steamMeta = ref<SteamModListMeta | null>(null)
const steamAbortController = shallowRef<AbortController | null>(null)
const accessStatusPanel = ref<InstanceType<typeof ModAccessStatusPanel> | null>(null)

/** 离线兜底数据展示用：把 ISO 时间转成本地可读格式 */
function formatDateTime(value: string | null): string {
  if (!value) {
    return '未知时间'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return '未知时间'
  }
  const pad = (input: number) => String(input).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function goToModDetail(workshopId: string) {
  if (!selectedInstanceId.value) {
    message.warning('请先选择实例')
    return
  }
  router.push(routeToDstModDetail(workshopId, selectedInstanceId.value))
}

function renderModRating(rating: number | null) {
  if (rating === null) {
    return h('span', { class: 'text-xs text-muted-foreground' }, '-')
  }
  return h(NRate, {
    readonly: true,
    allowHalf: true,
    size: 'small',
    value: rating,
  })
}

const resolvedPageCount = computed(() => {
  if (steamTotalPages.value !== null) {
    return steamTotalPages.value
  }
  if (steamTotalCount.value !== null && steamPageSize.value > 0) {
    return steamTotalCount.value === 0
      ? 0
      : Math.max(1, Math.ceil(steamTotalCount.value / steamPageSize.value))
  }
  return steamHasMore.value ? steamPage.value + 1 : steamPage.value
})

const steamPagingSummary = computed(() => {
  if (steamTotalCount.value === null && steamTotalPages.value === null) {
    return ''
  }
  const parts: string[] = []
  if (steamTotalCount.value !== null) {
    parts.push(`共 ${steamTotalCount.value} 条`)
  }
  if (resolvedPageCount.value > 0) {
    parts.push(`${resolvedPageCount.value} 页`)
  }
  return parts.join(' · ')
})

const pagination = computed(() => ({
  page: steamPage.value,
  pageSize: steamPageSize.value,
  pageCount: resolvedPageCount.value,
  itemCount: steamTotalCount.value ?? undefined,
  showSizePicker: false,
  onChange: (page: number) => {
    if (page === steamPage.value) {
      return
    }
    const maxPage = resolvedPageCount.value
    if (maxPage > 0 && (page < 1 || page > maxPage)) {
      return
    }
    if (maxPage === 0) {
      return
    }
    if (steamTotalPages.value === null && steamTotalCount.value === null && page > steamPage.value && !steamHasMore.value) {
      return
    }
    steamPage.value = page
    void loadSteamMods(false)
  },
}))

function changeSteamPage(page: number) {
  pagination.value.onChange(page)
}

const instanceOptions = computed(() => {
  return instances.value.map((instance) => {
    const state = getInstanceState(instance)
    const needsHint = !['running', 'stopped'].includes(state.key)
    return {
      label: needsHint ? `${instance.name}（${state.label}）` : instance.name,
      value: instance.id,
    }
  })
})

const isSteamTrendSort = computed(() => steamSort.value === 'trend')
const hasSteamKeyword = computed(() => Boolean(steamKeyword.value.trim()))
const hasInstallableInstances = computed(() => instances.value.length > 0)
const instanceSelectPlaceholder = computed(() => {
  if (hasInstallableInstances.value) {
    return '请选择要管理的 DST 实例'
  }
  return '暂无可管理的 DST 实例'
})
const hasSelectedInstance = computed(() => Boolean(selectedInstanceId.value))
const marketEmptyDescription = computed(() => {
  if (!selectedInstanceId.value) {
    return '请先选择实例'
  }
  if (steamLoadError.value || steamMeta.value?.upstreamUnavailable) {
    return steamLoadError.value ? '市场列表加载失败' : '暂时无法连接 Steam 创意工坊'
  }
  if (steamKeyword.value.trim()) {
    return '未找到符合条件的 Mod'
  }
  return '暂无 Mod 数据'
})
const marketConnectionTitle = computed(() => steamLoadError.value ? '市场列表加载失败'
  : steamMeta.value?.upstreamUnavailable || steamMeta.value?.offline ? '暂时无法连接 Steam 创意工坊' : '')
const subscribedEmptyDescription = computed(() => {
  if (!selectedInstanceId.value) {
    return '请先选择实例'
  }
  if (downloadingMods.value.length > 0) {
    return '订阅的 Mod 下载中，完成后会出现在列表里'
  }
  return '暂无已订阅 Mod'
})
const subscribedTabCount = computed(() => installedMods.value.length)
/** 已订阅 Mod 的概览：就绪 / 下载中 / 失败，导入存档后可据此一眼看出「有没有下全」 */
const subscribedSummary = computed(() => {
  const total = installedMods.value.length
  const pending = installedMods.value.filter(mod =>
    mod.installStatus === 'pending' || isPendingWorkshop(mod.workshopId),
  ).length
  const failed = installedMods.value.filter(mod =>
    mod.installStatus === 'failed' && !isPendingWorkshop(mod.workshopId),
  ).length
  const outdated = countOutdatedMods(installedMods.value)
  const unidentified = installedMods.value.filter(mod => !isModNameIdentified(mod)).length
  return { total, pending, failed, outdated, unidentified, ready: total - pending - failed }
})
const selectedUpdatableMods = computed(() => selectUpdatableMods(
  installedMods.value.filter(mod => checkedRowKeys.value.includes(mod.workshopId)),
  isPendingWorkshop,
))

/**
 * 列表上方的提示：优先说「有 Mod 没识别出名称」，其次是「还没检查过版本」。
 * 两者都指向同一个动作——「检查更新」，它会按创意工坊信息同时补全名称与版本状态。
 */
const modCheckHint = computed(() => {
  const { unidentified } = subscribedSummary.value
  if (unidentified > 0) {
    return `有 ${unidentified} 个 Mod 没识别出名称，点「检查更新」可按创意工坊信息补全。`
  }
  const neverChecked = installedMods.value.filter(mod => !mod.updateCheckedAt).length
  if (neverChecked > 0) {
    return `有 ${neverChecked} 个 Mod 还没检查过版本，点「检查更新」可确认是否最新。`
  }
  return null
})

/** 明显不是 Mod 名字的脏值：这些名字要在列表里标出来并引导用户去「检查更新」补全 */
const UNIDENTIFIED_MOD_NAME_PATTERN = /^(null|undefined|nil|nan|false|true)$/i

/** 名称是否已识别：服务端会把无法识别的名字兜底成 workshop-<id> */
function isModNameIdentified(mod: ModItemDto): boolean {
  const name = mod.name?.trim() ?? ''
  return Boolean(name)
    && name !== `workshop-${mod.workshopId}`
    && !UNIDENTIFIED_MOD_NAME_PATTERN.test(name)
}

/** 最近一次版本检查时间（取全列表最新的一条），用于工具条上的「上次检查 X 前」 */
const lastUpdateCheckedAt = computed(() => {
  let latest = ''
  let latestMs = 0
  for (const mod of installedMods.value) {
    const parsed = mod.updateCheckedAt ? Date.parse(mod.updateCheckedAt) : Number.NaN
    if (Number.isFinite(parsed) && parsed > latestMs) {
      latestMs = parsed
      latest = mod.updateCheckedAt ?? ''
    }
  }
  return latest
})

/** 只有「创意工坊上有新版本」的 Mod 才给「更新」入口；未知状态另给「重新下载」兜底 */
function isModUpdatable(mod: ModItemDto): boolean {
  return selectUpdatableMods([mod], isPendingWorkshop).length === 1
}

/**
 * 「全部更新」的目标与计数用同一份口径：正在下载中的 Mod 不算目标，
 * 否则按钮会显示 N 个、点下去却因为都被过滤掉而提示「没有需要更新的 Mod」。
 */
const updatableMods = computed(() => selectUpdatableMods(installedMods.value, isPendingWorkshop))

function canRedownloadMod(mod: ModItemDto): boolean {
  return mod.installStatus === 'ready'
    && mod.updateStatus === 'unknown'
    && !isPendingWorkshop(mod.workshopId)
}

/** 无法判断版本的原因提示：让「未检查」与「查不到」区分开，而不是笼统一句不知道 */
function modUpdateTooltip(mod: ModItemDto): string {
  if (mod.updateStatus === 'outdated') {
    return '创意工坊上有更新的版本，点「更新」重新下载后再重启实例'
  }
  if (mod.updateStatus === 'up_to_date') {
    return `与已保存的工坊版本一致${mod.updateCheckedAt ? `（检查于 ${formatCheckedAt(mod.updateCheckedAt)}）` : '（检查时间未知）'}；可再次检查获取当前版本`
  }
  if (mod.installStatus !== 'ready') {
    return 'Mod 尚未下载完成，暂不判断版本'
  }
  if (!mod.updateCheckedAt) {
    return '尚未检查版本，点「检查更新」可从创意工坊判断是否最新'
  }
  return '创意工坊或本机缺少该 Mod 的版本信息，无法判断（可重新下载）'
}

function formatCheckedAt(iso: string): string {
  const parsed = Date.parse(iso)
  if (!Number.isFinite(parsed)) {
    return '-'
  }
  const diffMinutes = Math.floor((Date.now() - parsed) / 60000)
  if (diffMinutes < 1) {
    return '刚刚'
  }
  if (diffMinutes < 60) {
    return `${diffMinutes} 分钟前`
  }
  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) {
    return `${diffHours} 小时前`
  }
  return `${Math.floor(diffHours / 24)} 天前`
}

function resolveMarketSubscribeStatus(row: SteamModListQueryResultItem): ModInstallStatus | null {
  if (row.subscribeStatus) {
    return row.subscribeStatus
  }
  if (row.pendingDownload || isPendingWorkshop(row.workshopId)) {
    return 'pending'
  }
  if (row.subscribed || row.installed) {
    return 'ready'
  }
  return null
}

function marketStatusLabel(row: SteamModListQueryResultItem): string {
  const status = resolveMarketSubscribeStatus(row)
  if (status === 'pending') return pendingDownloadLabel(row.workshopId)
  if (status === 'failed') return '下载失败'
  if (status === 'ready') return '已订阅'
  return '未订阅'
}

function marketStatusType(row: SteamModListQueryResultItem): 'default' | 'success' | 'warning' | 'error' {
  const status = resolveMarketSubscribeStatus(row)
  if (status === 'pending') return 'warning'
  if (status === 'failed') return 'error'
  if (status === 'ready') return 'success'
  return 'default'
}

function pendingDownloadLabel(workshopId: string): string {
  const item = downloadQueue.value?.items.find(item => item.workshopId === workshopId)
  return resolveModDownloadItemLabel(item, downloadQueue.value?.status)
}

function modUpdateLabel(mod: ModItemDto): string {
  return mod.updateStatus === 'up_to_date' ? '检查时最新' : MOD_UPDATE_STATUS[mod.updateStatus].label
}

function subscribedStatusLabel(row: ModItemDto): string {
  if (row.installStatus === 'pending' || isPendingWorkshop(row.workshopId)) {
    return pendingDownloadLabel(row.workshopId)
  }
  if (row.installStatus === 'failed') {
    return MOD_INSTALL_STATUS.failed.label
  }
  return MOD_INSTALL_STATUS.ready.label
}

function subscribedStatusType(row: ModItemDto): 'success' | 'warning' | 'error' {
  if (downloadQueue.value?.items.some(item => item.workshopId === row.workshopId && item.phase === 'failed')) return 'error'
  if (row.installStatus === 'pending' || isPendingWorkshop(row.workshopId)) return 'warning'
  return row.installStatus === 'failed' ? 'error' : 'success'
}

/**
 * pending 的口径取决于队列有没有在跑：没跑就只是「待下载」（迁移包导入后默认如此），
 * 说成「下载中」会让用户以为正在下。
 */
const pendingStatusLabel = computed(() => {
  return '未就绪'
})

function mergeSteamRowsWithInstalled(
  items: SteamModListQueryResultItem[],
  mods: ModItemDto[],
): SteamModListQueryResultItem[] {
  const localByWorkshopId = new Map(mods.map(mod => [mod.workshopId, mod]))
  return items.map((item) => {
    const local = localByWorkshopId.get(item.workshopId)
    if (!local) {
      return item
    }
    const isPending = local.installStatus === 'pending'
      || item.pendingDownload
      || isPendingWorkshop(item.workshopId)
    return {
      ...item,
      subscribed: true,
      subscribeStatus: local.installStatus,
      installed: local.installStatus === 'ready',
      pendingDownload: isPending,
    }
  })
}

function mergeSteamRowAfterJob(workshopId: string, status: ModInstallStatus) {
  steamMods.value = steamMods.value.map(row => (
    row.workshopId === workshopId
      ? {
          ...row,
          subscribed: true,
          subscribeStatus: status,
          installed: status === 'ready',
          pendingDownload: status === 'pending',
        }
      : row
  ))
}

function applyJobResultToInstalledMods(workshopId: string, mod?: ModItemDto, error?: string | null) {
  if (mod) {
    const existingIndex = installedMods.value.findIndex(item => item.workshopId === workshopId)
    if (existingIndex >= 0) {
      installedMods.value[existingIndex] = mod
    }
    else {
      installedMods.value = [...installedMods.value, mod]
    }
    return
  }
  const existingIndex = installedMods.value.findIndex(item => item.workshopId === workshopId)
  if (existingIndex >= 0) {
    installedMods.value[existingIndex] = {
      ...installedMods.value[existingIndex],
      installStatus: error ? 'failed' : 'ready',
      installError: error ?? null,
    }
  }
}
/** 列表里是否已经有渲染过的内容：失败/降级时用它决定「保留」还是「清空」 */
const hasRenderedSteamRows = computed(() => steamMods.value.length > 0)

/** 离线兜底的横幅：说清「为什么是旧的」以及「怎么办」 */
function resolveSteamOfflineHint(meta: SteamModListMeta): string {
  const fetchedAt = meta.dataFetchedAt ? formatDateTime(meta.dataFetchedAt) : null
  return fetchedAt
    ? `暂时连不上 Steam 创意工坊，当前显示的是 ${fetchedAt} 的缓存内容`
    : '暂时连不上 Steam 创意工坊，当前显示的是缓存内容'
}

const steamMetaText = computed(() => {
  if (!steamMeta.value) {
    return ''
  }
  if (steamMeta.value.upstreamUnavailable) return ''
  if (steamMeta.value.dataFetchedAt) {
    return `${steamMeta.value.offline ? '离线缓存' : steamMeta.value.cached ? '缓存' : '数据'} · 获取于 ${formatDateTime(steamMeta.value.dataFetchedAt)}`
  }
  // 离线数据：给出的是「最后一次成功拉取」的时间，不是「多久没刷新了」，
  // 否则用户会把一份很旧的列表当成实时的
  if (steamMeta.value.offline) {
    const fetchedAt = steamMeta.value.dataFetchedAt
    return fetchedAt ? `离线数据 · 最后更新于 ${formatDateTime(fetchedAt)}` : '离线数据'
  }
  const ageMs = steamMeta.value.cacheAgeMs
  const ageText = ageMs < 60_000
    ? `${Math.max(1, Math.round(ageMs / 1000))} 秒前`
    : `${Math.max(1, Math.round(ageMs / 60_000))} 分钟前`
  return `读取时的数据年龄：${ageText}`
})

const steamSortOptions = computed(() => [
  { label: '最热门', value: 'trend' as const },
  { label: '最新', value: 'mostrecent' as const },
  { label: '相关性', value: 'relevance' as const, disabled: !hasSteamKeyword.value },
  { label: '最多订阅', value: 'totaluniquesubscribers' as const },
])

const steamTrendDaysOptions = [
  { label: '今天', value: 1 },
  { label: '一周', value: 7 },
  { label: '30 天', value: 30 },
  { label: '三个月', value: 90 },
  { label: '半年', value: 180 },
  { label: '一年', value: 365 },
  { label: '有史以来', value: -1 },
]

const TECHNICAL_STEAM_ERROR_PATTERNS = [
  /^Command failed:/i,
  /powershell/i,
  /ParserError/i,
  /CategoryInfo/i,
  /FullyQualifiedErrorId/i,
  /At line:\d+/i,
  /Invoke-WebRequest/i,
]

function isTechnicalSteamErrorMessage(message: string): boolean {
  const normalized = message.trim()
  return !normalized || TECHNICAL_STEAM_ERROR_PATTERNS.some(pattern => pattern.test(normalized))
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return isTechnicalSteamErrorMessage(error.message) ? fallback : error.message
  }
  if (typeof error === 'object' && error && 'error' in error) {
    const apiError = error as BusinessErrorLike
    if (apiError.error) {
      return isTechnicalSteamErrorMessage(apiError.error) ? fallback : apiError.error
    }
  }
  return fallback
}

function isAuthUnauthorizedError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as BusinessErrorLike).code === 'AUTH_UNAUTHORIZED'
}

function isRequestCanceled(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: string }).code === 'ERR_CANCELED'
}

function showSubscribeSuccessGuide() {
  subscribeGuideNotificationRef.value?.destroy()
  subscribeGuideNotificationRef.value = notification.success({
    title: '订阅成功',
    content: hasPermission('mod:toggle') ? 'Mod 文件已准备好，可在「已订阅」列表开启，重启实例后生效。' : 'Mod 文件已准备好；开启时请联系有权限的管理员。',
    duration: 0,
    closable: true,
    onClose: () => {
      subscribeGuideNotificationRef.value = null
    },
    action: () => hasPermission('mod:read')
      ? h(
          NButton,
          {
            size: 'small',
            type: 'primary',
            secondary: true,
            onClick: () => {
              subscribeGuideNotificationRef.value?.destroy()
              subscribeGuideNotificationRef.value = null
              if (selectedInstanceId.value) {
                activeTab.value = 'subscribed'
              }
            },
          },
          { default: () => '查看已订阅' },
        )
      : null,
  })
}

function renderMarketStatus(row: SteamModListQueryResultItem) {
  const status = resolveMarketSubscribeStatus(row)
  if (!status) {
    return h(
      NTag,
      { size: 'small', bordered: false, type: 'default' },
      { default: () => '未订阅' },
    )
  }
  if (status === 'pending') {
    return h(
      NTag,
      { size: 'small', bordered: false, type: 'warning' },
      { default: () => pendingDownloadLabel(row.workshopId) },
    )
  }
  if (status === 'failed') {
    return h(
      NTag,
      { size: 'small', bordered: false, type: 'error' },
      { default: () => '已订阅 · 下载失败' },
    )
  }
  return h(
    NTag,
    { size: 'small', bordered: false, type: 'success' },
    { default: () => '已订阅' },
  )
}

const marketColumns: DataTableColumns<SteamModListQueryResultItem> = [
  {
    title: 'Mod',
    key: 'title',
    minWidth: 280,
    render: row => h('div', { class: 'flex min-w-0 items-start gap-3' }, [
      row.previewImage ? renderModPreview(row.previewImage) : null,
      h('div', { class: 'min-w-0 space-y-1' }, [
        h('span', { class: 'block break-words font-medium' }, row.title),
        h('span', { class: 'block font-mono text-xs text-muted-foreground' }, `ID ${row.workshopId}`),
        ...(row.rating != null ? [renderModRating(row.rating)] : []),
      ]),
    ]),
  },
  {
    title: '状态',
    key: 'subscribeStatus',
    width: 140,
    render: row => renderMarketStatus(row),
  },
  {
    title: '操作',
    key: 'actions',
    width: 260,
    render: row => h('div', { class: 'flex items-center gap-3' }, [
      // 订阅 / 取消订阅 / 重试都是 mod:install：只读账号不该看到这个入口
      ...(hasPermission('mod:install')
        ? [h(
            NButton,
            {
              size: 'tiny',
              type: row.subscribeStatus === 'failed'
                ? 'primary'
                : (row.installed ? 'default' : 'primary'),
              disabled: !hasSelectedInstance.value
                || (unsubscribingWorkshopIds.value.has(row.workshopId))
                || isPendingWorkshop(row.workshopId),
              loading: unsubscribingWorkshopIds.value.has(row.workshopId),
              class: 'min-w-[4.5rem]',
              onClick: () => {
                const status = resolveMarketSubscribeStatus(row)
                if (row.installed || status === 'ready') {
                  confirmUnsubscribeFromMarket(row)
                  return
                }
                if (status === 'failed' || status === 'pending') {
                  void retryFromMarket(row)
                  return
                }
                void installFromSteam(row)
              },
            },
            {
              default: () => {
                if (row.installed || resolveMarketSubscribeStatus(row) === 'ready') {
                  return '取消订阅'
                }
                if (isPendingWorkshop(row.workshopId)) {
                  return pendingDownloadLabel(row.workshopId)
                }
                if (resolveMarketSubscribeStatus(row) === 'pending') return '下载'
                if (resolveMarketSubscribeStatus(row) === 'failed') {
                  return '重试'
                }
                return '订阅'
              },
            },
          )]
        : []),
      ...(resolveMarketSubscribeStatus(row) === 'failed' && hasPermission('mod:install')
        ? [h(NButton, {
            size: 'tiny',
            disabled: marketActionDisabled(row),
            loading: unsubscribingWorkshopIds.value.has(row.workshopId),
            onClick: () => confirmUnsubscribeFromMarket(row),
          }, { default: () => '取消订阅' })]
        : []),
      h(
        NButton,
        {
          size: 'tiny',
          text: true,
          disabled: !hasSelectedInstance.value,
          onClick: () => goToModDetail(row.workshopId),
        },
        { default: () => '详情' },
      ),
    ]),
  },
]

function subscribedStatusProps(row: ModItemDto) {
  return { name: row.name, label: subscribedStatusLabel(row), tone: subscribedStatusType(row),
    version: modUpdateLabel(row), versionHint: modUpdateTooltip(row), error: row.installError }
}
function subscribedEnabledProps(row: ModItemDto) {
  return { name: row.name, ready: row.installStatus === 'ready', enabled: row.enabled,
    disabled: !hasSelectedInstance.value || isPendingWorkshop(row.workshopId) || unsubscribingWorkshopIds.value.has(row.workshopId),
    loading: unsubscribingWorkshopIds.value.has(row.workshopId), onToggle: () => void toggleSubscribedMod(row) }
}
function subscribedActionsProps(row: ModItemDto) {
  return { name: row.name, status: row.installStatus, disabled: !hasSelectedInstance.value,
    pending: isPendingWorkshop(row.workshopId), unsubscribing: unsubscribingWorkshopIds.value.has(row.workshopId),
    updatable: isModUpdatable(row), redownloadable: canRedownloadMod(row),
    onRetry: () => void retryFailedInstall(row), onUpdate: () => void updateInstalledMod(row),
    onConfigure: () => openModConfig(row), onImport: () => { localImportShow.value = true },
    onUnsubscribe: () => confirmUnsubscribe(row), onDetail: () => goToModDetail(row.workshopId) }
}
const allModsSelected = computed(() => installedMods.value.length > 0 && installedMods.value.every(mod => checkedRowKeys.value.includes(mod.workshopId)))
function selectMod(workshopId: string, selected: boolean) {
  checkedRowKeys.value = selected
    ? [...new Set([...checkedRowKeys.value, workshopId])]
    : checkedRowKeys.value.filter(key => key !== workshopId)
}
function selectAllMods(selected: boolean) {
  checkedRowKeys.value = selected ? installedMods.value.map(mod => mod.workshopId) : []
}

const subscribedColumns: DataTableColumns<ModItemDto> = [
  { type: 'selection', width: 40 },
  {
    title: '顺序', key: 'loadOrder', width: 56,
    render: row => hasPermission('mod:toggle') ? h('button', {
      type: 'button', class: 'mod-sort-handle', disabled: !canDragMod(row),
      'aria-label': `调整 ${row.name} 的加载顺序`, title: '拖动调整加载顺序，也可使用上下方向键',
      onKeydown: (event: KeyboardEvent) => onModSortKeydown(event, row),
    }, [h(GripVertical, { size: 16, 'aria-hidden': true })]) : String(row.loadOrder + 1),
  },
  {
    title: 'Mod', key: 'name', minWidth: 260,
    render: row => h('div', { class: 'flex min-w-0 items-start gap-3' }, [
      row.previewImage ? renderModPreview(row.previewImage) : null,
      h('div', { class: 'min-w-0 space-y-1' }, [
        h('span', { class: 'block break-words font-medium' }, row.name),
        ...(!isModNameIdentified(row) ? [h(NTag, { size: 'tiny', bordered: false, type: 'warning' }, { default: () => '未识别名称' })] : []),
        h('span', { class: 'block text-xs text-muted-foreground font-mono' }, `ID ${row.workshopId}`),
        ...(row.rating != null ? [renderModRating(row.rating)] : []),
      ]),
    ]),
  },
  { title: '状态', key: 'status', width: 200, render: row => h(SubscribedModStatus, subscribedStatusProps(row)) },
  { title: '启用', key: 'enabled', width: 90, render: row => h(ModEnabledControl, subscribedEnabledProps(row)) },
  { title: '操作', key: 'actions', width: 210, render: row => h(SubscribedModActions, subscribedActionsProps(row)) },
]

async function loadInstances() {
  loadingInstances.value = true
  try {
    const response = await apiInstance.getInstanceOptions()
    const rows = (response.data ?? []) as InstanceSummaryItem[]
    instances.value = rows.filter(isInstallableGameInstance)
    const requested = typeof route.query.instanceId === 'string' ? route.query.instanceId : ''
    if (instances.value.some(item => item.id === requested)) selectedInstanceId.value = requested
    if (instances.value.length === 0) {
      selectedInstanceId.value = ''
    }
    else if (!selectedInstanceId.value || !instances.value.some(item => item.id === selectedInstanceId.value)) {
      selectedInstanceId.value = instances.value[0].id
    }
  }
  catch (error: unknown) {
    instances.value = []
    selectedInstanceId.value = ''
    if (isAuthUnauthorizedError(error)) {
      return
    }
    message.error(getErrorMessage(error, '加载实例失败，请稍后重试'))
  }
  finally {
    loadingInstances.value = false
  }
}

async function loadInstalledMods() {
  if (!pageActive) return
  if (!selectedInstanceId.value) {
    installedMods.value = []
    resetState()
    return
  }
  const id = selectedInstanceId.value
  const request = ++listRequest
  loadingInstalled.value = true
  try {
    const response = await apiMod.getModList(id)
    if (!pageActive || request !== listRequest || id !== selectedInstanceId.value) return
    if (dragSnapshot.value || reorderingMods.value) {
      if (dragSnapshot.value) dragSnapshot.value.invalidated = true
      return
    }
    installedMods.value = response.data.mods
    checkedRowKeys.value = checkedRowKeys.value.filter(key => response.data.mods.some(mod => mod.workshopId === key))
    modInstanceStatus.value = response.data.instanceStatus
    riskTipBanner.value = response.data.riskTip?.trim() || null
    void restoreInstallJobs({
      modList: response.data,
      // 下载进度由队列状态驱动：变化时重新拉一次列表（不再逐 Mod 轮询）
      onQueueChange: handleQueueChange,
    })
  }
  catch (error: unknown) {
    if (request !== listRequest || id !== selectedInstanceId.value) return
    if (isAuthUnauthorizedError(error)) {
      return
    }
    message.error(getErrorMessage(error, '加载已订阅 Mod 失败'))
  }
  finally {
    if (request === listRequest) loadingInstalled.value = false
  }
}

async function handleInstallJobTerminal(job: Awaited<ReturnType<typeof apiMod.pollModInstallJob>>) {
  if (!selectedInstanceId.value) {
    return
  }
  if (job.status === 'success') {
    if (job.mod) {
      applyJobResultToInstalledMods(job.workshopId, job.mod)
    }
    mergeSteamRowAfterJob(job.workshopId, 'ready')
    if (activeTab.value === 'market') showSubscribeSuccessGuide()
    return
  }
  if (job.status === 'failed') {
    applyJobResultToInstalledMods(job.workshopId, undefined, job.error)
    mergeSteamRowAfterJob(job.workshopId, 'failed')
    message.error(job.error || '订阅失败，请稍后重试')
    return
  }
  if (job.status === 'not_found') {
    await loadInstalledMods()
  }
}

/** 已订阅列表的启用/关闭开关（与 ShardModsSection 一致：重启后生效） */
async function toggleSubscribedMod(item: ModItemDto) {
  const action = actionScope.capture()
  if (!selectedInstanceId.value || unsubscribingWorkshopIds.value.has(item.workshopId) || item.installStatus !== 'ready') {
    return
  }
  const nextMutating = new Set(unsubscribingWorkshopIds.value)
  nextMutating.add(item.workshopId)
  unsubscribingWorkshopIds.value = nextMutating
  try {
    const result = await updateModSubscription(action, item, apiMod.updateMod)
    if (!result) return
    const { response, enabled } = result
    const riskTip = response.data.riskTip?.trim()
    message.success(`${enabled ? '已开启' : '已关闭'}该 Mod，重启实例后生效（可在实例管理执行重启）`)
    if (riskTip) {
      riskTipBanner.value = riskTip
    }
    installedMods.value = installedMods.value.map(row => (
      row.workshopId === item.workshopId
        ? { ...row, enabled }
        : row
    ))
  }
  catch (error: unknown) {
    if (!action.isCurrent()) return
    if (isAuthUnauthorizedError(error)) {
      return
    }
    message.error(getErrorMessage(error, '更新 Mod 状态失败，请稍后重试'))
  }
  finally {
    if (action.isCurrent()) {
      const next = new Set(unsubscribingWorkshopIds.value)
      next.delete(item.workshopId)
      unsubscribingWorkshopIds.value = next
    }
  }
}

async function retryFromMarket(row: SteamModListQueryResultItem) {
  const action = actionScope.capture()
  if (!selectedInstanceId.value || isPendingWorkshop(row.workshopId)) {
    return
  }
  mergeSteamRowAfterJob(row.workshopId, 'pending')
  ensurePendingInInstalledList(row)
  try {
    await installMod({
      workshopId: row.workshopId,
      name: row.title,
      previewImage: row.previewImage ?? undefined,
    }, {
      onTerminal: job => { if (action.isCurrent()) void handleInstallJobTerminal(job) },
    })
  }
  catch (error: unknown) {
    if (!action.isCurrent()) return
    if (isAuthUnauthorizedError(error)) {
      return
    }
    message.error(getErrorMessage(error, '重试订阅失败，请稍后重试'))
  }
}

async function retryFailedInstall(row: ModItemDto) {
  const action = actionScope.capture()
  if (!selectedInstanceId.value || isPendingWorkshop(row.workshopId)) {
    return
  }
  try {
    await installMod({
      workshopId: row.workshopId,
      name: row.name,
      previewImage: row.previewImage ?? undefined,
    }, {
      onTerminal: job => { if (action.isCurrent()) void handleInstallJobTerminal(job) },
    })
  }
  catch (error: unknown) {
    if (!action.isCurrent()) return
    if (isAuthUnauthorizedError(error)) {
      return
    }
    message.error(getErrorMessage(error, '重试订阅失败，请稍后重试'))
  }
}

function openModConfig(row: ModItemDto) {
  if (!selectedInstanceId.value || row.installStatus !== 'ready') {
    return
  }
  configTarget.value = { workshopId: row.workshopId, name: row.name }
  configModalShow.value = true
}

function onModConfigSaved(riskTip: string | null) {
  if (riskTip?.trim()) {
    riskTipBanner.value = riskTip.trim()
  }
  void loadInstalledMods()
}

/** 单独更新：强制重新下载已就绪的 Mod（订阅保持不变） */
async function updateInstalledMod(row: ModItemDto) {
  const action = actionScope.capture()
  if (!selectedInstanceId.value || isPendingWorkshop(row.workshopId)) {
    return
  }
  try {
    await installMod({
      workshopId: row.workshopId,
      name: row.name,
      previewImage: row.previewImage ?? undefined,
      force: true,
    }, {
      onTerminal: job => { if (action.isCurrent()) void handleInstallJobTerminal(job) },
    })
  }
  catch (error: unknown) {
    if (!action.isCurrent()) return
    if (isAuthUnauthorizedError(error)) {
      return
    }
    message.error(getErrorMessage(error, '更新 Mod 失败，请稍后重试'))
  }
}

/**
 * 批量更新：订阅入列，后台逐个重新下载。
 * 只接受「创意工坊上有新版本」的 Mod，避免把更新按钮做成对任何 Mod 都能按的空操作。
 */
async function runBatchUpdate(workshopIds: string[], options?: { skippedCount?: number }) {
  const action = actionScope.capture()
  if (!selectedInstanceId.value || workshopIds.length === 0 || batchUpdating.value) {
    return
  }
  const skippedCount = options?.skippedCount ?? 0
  batchUpdating.value = true
  try {
    const response = await apiMod.batchUpdateMods(selectedInstanceId.value, {
      workshopIds,
    })
    if (!action.isCurrent()) return
    const downloadingIds = response.data
      .filter(job => job.status === 'downloading')
      .map(job => job.workshopId)
    syncPendingWorkshopIds(downloadingIds, {
      onQueueChange: handleQueueChange,
    })
    const notFoundCount = response.data.filter(job => job.status === 'not_found').length
    message.success('已开始更新 ' + downloadingIds.length + ' 个 Mod，可在列表中查看进度')
    message.info('更新完成后需重启实例才会在游戏里生效')
    if (notFoundCount > 0) {
      message.warning(notFoundCount + ' 个 Mod 不存在，已跳过')
    }
    if (skippedCount > 0) {
      message.info(skippedCount + ' 个 Mod 正在下载中，本次已跳过')
    }
    checkedRowKeys.value = []
    await loadInstalledMods()
  }
  catch (error: unknown) {
    if (!action.isCurrent()) return
    if (isAuthUnauthorizedError(error)) {
      return
    }
    message.error(getErrorMessage(error, '批量更新失败，请稍后重试'))
  }
  finally {
    if (action.isCurrent()) batchUpdating.value = false
  }
}

/** 批量更新选中的 Mod：只处理其中确实有新版本的 */
async function batchUpdateSelectedMods() {
  const selected = installedMods.value.filter(mod => checkedRowKeys.value.includes(mod.workshopId))
  const targets = selected.filter(mod => isModUpdatable(mod))
  const skippedCount = selected.length - targets.length
  if (targets.length === 0) {
    message.info('选中的 Mod 没有可更新的版本，先点「检查更新」确认')
    return
  }
  await runBatchUpdate(targets.map(mod => mod.workshopId), { skippedCount })
}

/** 一键更新全部有新版本的 Mod（正在下载中的跳过，并在提示里说清） */
async function updateAllOutdatedMods() {
  const targets = updatableMods.value
  if (targets.length === 0) {
    message.info(subscribedSummary.value.outdated > 0
      ? '有新版本的 Mod 正在下载中，等下载完成后再更新'
      : '当前没有需要更新的 Mod')
    return
  }
  await runBatchUpdate(targets.map(mod => mod.workshopId))
}

/** 全部重试失败的 Mod：交给下载队列处理（服务端会把退避计数归零），不再逐个入队与轮询 */
async function retryAllFailedMods() {
  const action = actionScope.capture()
  if (!selectedInstanceId.value || retryingFailedMods.value) {
    return
  }
  const targetCount = downloadQueue.value?.retryableFailedCount ?? 0
  if (targetCount === 0) {
    return
  }
  retryingFailedMods.value = true
  try {
    await apiMod.startModDownloadQueue(selectedInstanceId.value, { retryFailed: true })
    if (!action.isCurrent()) return
    await refreshQueue()
    if (!action.isCurrent()) return
    message.success(`已重新排队 ${targetCount} 个失败的 Mod`)
  }
  catch (error: unknown) {
    if (!action.isCurrent()) return
    if (isAuthUnauthorizedError(error)) {
      return
    }
    message.error(getErrorMessage(error, '重新下载失败，请稍后重试'))
  }
  finally {
    if (action.isCurrent()) retryingFailedMods.value = false
  }
}

const queueControl = computed(() => resolveModDownloadAction(downloadQueue.value))

let queueWasRunning = false
let lastIneffectiveNoticeAt = 0

/**
 * 队列状态变化：刷新列表；若这一轮跑完却仍有可更新项，说明更新没让本机内容追平工坊，
 * 提示一次原因，避免用户对着「全部更新 (N)」反复点。
 */
function handleQueueChange(queue: ModDownloadQueueDto) {
  const action = actionScope.capture()
  const running = queue.status === 'running' || queue.status === 'pausing'
  const wasRunning = queueWasRunning
  queueWasRunning = running
  void loadInstalledMods().then(() => {
    if (!action.isCurrent()) return
    const notice = resolveUpdateIneffectiveNotice({
      wasRunning,
      status: queue.status,
      updatableCount: updatableMods.value.length,
    })
    if (!notice || Date.now() - lastIneffectiveNoticeAt < 60_000) {
      return
    }
    lastIneffectiveNoticeAt = Date.now()
    message.warning(notice, { duration: 8000 })
  })
}

const queueActionPending = ref(false)

/** 暂停使用中止当前批次的接口，保留未完成项，避免等待整批下载超时。 */
async function runQueueAction(queueAction: 'start' | 'pause') {
  const action = actionScope.capture()
  if (!selectedInstanceId.value || queueActionPending.value) {
    return
  }
  queueActionPending.value = true
  try {
    if (queueAction === 'start') {
      await apiMod.startModDownloadQueue(action.instanceId, { retryFailed: false })
      if (!action.isCurrent()) return
    }
    else {
      const response = await apiMod.cancelModDownloadQueue(action.instanceId)
      if (!action.isCurrent()) return
      downloadQueue.value = response.data
    }
    await refreshQueue()
    if (!action.isCurrent()) return
    if (queueAction === 'start') {
      message.success('已开始下载 Mod')
    }
    else if (queueAction === 'pause') {
      message.info(downloadQueue.value?.status === 'paused' ? '下载已暂停，可恢复下载' : '正在暂停下载，未完成项会保留')
    }
  }
  catch (error: unknown) {
    if (!action.isCurrent()) return
    if (isAuthUnauthorizedError(error)) {
      return
    }
    message.error(getErrorMessage(error, '下载队列操作失败，请稍后重试'))
  }
  finally {
    if (action.isCurrent()) queueActionPending.value = false
  }
}

/** 检查更新：判断哪些 Mod 不是创意工坊上的最新版，顺带按工坊标题补全名称与缩略图 */
async function checkModUpdates() {
  const action = actionScope.capture()
  if (!selectedInstanceId.value || checkingUpdates.value) {
    return
  }
  checkingUpdates.value = true
  try {
    const response = await apiMod.checkModUpdates(selectedInstanceId.value, { force: true })
    if (!action.isCurrent()) return
    await loadInstalledMods()
    if (!action.isCurrent()) return
    // 无法判断的 Mod 绝不能被说成「已是最新」：提示口径集中在 modUpdateCheckPresentation.ts
    const notice = resolveModUpdateCheckNotice(response.data)
    if (notice.kind === 'notification') {
      const options = { title: notice.title ?? 'Mod 版本检查', content: notice.content, duration: 8000 }
      if (notice.tone === 'warning') {
        notification.warning(options)
      }
      else if (notice.tone === 'success') {
        notification.success(options)
      }
      else {
        notification.info(options)
      }
    }
    else if (notice.tone === 'warning') {
      message.warning(notice.content)
    }
    else if (notice.tone === 'success') {
      message.success(notice.content)
    }
    else {
      message.info(notice.content)
    }
  }
  catch (error: unknown) {
    if (!action.isCurrent()) return
    if (isAuthUnauthorizedError(error)) {
      return
    }
    // 取不到工坊信息时不动已有状态：明确告诉用户「沿用上次结果」而不是当成已是最新
    message.error(getErrorMessage(error, '检查 Mod 更新失败，已沿用上次结果'))
  }
  finally {
    if (action.isCurrent()) checkingUpdates.value = false
  }
}

/** 加载顺序只对已就绪内容生效。 */
function isReorderableInstalledMod(row: ModItemDto): boolean {
  return row.installStatus === 'ready' && !isPendingWorkshop(row.workshopId)
}

const subscribedTableRef = ref<InstanceType<typeof NDataTable> | null>(null)
const subscribedCardsRef = ref<HTMLElement | null>(null)
const sortElement = shallowRef<HTMLElement | null>(null)
const dragSnapshot = shallowRef<{
  action: ReturnType<typeof actionScope.capture>
  targetId: string | null
  nodes: Element[]
  parent: HTMLElement
  invalidated: boolean
} | null>(null)
const sortingDisabled = computed(() => !hasPermission('mod:toggle') || !hasSelectedInstance.value
  || loadingInstalled.value || reorderingMods.value || installedMods.value.filter(isReorderableInstalledMod).length < 2)
function canDragMod(row: ModItemDto) { return !sortingDisabled.value && isReorderableInstalledMod(row) }
function subscribedRowProps(row: ModItemDto) {
  const progress = modRowProgress.rowProps(row.workshopId)
  return { ...progress, class: ['mod-sort-row', progress.class ?? ''].join(' '), 'data-mod-id': row.workshopId }
}
function restoreDragDom(snapshot: NonNullable<typeof dragSnapshot.value>) {
  // Sortable 先恢复 DOM，随后由 Vue 按服务端结果更新，避免 keyed diff 再移动一次。
  for (const node of snapshot.nodes) if (node.parentNode === snapshot.parent) snapshot.parent.appendChild(node)
}
const sortable = useSortable(sortElement, installedMods, {
  watchElement: true, handle: '.mod-sort-handle', draggable: '[data-mod-id]',
  filter: (_event, target) => !installedMods.value.some(mod => mod.workshopId === target.dataset.modId && canDragMod(mod)),
  preventOnFilter: false,
  animation: 150, delay: 150, delayOnTouchOnly: true, touchStartThreshold: 5, ghostClass: 'mod-sort-ghost',
  onUpdate: () => {}, // 不使用适配器的自动数组更新，保存成功后采用服务端顺序。
  onMove: event => {
    const row = installedMods.value.find(mod => mod.workshopId === event.related.dataset.modId)
    const allowed = Boolean(row && canDragMod(row))
    if (allowed && dragSnapshot.value) dragSnapshot.value.targetId = row!.workshopId
    return allowed
  },
  onStart: event => {
    dragSnapshot.value = { action: actionScope.capture(), targetId: null,
      nodes: Array.from(event.from.children), parent: event.from, invalidated: false }
  },
  onEnd: (event: SortableEvent) => {
    const snapshot = dragSnapshot.value
    if (!snapshot) return
    const readyIds = new Set(installedMods.value.filter(mod => mod.installStatus === 'ready').map(mod => mod.workshopId))
    const workshopIds = Array.from(event.from.children).map(node => (node as HTMLElement).dataset.modId ?? '').filter(id => readyIds.has(id))
    restoreDragDom(snapshot)
    dragSnapshot.value = null
    if (!snapshot.action.isCurrent()) return
    if (snapshot.invalidated) { void loadInstalledMods(); return }
    if (snapshot.targetId && workshopIds.length === readyIds.size) void saveModLoadOrder(workshopIds, event.item.dataset.modId ?? '')
  },
})
watch([activeTab, isMobileMode, selectedInstanceId, () => installedMods.value.length], async () => {
  await nextTick()
  sortElement.value = activeTab.value !== 'subscribed' ? null : isMobileMode.value
    ? subscribedCardsRef.value : subscribedTableRef.value?.$el.querySelector('.n-data-table-tbody') ?? null
  sortable.option('disabled', sortingDisabled.value)
}, { flush: 'post', immediate: true })
watch(sortingDisabled, disabled => sortable.option('disabled', disabled))
watch(() => installedMods.value.map(mod => `${mod.workshopId}:${mod.installStatus}:${isPendingWorkshop(mod.workshopId)}`).join(','), () => {
  if (dragSnapshot.value) dragSnapshot.value.invalidated = true
}, { flush: 'sync' })
watch([selectedInstanceId, isMobileMode, activeTab], () => {
  if (dragSnapshot.value) restoreDragDom(dragSnapshot.value)
  dragSnapshot.value = null
  sortElement.value = null
}, { flush: 'sync' })
onBeforeUnmount(() => {
  pageActive = false
  actionScope.invalidate()
  steamAbortController.value?.abort()
  if (dragSnapshot.value) restoreDragDom(dragSnapshot.value)
  dragSnapshot.value = null
})
function onModSortKeydown(event: KeyboardEvent, row: ModItemDto) {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
  event.preventDefault()
  if (!canDragMod(row)) return
  const offset = event.key === 'ArrowUp' ? -1 : 1
  for (let index = installedMods.value.indexOf(row) + offset; index >= 0 && index < installedMods.value.length; index += offset) {
    const target = installedMods.value[index]
    if (isReorderableInstalledMod(target)) { void reorderInstalledMod(row.workshopId, target.workshopId); return }
  }
}

async function reorderInstalledMod(fromId: string, toId: string) {
  if (sortingDisabled.value) return
  const workshopIds = moveModLoadOrder(installedMods.value, fromId, toId, isPendingWorkshop)
  if (!workshopIds) return
  await saveModLoadOrder(workshopIds, fromId)
}

async function saveModLoadOrder(workshopIds: string[], fromId: string) {
  const action = actionScope.capture()
  if (sortingDisabled.value || workshopIds.join(',') === installedMods.value.filter(mod => mod.installStatus === 'ready').map(mod => mod.workshopId).join(',')) return
  listRequest++ // 丢弃保存前发起的列表请求。
  reorderingMods.value = true
  let refresh = false
  try {
    const response = await apiMod.reorderMods(action.instanceId, { workshopIds })
    if (!action.isCurrent()) return
    installedMods.value = response.data.mods
    const riskTip = response.data.riskTip?.trim()
    if (riskTip) {
      riskTipBanner.value = riskTip
    }
    message.success('已调整 Mod 加载顺序，重启实例后生效（可在实例管理执行重启）')
  }
  catch (error: unknown) {
    if (!action.isCurrent()) return
    if (isAuthUnauthorizedError(error)) {
      return
    }
    message.error(getErrorMessage(error, '调整 Mod 加载顺序失败，请稍后重试'))
    refresh = true
  }
  finally {
    if (action.isCurrent()) {
      reorderingMods.value = false
      if (refresh) await loadInstalledMods()
      await nextTick()
      if (action.isCurrent()) sortElement.value?.querySelector<HTMLButtonElement>(`[data-mod-id="${CSS.escape(fromId)}"] .mod-sort-handle`)?.focus()
    }
  }
}

async function loadSteamMods(
  resetPage = false,
  automatic = false,
) {
  if (!pageActive || activeTab.value !== 'market') return
  const action = actionScope.capture()
  if (!selectedInstanceId.value) {
    steamMods.value = []
    steamHasMore.value = false
    steamTotalCount.value = null
    steamTotalPages.value = null
    steamMeta.value = null
    return
  }
  if (resetPage) {
    steamPage.value = 1
  }
  const queryIdentity = JSON.stringify([selectedInstanceId.value, steamKeyword.value.trim(), steamPage.value, steamPageSize.value, steamSort.value, steamTrendDays.value])
  if (pendingSteamQuery === queryIdentity || (automatic && attemptedSteamQuery === queryIdentity)) return
  steamAbortController.value?.abort()
  const controller = new AbortController()
  steamAbortController.value = controller
  pendingSteamQuery = queryIdentity
  attemptedSteamQuery = queryIdentity
  loadingSteam.value = true
  steamLoadError.value = null
  const sameQuery = queryIdentity === renderedSteamQuery
  const previousMeta = steamMeta.value
  const previousSourceUrl = steamSourceUrl.value
  if (!sameQuery) {
    steamMods.value = []
    steamHasMore.value = false
    steamTotalCount.value = null
    steamTotalPages.value = null
    steamMeta.value = null
    steamSourceUrl.value = ''
    renderedSteamQuery = ''
  }
  try {
    const response = await apiMod.getSteamModList(action.instanceId, {
      keyword: steamKeyword.value.trim() || undefined,
      page: steamPage.value,
      pageSize: steamPageSize.value,
      sort: steamSort.value,
      trendDays: steamTrendDays.value,
    }, {
      signal: controller.signal,
    })
    if (controller.signal.aborted || !action.isCurrent() || !pageActive) {
      return
    }
    if (response.data.meta?.upstreamUnavailable) {
      // 后端给的是「连不上上游且一条缓存都没有」，此时确实没有内容可显示。
      // 但如果本地还留着上一次成功的列表，就保留它——空白页比一份明确标注的
      // 离线列表更没用（用户连自己订阅过什么都想不起来）。
      if (!sameQuery || !hasRenderedSteamRows.value) {
        steamMods.value = []
        steamHasMore.value = false
        steamTotalCount.value = null
        steamTotalPages.value = null
      }
      steamSourceUrl.value = sameQuery && hasRenderedSteamRows.value ? previousSourceUrl : response.data.sourceUrl
      steamPage.value = response.data.page
      steamPageSize.value = response.data.pageSize > 0 ? response.data.pageSize : steamPageSize.value
      steamMeta.value = sameQuery && hasRenderedSteamRows.value && previousMeta
        ? { ...previousMeta, cached: true, stale: true, offline: true, source: 'cache-stale' }
        : response.data.meta
      return
    }
    steamLoadError.value = null
    renderedSteamQuery = queryIdentity
    steamMods.value = mergeSteamRowsWithInstalled(response.data.items, installedMods.value)
    steamSourceUrl.value = response.data.sourceUrl
    steamHasMore.value = response.data.hasMore
    steamTotalCount.value = response.data.totalCount
    steamTotalPages.value = response.data.totalPages
    steamPage.value = response.data.page
    steamPageSize.value = response.data.pageSize > 0 ? response.data.pageSize : steamPageSize.value
    steamMeta.value = response.data.meta
    syncPendingWorkshopIds(response.data.pendingWorkshopIds ?? [], {
      onTerminal: job => { if (action.isCurrent()) void handleInstallJobTerminal(job) },
    })
  }
  catch (error: unknown) {
    if (isRequestCanceled(error) || controller.signal.aborted || !action.isCurrent() || !pageActive) {
      return
    }
    // 请求整个失败了（超时/网络中断）：有内容就留着，只在确实空白时清空。
    // 之前无论有没有内容都清空，用户看到的是「列表自己消失了」。
    if (!sameQuery || !hasRenderedSteamRows.value) {
      steamMods.value = []
      steamHasMore.value = false
      steamTotalCount.value = null
      steamTotalPages.value = null
    }
    steamSourceUrl.value = sameQuery && hasRenderedSteamRows.value ? previousSourceUrl : ''
    steamMeta.value = sameQuery && hasRenderedSteamRows.value && previousMeta ? { ...previousMeta, cached: true, stale: true, offline: true, source: 'cache-stale' } : null
    if (isAuthUnauthorizedError(error) || (error as BusinessErrorLike)?.code === 'AUTH_FORBIDDEN' || (error as BusinessErrorLike)?.code === 'AUTH_FORCE_PASSWORD_CHANGE') {
      return
    }
    steamLoadError.value = getErrorMessage(error, '请稍后重试，或检查面板连接。')
  }
  finally {
    if (steamAbortController.value === controller) {
      steamAbortController.value = null
      pendingSteamQuery = ''
      loadingSteam.value = false
    }
  }
}

function ensurePendingInInstalledList(item: Pick<SteamModListQueryResultItem, 'workshopId' | 'title' | 'previewImage'>) {
  const existingIndex = installedMods.value.findIndex(mod => mod.workshopId === item.workshopId)
  if (existingIndex >= 0) {
    installedMods.value[existingIndex] = {
      ...installedMods.value[existingIndex],
      installStatus: 'pending',
      installError: null,
    }
    return
  }
  const now = new Date().toISOString()
  installedMods.value = [...installedMods.value, {
    id: item.workshopId,
    workshopId: item.workshopId,
    name: item.title,
    previewImage: item.previewImage,
    rating: null,
    enabled: false,
    loadOrder: installedMods.value.length,
    version: null,
    installStatus: 'pending',
    installError: null,
    localUpdatedAt: null,
    remoteUpdatedAt: null,
    updateCheckedAt: null,
    updateStatus: 'unknown',
    dependencyIds: [],
    missingDependencyIds: [],
    dependentModIds: [],
    createdAt: now,
    updatedAt: now,
  }]
}

async function installFromSteam(item: SteamModListQueryResultItem) {
  const action = actionScope.capture()
  const status = resolveMarketSubscribeStatus(item)
  if (!selectedInstanceId.value || status === 'ready' || status === 'pending') {
    return
  }
  mergeSteamRowAfterJob(item.workshopId, 'pending')
  ensurePendingInInstalledList(item)
  try {
    await installMod({
      workshopId: item.workshopId,
      name: item.title,
      previewImage: item.previewImage ?? undefined,
    }, {
      onTerminal: job => { if (action.isCurrent()) void handleInstallJobTerminal(job) },
    })
  }
  catch (error: unknown) {
    if (!action.isCurrent()) return
    if (isAuthUnauthorizedError(error)) {
      return
    }
    message.error(getErrorMessage(error, '订阅失败，请稍后重试'))
  }
}

function handleMarketAction(item: SteamModListQueryResultItem) {
  const status = resolveMarketSubscribeStatus(item)
  if (item.installed || status === 'ready') {
    confirmUnsubscribeFromMarket(item)
    return
  }
  if (status === 'failed' || status === 'pending') {
    void retryFromMarket(item)
    return
  }
  if (status !== 'pending') {
    void installFromSteam(item)
  }
}

function marketActionLabel(item: SteamModListQueryResultItem): string {
  const status = resolveMarketSubscribeStatus(item)
  if (item.installed || status === 'ready') return '取消订阅'
  if (isPendingWorkshop(item.workshopId)) return pendingDownloadLabel(item.workshopId)
  if (status === 'pending') return '下载'
  return status === 'failed' ? '重试' : '订阅'
}

function marketActionDisabled(item: SteamModListQueryResultItem): boolean {
  return !hasSelectedInstance.value
    || unsubscribingWorkshopIds.value.has(item.workshopId)
    || isPendingWorkshop(item.workshopId)
}

function confirmUnsubscribe(row: ModItemDto) {
  openUnsubscribeConfirm(row.workshopId, row.name)
}

function confirmUnsubscribeFromMarket(row: SteamModListQueryResultItem) {
  openUnsubscribeConfirm(row.workshopId, row.title)
}

function openUnsubscribeConfirm(workshopId: string, modName: string) {
  const action = actionScope.capture()
  if (!selectedInstanceId.value) {
    message.warning('请先选择实例')
    return
  }
  dialog.warning({
    title: '取消订阅',
    content: `确定从当前实例取消订阅「${modName}」吗？`,
    positiveText: '取消订阅',
    negativeText: '保留',
    onPositiveClick: () => {
      if (!action.isCurrent()) return
      void unsubscribeMod(workshopId)
    },
  })
}

async function unsubscribeMod(workshopId: string) {
  const action = actionScope.capture()
  if (!selectedInstanceId.value || unsubscribingWorkshopIds.value.has(workshopId)) {
    return
  }
  const nextUnsubscribing = new Set(unsubscribingWorkshopIds.value)
  nextUnsubscribing.add(workshopId)
  unsubscribingWorkshopIds.value = nextUnsubscribing
  try {
    await apiMod.deleteMod(selectedInstanceId.value, workshopId)
    if (!action.isCurrent()) return
    installedMods.value = installedMods.value.filter(item => item.workshopId !== workshopId)
    checkedRowKeys.value = checkedRowKeys.value.filter(key => key !== workshopId)
    steamMods.value = steamMods.value.map(item => (
      item.workshopId === workshopId
        ? {
            ...item,
            subscribed: false,
            subscribeStatus: null,
            installed: false,
            pendingDownload: false,
          }
        : item
    ))
    message.success('已取消订阅')
  }
  catch (error: unknown) {
    if (!action.isCurrent()) return
    if (isAuthUnauthorizedError(error)) {
      return
    }
    message.error(getErrorMessage(error, '取消订阅失败，请稍后重试'))
  }
  finally {
    if (action.isCurrent()) {
    const next = new Set(unsubscribingWorkshopIds.value)
      next.delete(workshopId)
      unsubscribingWorkshopIds.value = next
    }
  }
}

const manualWorkshopInput = ref('')
const manualWorkshopInputRef = ref<InstanceType<typeof NInput> | null>(null)
const manualWorkshopError = ref('')
const manualSubscribing = ref(false)
watch(manualWorkshopInput, () => { manualWorkshopError.value = '' })

/** 从工坊详情页链接或纯数字输入中提取 Workshop ID */
function extractWorkshopId(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }
  // 详情页形如 /sharedfiles/filedetails/?id=123：filedetails 后的斜杠可有可无，id 也可能不是第一个参数
  const urlMatch = trimmed.match(/filedetails\/?\?[^#]*\bid=(\d+)/i)
  if (urlMatch) {
    return urlMatch[1]
  }
  return /^\d+$/.test(trimmed) ? trimmed : null
}

/** 粘贴工坊 ID/链接直接订阅（不依赖创意工坊列表可用） */
async function subscribeManualWorkshop() {
  if (manualSubscribing.value) return
  const action = actionScope.capture()
  const workshopId = extractWorkshopId(manualWorkshopInput.value)
  if (!workshopId) {
    manualWorkshopError.value = '请输入有效的创意工坊 ID 或 Mod 详情页链接'
    manualWorkshopInputRef.value?.focus()
    return
  }
  if (!selectedInstanceId.value) {
    message.warning('请先选择实例')
    return
  }
  const existing = installedMods.value.find(mod => mod.workshopId === workshopId)
  if (existing && existing.installStatus === 'ready') {
    message.info('该 Mod 已在订阅列表中')
    return
  }
  ensurePendingInInstalledList({ workshopId, title: `工坊 ${workshopId}`, previewImage: null })
  manualSubscribing.value = true
  try {
    await installMod({
      workshopId,
      name: `工坊 ${workshopId}`,
    }, {
      onTerminal: job => { if (action.isCurrent()) void handleInstallJobTerminal(job) },
    })
    if (!action.isCurrent()) return
    manualWorkshopInput.value = ''
    addModOpen.value = false
  }
  catch (error: unknown) {
    if (!action.isCurrent()) return
    if (isAuthUnauthorizedError(error)) {
      return
    }
    message.error(getErrorMessage(error, '订阅失败，请稍后重试'))
  }
  finally { if (action.isCurrent()) manualSubscribing.value = false }
}

function onInstanceChange(value: string) {
  selectedInstanceId.value = value
  steamAbortController.value?.abort()
  steamAbortController.value = null
  pendingSteamQuery = ''
  attemptedSteamQuery = ''
  loadingSteam.value = false
  steamMods.value = []
  steamMeta.value = null
  steamLoadError.value = null
  renderedSteamQuery = ''
  steamPage.value = 1
  steamSourceUrl.value = ''
  steamHasMore.value = false
  steamTotalCount.value = null
  steamTotalPages.value = null
  checkedRowKeys.value = []
  installedMods.value = []
  modInstanceStatus.value = ''
  riskTipBanner.value = null
  resetState()
  void Promise.all([loadSteamMods(true, true), loadInstalledMods()])
}

const triggerSteamReloadDebounced = useDebounceFn(() => {
  if (!pageActive || activeTab.value !== 'market' || !selectedInstanceId.value) {
    return
  }
  void loadSteamMods(true, true)
}, 400)

watch([steamSort, steamTrendDays], () => {
  if (activeTab.value !== 'market' || !selectedInstanceId.value) {
    return
  }
  triggerSteamReloadDebounced()
})

watch(steamKeyword, (keyword, previousKeyword) => {
  if (!keyword.trim() && steamSort.value === 'relevance') {
    steamSort.value = 'trend'
    if (activeTab.value === 'market' && selectedInstanceId.value) {
      triggerSteamReloadDebounced()
    }
    return
  }
  if (activeTab.value !== 'market' || !selectedInstanceId.value || keyword.trim() === previousKeyword.trim()) {
    return
  }
  triggerSteamReloadDebounced()
})

watch(activeTab, (tab) => {
  if (tab === 'market' && selectedInstanceId.value) void loadSteamMods(false, true)
  if (tab === 'subscribed' && selectedInstanceId.value && !loadingInstalled.value) {
    void loadInstalledMods()
  }
})

watch(() => route.query, (query) => {
  activeTab.value = query.tab === 'market' ? 'market' : 'subscribed'
  const id = typeof query.instanceId === 'string' ? query.instanceId : ''
  if (id && id !== selectedInstanceId.value && instances.value.some(item => item.id === id)) onInstanceChange(id)
})

watch([selectedInstanceId, activeTab], ([instanceId, tab]) => {
  if (!pageActive || loadingInstances.value || !instanceId) return
  if (route.query.instanceId !== instanceId || route.query.tab !== tab) {
    void router.replace({ query: { ...route.query, instanceId, tab } })
  }
})

onMounted(async () => {
  await loadInstances()
  if (!pageActive) return
  await Promise.all([loadSteamMods(true, true), loadInstalledMods()])
})
</script>

<template>
  <div class="dst-mod-page min-w-0 p-3 md:p-4">
    <FaPageMain class="!m-0 min-w-0" main-class="!p-3 sm:!p-5">
      <template #title>
        <div class="flex flex-wrap items-center gap-3">
          <h1 class="mr-auto text-lg font-semibold">Mod 管理</h1>
          <NSelect class="mod-instance-select" :value="selectedInstanceId || null" :loading="loadingInstances"
            :options="instanceOptions" :disabled="!hasInstallableInstances" :placeholder="instanceSelectPlaceholder"
            aria-label="目标实例" @update:value="onInstanceChange" />
          <NPopover v-if="hasPermission('mod:install')" v-model:show="addModOpen" trigger="click" placement="bottom-end" :show-arrow="false">
            <template #trigger>
              <NButton type="primary" size="small" :disabled="!hasSelectedInstance">添加 Mod</NButton>
            </template>
            <form class="mod-add-form space-y-3" @submit.prevent="subscribeManualWorkshop">
              <label for="mod-workshop-id" class="block text-sm font-medium">工坊 ID 或详情页链接</label>
              <NInput ref="manualWorkshopInputRef" v-model:value="manualWorkshopInput" :input-props="{ id: 'mod-workshop-id', spellcheck: false, 'aria-invalid': Boolean(manualWorkshopError), 'aria-describedby': manualWorkshopError ? 'mod-workshop-error' : undefined }"
                placeholder="例如 378160973 或工坊详情页链接" :disabled="manualSubscribing" clearable />
              <p v-if="manualWorkshopError" id="mod-workshop-error" role="alert" class="text-sm text-rose-600 dark:text-rose-400">{{ manualWorkshopError }}</p>
              <div class="flex flex-wrap gap-2">
                <NButton type="primary" size="small" attr-type="submit" :loading="manualSubscribing" :disabled="!hasSelectedInstance">订阅</NButton>
                <NButton size="small" :disabled="!hasSelectedInstance || manualSubscribing" @click="addModOpen = false; localImportShow = true">从本地导入</NButton>
              </div>
            </form>
          </NPopover>
        </div>
      </template>

      <NButton v-if="!hasInstallableInstances && !loadingInstances && hasPermission('instance:read')"
        type="primary" class="mb-3" @click="router.push(routeToNodeInstance())">前往实例管理</NButton>
      <NAlert v-if="riskTipBanner" type="warning" class="mb-3" closable @close="riskTipBanner = null">{{ riskTipBanner }}</NAlert>

      <div ref="listElement" class="min-w-0">
        <NTabs v-model:value="activeTab" type="line">
          <NTabPane name="subscribed" display-directive="if" :tab-props="keyboardTabProps(activeTab === 'subscribed')">
            <template #tab>已订阅 ({{ subscribedTabCount }})</template>
            <div :ref="bindModProgressSurface" class="task-progress-surface min-w-0 space-y-3">
              <div class="flex flex-wrap items-center gap-2">
                <NButton size="small" :loading="checkingUpdates" :disabled="!hasSelectedInstance || installedMods.length === 0" @click="checkModUpdates">检查更新</NButton>
                <NButton v-if="hasPermission('mod:install') && updatableMods.length > 0" size="small" type="primary" secondary
                  :loading="batchUpdating" @click="updateAllOutdatedMods">全部更新 ({{ updatableMods.length }})</NButton>
                <NButton v-if="checkedRowKeys.length > 0 && hasPermission('mod:install')" size="small" secondary
                  :loading="batchUpdating" :disabled="selectedUpdatableMods.length === 0" @click="batchUpdateSelectedMods">更新选中 ({{ selectedUpdatableMods.length }})</NButton>
                <NButton v-if="queueControl && hasPermission('mod:install')" size="small" :type="queueControl.action === 'start' ? 'primary' : 'default'"
                  secondary :loading="queueActionPending || queueControl.disabled" :disabled="queueActionPending || queueControl.disabled"
                  :aria-label="queueControl.label" @click="runQueueAction(queueControl.action)">{{ queueControl.label }}</NButton>
                <NButton v-if="(downloadQueue?.retryableFailedCount ?? 0) > 0 && hasPermission('mod:install')" size="small"
                  type="warning" secondary :loading="retryingFailedMods" @click="retryAllFailedMods">重试全部失败 ({{ downloadQueue?.retryableFailedCount ?? 0 }})</NButton>
                <NButton size="small" class="ml-auto" :disabled="!hasSelectedInstance" :loading="loadingInstalled" @click="loadInstalledMods()">刷新</NButton>
              </div>
              <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground" role="status">
                <span>就绪 {{ subscribedSummary.ready }}<template v-if="subscribedSummary.pending"> · {{ pendingStatusLabel }} {{ subscribedSummary.pending }}</template><template v-if="subscribedSummary.failed"> · 失败 {{ subscribedSummary.failed }}</template></span>
                <span v-if="lastUpdateCheckedAt">上次检查 {{ formatCheckedAt(lastUpdateCheckedAt) }}</span>
                <span class="text-sm">开关与加载顺序的改动需重启实例后生效。</span>
              </div>
              <p v-if="modCheckHint" class="text-sm text-muted-foreground">{{ modCheckHint }}</p>
              <NAlert v-if="downloadQueue?.warnings.length" type="warning" :bordered="false">
                <p v-for="warning in downloadQueue.warnings" :key="warning">{{ warning }}</p>
              </NAlert>

              <NDataTable v-if="!isMobileMode" :key="'subscribed-' + selectedInstanceId" ref="subscribedTableRef"
                :bordered="false" :single-line="false" :columns="subscribedColumns" :data="installedMods"
                :loading="loadingInstalled" :pagination="false" :row-key="(row: ModItemDto) => row.workshopId"
                :row-props="subscribedRowProps" :checked-row-keys="checkedRowKeys" class="dst-mod-table"
                max-height="max(320px, calc(var(--g-main-content-height) - 300px))"
                @update:checked-row-keys="(keys: Array<string | number>) => checkedRowKeys = keys">
                <template #empty><NEmpty size="large" :description="subscribedEmptyDescription" /></template>
              </NDataTable>
              <div v-else :aria-busy="loadingInstalled">
                <div v-if="installedMods.length" class="mb-3 flex items-center gap-3">
                  <NCheckbox :checked="allModsSelected" :indeterminate="checkedRowKeys.length > 0 && !allModsSelected" @update:checked="selectAllMods">全选</NCheckbox>
                  <span v-if="checkedRowKeys.length" class="text-sm text-muted-foreground">已选 {{ checkedRowKeys.length }} 项</span>
                </div>
                <NEmpty v-if="!loadingInstalled && installedMods.length === 0" size="small" :description="subscribedEmptyDescription" />
                <p v-if="loadingInstalled && installedMods.length === 0" role="status" class="py-6 text-center text-sm text-muted-foreground">正在加载 Mod…</p>
                <div ref="subscribedCardsRef" class="space-y-3">
                  <article v-for="mod in installedMods" :key="mod.workshopId" v-bind="subscribedRowProps(mod)"
                    :class="{ 'task-progress-card': Boolean(modRowProgress.rowProps(mod.workshopId).class) }"
                    :data-mod-id="mod.workshopId" class="min-w-0 rounded-lg border border-border bg-card p-3 space-y-3">
                    <div class="flex items-start gap-3">
                      <NCheckbox :checked="checkedRowKeys.includes(mod.workshopId)" :aria-label="'选择 ' + mod.name"
                        @update:checked="selectMod(mod.workshopId, $event)" />
                      <NImage v-if="mod.previewImage" :src="mod.previewImage" width="56" height="56" object-fit="cover"
                        :alt="mod.name" lazy class="shrink-0 rounded" />
                      <div class="min-w-0 flex-1">
                        <h2 class="break-words text-sm font-medium">{{ mod.name }}</h2>
                        <NTag v-if="!isModNameIdentified(mod)" size="tiny" :bordered="false" type="warning">未识别名称</NTag>
                        <p class="mt-1 break-all font-mono text-xs text-muted-foreground">ID {{ mod.workshopId }}</p>
                        <NRate v-if="mod.rating != null" class="mt-1" readonly allow-half size="small" :value="mod.rating" />
                      </div>
                    </div>
                    <div class="flex items-start justify-between gap-3">
                      <SubscribedModStatus v-bind="subscribedStatusProps(mod)" />
                      <ModEnabledControl v-bind="subscribedEnabledProps(mod)" />
                    </div>
                    <div class="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                      <SubscribedModActions v-bind="subscribedActionsProps(mod)" />
                      <button v-if="hasPermission('mod:toggle')" type="button" class="mod-sort-handle ml-auto"
                        :disabled="!canDragMod(mod)" :aria-label="'调整 ' + mod.name + ' 的加载顺序'"
                        title="拖动调整加载顺序，也可使用上下方向键" @keydown="onModSortKeydown($event, mod)">
                        <GripVertical :size="18" aria-hidden="true" /><span class="text-xs">顺序</span>
                      </button>
                    </div>
                  </article>
                </div>
              </div>
            </div>
          </NTabPane>

          <NTabPane name="market" tab="Mod 市场" display-directive="show" :tab-props="keyboardTabProps(activeTab === 'market')">
            <div class="min-w-0 space-y-3">
              <NAlert v-if="marketConnectionTitle" :title="marketConnectionTitle" type="warning" :bordered="false" role="status">
                <p v-if="steamLoadError">{{ steamLoadError }}</p>
                <p v-else-if="steamMeta?.offline && steamMods.length > 0">{{ resolveSteamOfflineHint(steamMeta) }}</p>
                <p v-else>暂时无法读取市场，可重试或查看连接帮助。</p>
                <div class="mt-2 flex flex-wrap gap-2">
                  <NButton size="small" :loading="loadingSteam" :disabled="!hasSelectedInstance" @click="loadSteamMods(false)">重试</NButton>
                  <NButton size="small" @click="accessStatusPanel?.openConfiguration()">代理配置说明</NButton>
                </div>
              </NAlert>
              <AdminListToolbar v-model:keyword="steamKeyword" keyword-placeholder="按名称搜索 Mod" :search-loading="loadingSteam"
                :disable-search-loading="loadingSteam" :reset-disabled="!steamKeyword && steamSort === 'trend' && steamTrendDays === 7"
                @search="loadSteamMods(true)" @reset="() => { steamKeyword = ''; steamSort = 'trend'; steamTrendDays = 7 }">
                <template #filters>
                  <NSelect v-model:value="steamSort" class="w-36" :options="steamSortOptions" aria-label="市场排序" />
                  <NSelect v-model:value="steamTrendDays" class="w-36" :disabled="!isSteamTrendSort" :options="steamTrendDaysOptions" aria-label="热度时间范围" />
                </template>
                <template #actions>
                  <NButton size="small" :loading="loadingSteam" :disabled="!hasSelectedInstance" @click="loadSteamMods(false)">刷新列表</NButton>
                </template>
              </AdminListToolbar>
              <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span v-if="steamPagingSummary">{{ steamPagingSummary }}</span>
                <span v-if="steamMetaText">{{ steamMetaText }}</span>
                <span v-if="steamSourceUrl">数据来源：<a :href="steamSourceUrl" target="_blank" rel="noopener noreferrer" class="underline">Steam Workshop</a></span>
              </div>
              <NDataTable v-if="!isMobileMode && (!marketConnectionTitle || steamMods.length > 0)" :bordered="false" :single-line="false" :columns="marketColumns"
                :data="steamMods" :loading="loadingSteam" :pagination="pagination"
                :row-key="(row: SteamModListQueryResultItem) => row.workshopId" class="dst-mod-table"
                max-height="max(320px, calc(var(--g-main-content-height) - 300px))" remote>
                <template #empty><NEmpty size="large" :description="marketEmptyDescription" /></template>
              </NDataTable>
              <div v-else-if="isMobileMode" class="space-y-3" :aria-busy="loadingSteam">
                <NEmpty v-if="!loadingSteam && steamMods.length === 0 && !marketConnectionTitle" size="small" :description="marketEmptyDescription" />
                <p v-if="loadingSteam && steamMods.length === 0" role="status" class="py-6 text-center text-sm text-muted-foreground">正在加载市场…</p>
                <article v-for="mod in steamMods" :key="mod.workshopId" class="min-w-0 rounded-lg border border-border bg-card p-3 space-y-3">
                  <div class="flex gap-3">
                    <NImage v-if="mod.previewImage" :src="mod.previewImage" width="56" height="56" object-fit="cover"
                      :alt="mod.title" lazy class="shrink-0 rounded" />
                    <div class="min-w-0 flex-1">
                      <h2 class="break-words text-sm font-medium">{{ mod.title }}</h2>
                      <p class="mt-1 font-mono text-xs text-muted-foreground">ID {{ mod.workshopId }}</p>
                      <NRate v-if="mod.rating != null" class="mt-1" readonly allow-half size="small" :value="mod.rating" />
                    </div>
                    <NTag size="small" :bordered="false" :type="marketStatusType(mod)">{{ marketStatusLabel(mod) }}</NTag>
                  </div>
                  <div class="flex flex-wrap gap-2">
                    <NButton v-if="hasPermission('mod:install')" size="small" type="primary" secondary
                      :loading="unsubscribingWorkshopIds.has(mod.workshopId)" :disabled="marketActionDisabled(mod)"
                      @click="handleMarketAction(mod)">{{ marketActionLabel(mod) }}</NButton>
                    <NButton v-if="resolveMarketSubscribeStatus(mod) === 'failed' && hasPermission('mod:install')" size="small"
                      :loading="unsubscribingWorkshopIds.has(mod.workshopId)" :disabled="marketActionDisabled(mod)"
                      @click="confirmUnsubscribeFromMarket(mod)">取消订阅</NButton>
                    <NButton size="small" :disabled="!hasSelectedInstance" @click="goToModDetail(mod.workshopId)">详情</NButton>
                  </div>
                </article>
                <NPagination v-if="resolvedPageCount > 1" :page="steamPage" :page-count="resolvedPageCount"
                  :disabled="loadingSteam" simple class="justify-center py-2" @update:page="changeSteamPage" />
              </div>
            </div>
          </NTabPane>
        </NTabs>
      </div>
      <ModAccessStatusPanel ref="accessStatusPanel" class="mt-4" :instance-id="selectedInstanceId" :queue="downloadQueue" />

      <ModConfigModal :key="'config-' + selectedInstanceId" v-model:show="configModalShow" :instance-id="selectedInstanceId"
        :workshop-id="configTarget?.workshopId ?? ''" :mod-name="configTarget?.name ?? ''" @saved="onModConfigSaved" />
      <LocalModImportModal :key="'import-' + selectedInstanceId" v-model:show="localImportShow" :instance-id="selectedInstanceId"
        :stopped="modInstanceStatus === 'stopped'" :existing-ids="installedMods.map(mod => mod.workshopId)" @imported="loadInstalledMods" />
    </FaPageMain>
  </div>
</template>

<style scoped>
.mod-instance-select { width: min(100%, 20rem); }
.mod-add-form { width: min(320px, calc(100vw - 64px)); }
.dst-mod-page :deep(.mod-sort-handle) {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px;
  border-radius: 4px;
  cursor: grab;
  touch-action: none;
}
.dst-mod-page :deep(.mod-sort-handle:disabled) { cursor: default; opacity: 0.35; }
.dst-mod-page :deep(.mod-sort-handle:focus-visible) { outline: 2px solid currentColor; outline-offset: 2px; }
.dst-mod-page :deep(.mod-sort-ghost) { opacity: 0.4; }
.dst-mod-table { font-variant-numeric: tabular-nums; }
@media (max-width: 600px) {
  .mod-instance-select { order: 1; width: 100%; }
}
</style>
