<script setup lang="ts">
/** 当前账号的权限判定；按钮级隐藏用，后端仍是唯一的安全边界 */
const { auth: hasPermission } = useAppAuth()

import type { DataTableColumns } from 'naive-ui'
import type {
  ModInstallStatus,
  ModItemDto,
  SteamModListQueryResultItem,
  SteamModSort,
  SteamModTrendDays,
} from '@/api/modules/mod'
import type { InstanceSummaryItem } from '@/api/modules/instance'
import { useDebounceFn } from '@vueuse/core'
import type { NotificationReactive } from 'naive-ui'
import { NAlert, NButton, NCard, NDataTable, NEmpty, NImage, NInput, NPagination, NRate, NSelect, NSwitch, NTabPane, NTabs, NTag, NTooltip, useDialog, useMessage, useNotification } from 'naive-ui'
import AdminListToolbar from '@/components/AdminListToolbar.vue'
import { computed, h, onMounted, ref, shallowRef, watch } from 'vue'
import apiInstance from '@/api/modules/instance'
import apiMod from '@/api/modules/mod'
import { isInstallableGameInstance } from '@/composables/useGameInstance'
import { useInstanceModState } from '@/composables/useInstanceModState'
import ModConfigModal from '@/views/games/dst/mod/components/ModConfigModal.vue'
import { resolveModUpdateCheckNotice } from '@/views/games/dst/mod/modUpdateCheckPresentation'
import { routeToDstModDetail, routeToDstWorldSettings, routeToNodeInstance } from '@/navigation/game-routes'
import { MOD_INSTALL_STATUS, MOD_UPDATE_STATUS } from '@/constants/statusDictionary'
import { getInstanceState } from '@/views/node/instance/instanceDisplay'

defineOptions({
  name: 'DstModList',
})

const router = useRouter()
const message = useMessage()
const dialog = useDialog()
const notification = useNotification()
const appSettingsStore = useAppSettingsStore()
const isMobileMode = computed(() => appSettingsStore.mode === 'mobile')

/** 订阅成功引导卡：持久展示，引导用户去世界设置开启 Mod */
const subscribeGuideNotificationRef = ref<NotificationReactive | null>(null)
/** 服务端下发的 Mod 风险提示横幅（加载列表/切换开关时更新） */
const riskTipBanner = ref<string | null>(null)
/** Steam 列表加载失败原因：与空列表区分 */
const steamLoadError = ref<string | null>(null)

interface BusinessErrorLike {
  error?: string
  code?: string
}

interface SteamModMeta {
  cached: boolean
  stale: boolean
  cacheAgeMs: number
  source?: 'live' | 'cache-fresh' | 'cache-stale'
  upstreamSource: 'official' | 'relay' | 'html'
  lastSuccessSource?: 'official' | 'relay' | 'html'
  lastSuccessAt?: string
  retryAfterMs?: number
  upstreamUnavailable?: boolean
  upstreamMessage?: string
  steamErrorCode?: string
  /** 命中的是离线兜底数据：上游连不上，列表停在最后一次成功拉取的版本 */
  offline?: boolean
  /** 离线数据的最后成功拉取时间（ISO） */
  dataFetchedAt?: string
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
/** 加载顺序调整中：期间禁用全部上移/下移按钮，避免并发提交 */
const reorderingMods = ref(false)
const configModalShow = ref(false)
const configTarget = ref<{ workshopId: string, name: string } | null>(null)
const instances = ref<InstanceSummaryItem[]>([])
const selectedInstanceId = ref('')
const {
  downloadingMods,
  isPendingWorkshop,
  restoreInstallJobs,
  installMod,
  syncPendingWorkshopIds,
  resetState,
} = useInstanceModState(() => selectedInstanceId.value)
const activeTab = ref<'market' | 'subscribed'>('market')
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
const steamMeta = ref<SteamModMeta | null>(null)
const steamUpstreamHint = ref<string | null>(null)
const steamAbortController = shallowRef<AbortController | null>(null)
const suppressSteamSortWatchUntil = ref(0)

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

function renderModPreview(previewImage: string | null) {
  if (!previewImage) {
    return h('div', {
      class: 'flex size-12 items-center justify-center rounded bg-muted text-xs text-muted-foreground',
    }, '无图')
  }
  return h(NImage, {
    src: previewImage,
    width: 48,
    height: 48,
    objectFit: 'cover',
    lazy: true,
    previewDisabled: false,
    class: 'rounded',
  })
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
const selectedInstanceName = computed(() =>
  instanceOptions.value.find(item => item.value === selectedInstanceId.value)?.label ?? '-',
)
const marketEmptyDescription = computed(() => {
  if (!selectedInstanceId.value) {
    return '请先选择实例'
  }
  if (steamLoadError.value) {
    return steamLoadError.value
  }
  if (steamKeyword.value.trim()) {
    return '未找到符合条件的 Mod'
  }
  return '暂无 Mod 数据'
})
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
  const outdated = installedMods.value.filter(mod => mod.updateStatus === 'outdated').length
  const unidentified = installedMods.value.filter(mod => !isModNameIdentified(mod)).length
  return { total, pending, failed, outdated, unidentified, ready: total - pending - failed }
})
const selectedUpdatableMods = computed(() =>
  installedMods.value.filter(mod =>
    checkedRowKeys.value.includes(mod.workshopId) && isModUpdatable(mod),
  ),
)

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
  return mod.installStatus === 'ready'
    && mod.updateStatus === 'outdated'
    && !isPendingWorkshop(mod.workshopId)
}

function canRedownloadMod(mod: ModItemDto): boolean {
  return mod.installStatus === 'ready'
    && mod.updateStatus === 'unknown'
    && !isPendingWorkshop(mod.workshopId)
}

function modUpdateTagType(status: ModItemDto['updateStatus']): 'default' | 'success' | 'warning' {
  if (status === 'outdated') return 'warning'
  return status === 'up_to_date' ? 'success' : 'default'
}

/** 无法判断版本的原因提示：让「未检查」与「查不到」区分开，而不是笼统一句不知道 */
function modUpdateTooltip(mod: ModItemDto): string {
  if (mod.updateStatus === 'outdated') {
    return '创意工坊上有更新的版本，点「更新」重新下载后再重启实例'
  }
  if (mod.updateStatus === 'up_to_date') {
    return `已是最新版本${mod.updateCheckedAt ? `（检查于 ${formatCheckedAt(mod.updateCheckedAt)}）` : ''}`
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
  if (status === 'pending') return '下载中'
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

function subscribedStatusLabel(row: ModItemDto): string {
  if (row.installStatus === 'pending' || isPendingWorkshop(row.workshopId)) {
    return MOD_INSTALL_STATUS.pending.label
  }
  if (row.installStatus === 'failed') {
    return MOD_INSTALL_STATUS.failed.label
  }
  return MOD_INSTALL_STATUS.ready.label
}

function subscribedStatusType(row: ModItemDto): 'success' | 'warning' | 'error' {
  if (row.installStatus === 'pending' || isPendingWorkshop(row.workshopId)) return 'warning'
  return row.installStatus === 'failed' ? 'error' : 'success'
}

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

function isSteamOfflineMeta(meta: SteamModMeta | null | undefined): boolean {
  return Boolean(meta?.offline)
}

/** 离线兜底的横幅：说清「为什么是旧的」以及「怎么办」 */
function resolveSteamOfflineHint(meta: SteamModMeta): string {
  const fetchedAt = meta.dataFetchedAt ? formatDateTime(meta.dataFetchedAt) : null
  return fetchedAt
    ? `暂时连不上 Steam 创意工坊，当前显示的是 ${fetchedAt} 的缓存内容`
    : '暂时连不上 Steam 创意工坊，当前显示的是缓存内容'
}

const steamMetaText = computed(() => {
  if (!steamMeta.value) {
    return ''
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
  return `更新于 ${ageText}`
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

const STEAM_UPSTREAM_HINT_FALLBACK = '暂时无法加载 Steam 列表，请稍后点击刷新重试'

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

function resolveSteamUpstreamHint(message?: string | null): string {
  if (!message || isTechnicalSteamErrorMessage(message)) {
    return STEAM_UPSTREAM_HINT_FALLBACK
  }
  return message
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function showSubscribeSuccessGuide() {
  subscribeGuideNotificationRef.value?.destroy()
  subscribeGuideNotificationRef.value = notification.success({
    title: '订阅成功',
    content: 'Mod 已下载完成。请到「世界管理」开启该 Mod，重启实例后生效。',
    duration: 0,
    closable: true,
    onClose: () => {
      subscribeGuideNotificationRef.value = null
    },
    /**
     * 这个按钮跳的是「世界管理」模块（world:read）。目标模块无权时那条路由根本没注册，
     * 按名跳转会在路由解析阶段抛 `No match`——按钮看起来就是坏的，所以干脆不渲染。
     */
    action: () => hasPermission('world:read')
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
                router.push(routeToDstWorldSettings(selectedInstanceId.value))
              }
            },
          },
          { default: () => '去开启 Mod' },
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
      { default: () => '下载中' },
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

function isSteamTransientError(error: unknown): boolean {
  if (typeof error === 'object' && error && 'data' in error) {
    const data = (error as { data?: { steamErrorCode?: string } }).data
    const code = data?.steamErrorCode
    return code === 'STEAM_TIMEOUT' || code === 'STEAM_UPSTREAM_UNAVAILABLE' || code === 'STEAM_RATE_LIMIT'
  }
  return false
}

const marketColumns: DataTableColumns<SteamModListQueryResultItem> = [
  {
    title: '缩略图',
    key: 'previewImage',
    width: 72,
    render: row => renderModPreview(row.previewImage),
  },
  {
    title: 'Mod 名称',
    key: 'title',
    minWidth: 220,
    render: row => row.title,
  },
  {
    title: '评价',
    key: 'rating',
    width: 130,
    render: row => renderModRating(row.rating),
  },
  {
    title: '创意工坊 ID',
    key: 'workshopId',
    width: 150,
    render: row => row.workshopId,
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
    width: 190,
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
                || (resolveMarketSubscribeStatus(row) === 'pending'),
              loading: unsubscribingWorkshopIds.value.has(row.workshopId),
              class: 'min-w-[4.5rem]',
              onClick: () => {
                const status = resolveMarketSubscribeStatus(row)
                if (row.installed || status === 'ready') {
                  confirmUnsubscribeFromMarket(row)
                  return
                }
                if (status === 'failed') {
                  void retryFromMarket(row)
                  return
                }
                if (status === 'pending') {
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
                  return '订阅中'
                }
                if (resolveMarketSubscribeStatus(row) === 'failed') {
                  return '重试'
                }
                return '订阅'
              },
            },
          )]
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

const subscribedColumns: DataTableColumns<ModItemDto> = [
  {
    type: 'selection',
  },
  {
    title: '缩略图',
    key: 'previewImage',
    width: 72,
    render: row => renderModPreview(row.previewImage),
  },
  {
    title: 'Mod 名称',
    key: 'name',
    minWidth: 220,
    render: (row) => {
      if (isModNameIdentified(row)) {
        return row.name
      }
      // 名称没认出来时明确标出来，而不是显示一串看不出所以然的占位名
      return h('div', { class: 'flex items-center gap-2' }, [
        h('span', { class: 'text-muted-foreground' }, `workshop-${row.workshopId}`),
        h(NTag, { size: 'tiny', bordered: false, type: 'warning' }, { default: () => '未识别名称' }),
      ])
    },
  },
  {
    title: '评价',
    key: 'rating',
    width: 130,
    render: row => renderModRating(row.rating),
  },
  {
    title: '创意工坊 ID',
    key: 'workshopId',
    width: 150,
    render: row => row.workshopId,
  },
  {
    title: '版本',
    key: 'updateStatus',
    width: 120,
    render: (row) => {
      const descriptor = MOD_UPDATE_STATUS[row.updateStatus]
      const tag = h(
        NTag,
        { size: 'small', bordered: false, type: modUpdateTagType(row.updateStatus) },
        { default: () => descriptor.label },
      )
      return h(
        NTooltip,
        { trigger: 'hover' },
        { trigger: () => tag, default: () => modUpdateTooltip(row) },
      )
    },
  },
  {
    title: '安装状态',
    key: 'installStatus',
    width: 130,
    render: (row) => {
      const pending = row.installStatus === 'pending' || isPendingWorkshop(row.workshopId)
      const label = pending
        ? MOD_INSTALL_STATUS.pending.label
        : row.installStatus === 'failed' ? MOD_INSTALL_STATUS.failed.label : MOD_INSTALL_STATUS.ready.label
      const type = pending ? 'warning' : row.installStatus === 'failed' ? 'error' : 'success'
      const tag = h(NTag, { size: 'small', bordered: false, type }, { default: () => label })
      const errorText = row.installError?.trim()
      // 文件状态与「启用」是两件事：无论如何都要能悬停看懂，出错时优先说原因
      const tooltipText = errorText
        ? (errorText.length > 160 ? `${errorText.slice(0, 160)}…` : errorText)
        : (label === MOD_INSTALL_STATUS.ready.label
            ? 'Mod 文件已下载并放入服务器目录；是否在游戏里生效看「启用」开关'
            : 'Mod 文件尚未就绪，就绪后才能启用')
      return h(
        NTooltip,
        { trigger: 'hover' },
        {
          trigger: () => tag,
          default: () => tooltipText,
        },
      )
    },
  },
  {
    title: '启用',
    key: 'enabled',
    width: 90,
    // 没有 mod:toggle 就不给开关：改成只读标签，避免整列看起来是空的
    render: row => (hasPermission('mod:toggle')
      ? h(NSwitch, {
          size: 'small',
          value: row.enabled,
          disabled: !hasSelectedInstance.value
            || row.installStatus !== 'ready'
            || isPendingWorkshop(row.workshopId)
            || unsubscribingWorkshopIds.value.has(row.workshopId),
          'onUpdate:value': () => void toggleSubscribedMod(row),
        })
      : h(NTag, { size: 'small', bordered: false }, { default: () => (row.enabled ? '已启用' : '已停用') })),
  },
  {
    title: '操作',
    key: 'actions',
    width: 400,
    render: (row, index) => h('div', { class: 'flex items-center gap-3' }, [
      ...(row.installStatus === 'ready'
        ? [
            // 「更新」只在创意工坊确实有新版本时出现，否则这个按钮点下去毫无意义
            ...(isModUpdatable(row) && hasPermission('mod:install')
              ? [h(
                  NButton,
                  {
                    size: 'tiny',
                    type: 'primary',
                    disabled: !hasSelectedInstance.value || isPendingWorkshop(row.workshopId),
                    class: 'w-14',
                    onClick: () => void updateInstalledMod(row),
                  },
                  { default: () => '更新' },
                )]
              : []),
            // 版本无法判断时留一个出口：重新下载一次，让本机内容与工坊对齐
            ...(canRedownloadMod(row) && hasPermission('mod:install')
              ? [h(
                  NButton,
                  {
                    size: 'tiny',
                    disabled: !hasSelectedInstance.value || isPendingWorkshop(row.workshopId),
                    class: 'w-16',
                    onClick: () => void updateInstalledMod(row),
                  },
                  { default: () => '重新下载' },
                )]
              : []),
            ...(hasPermission('mod:config')
              ? [h(
                  NButton,
                  {
                    size: 'tiny',
                    disabled: !hasSelectedInstance.value || isPendingWorkshop(row.workshopId),
                    class: 'w-14',
                    onClick: () => openModConfig(row),
                  },
                  { default: () => '配置' },
                )]
              : [])]
        : []),
      ...(hasPermission('mod:install')
        ? [h(
            NButton,
            {
              size: 'tiny',
              type: row.installStatus === 'failed' ? 'primary' : 'default',
              disabled: !hasSelectedInstance.value
                || unsubscribingWorkshopIds.value.has(row.workshopId)
                || row.installStatus === 'pending'
                || isPendingWorkshop(row.workshopId),
              loading: unsubscribingWorkshopIds.value.has(row.workshopId),
              class: 'w-16',
              onClick: () => {
                if (row.installStatus === 'failed') {
                  void retryFailedInstall(row)
                  return
                }
                confirmUnsubscribe(row)
              },
            },
            { default: () => (row.installStatus === 'failed' ? '重试' : '取消订阅') },
          )]
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
      // 加载顺序调整属于 mod:toggle
      ...(hasPermission('mod:toggle')
        ? [
            h(
              NButton,
              {
                size: 'tiny',
                text: true,
                disabled: !canMoveInstalledMod(row, index, -1),
                onClick: () => void moveInstalledMod(index, -1),
              },
              { default: () => '上移' },
            ),
            h(
              NButton,
              {
                size: 'tiny',
                text: true,
                disabled: !canMoveInstalledMod(row, index, 1),
                onClick: () => void moveInstalledMod(index, 1),
              },
              { default: () => '下移' },
            ),
          ]
        : []),
    ]),
  },
]

async function loadInstances() {
  loadingInstances.value = true
  try {
    const response = await apiInstance.getInstanceOptions()
    const rows = (response.data ?? []) as InstanceSummaryItem[]
    instances.value = rows.filter(isInstallableGameInstance)
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
  if (!selectedInstanceId.value) {
    installedMods.value = []
    resetState()
    return
  }
  loadingInstalled.value = true
  try {
    // 补缩略图：导入存档带进来的 Mod 本地没有图，服务端按创意工坊 ID 补齐后落库，只补缺的那些
    const response = await apiMod.getModList(selectedInstanceId.value, { enrich: 'previews' })
    installedMods.value = response.data.mods
    riskTipBanner.value = response.data.riskTip?.trim() || null
    void restoreInstallJobs({
      modList: response.data,
      onTerminal: job => void handleInstallJobTerminal(job),
    })
  }
  catch (error: unknown) {
    installedMods.value = []
    resetState()
    if (isAuthUnauthorizedError(error)) {
      return
    }
    message.error(getErrorMessage(error, '加载已订阅 Mod 失败'))
  }
  finally {
    loadingInstalled.value = false
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
    else {
      await loadInstalledMods()
    }
    mergeSteamRowAfterJob(job.workshopId, 'ready')
    showSubscribeSuccessGuide()
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
  if (!selectedInstanceId.value || unsubscribingWorkshopIds.value.has(item.workshopId) || item.installStatus !== 'ready') {
    return
  }
  const nextMutating = new Set(unsubscribingWorkshopIds.value)
  nextMutating.add(item.workshopId)
  unsubscribingWorkshopIds.value = nextMutating
  try {
    const response = await apiMod.updateMod(selectedInstanceId.value, item.workshopId, {
      enabled: !item.enabled,
    })
    const riskTip = response.data.riskTip?.trim()
    message.success(`${item.enabled ? '已关闭' : '已开启'}该 Mod，重启实例后生效（可在实例管理执行重启）`)
    if (riskTip) {
      riskTipBanner.value = riskTip
    }
    installedMods.value = installedMods.value.map(row => (
      row.workshopId === item.workshopId
        ? { ...row, enabled: !row.enabled }
        : row
    ))
  }
  catch (error: unknown) {
    if (isAuthUnauthorizedError(error)) {
      return
    }
    message.error(getErrorMessage(error, '更新 Mod 状态失败，请稍后重试'))
  }
  finally {
    const next = new Set(unsubscribingWorkshopIds.value)
    next.delete(item.workshopId)
    unsubscribingWorkshopIds.value = next
  }
}

async function retryFromMarket(row: SteamModListQueryResultItem) {
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
      onTerminal: job => void handleInstallJobTerminal(job),
    })
  }
  catch (error: unknown) {
    if (isAuthUnauthorizedError(error)) {
      return
    }
    message.error(getErrorMessage(error, '重试订阅失败，请稍后重试'))
  }
}

async function retryFailedInstall(row: ModItemDto) {
  if (!selectedInstanceId.value || isPendingWorkshop(row.workshopId)) {
    return
  }
  try {
    await installMod({
      workshopId: row.workshopId,
      name: row.name,
      previewImage: row.previewImage ?? undefined,
    }, {
      onTerminal: job => void handleInstallJobTerminal(job),
    })
  }
  catch (error: unknown) {
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
      onTerminal: job => void handleInstallJobTerminal(job),
    })
  }
  catch (error: unknown) {
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
  if (!selectedInstanceId.value || workshopIds.length === 0 || batchUpdating.value) {
    return
  }
  const skippedCount = options?.skippedCount ?? 0
  batchUpdating.value = true
  try {
    const response = await apiMod.batchUpdateMods(selectedInstanceId.value, {
      workshopIds,
    })
    const downloadingIds = response.data
      .filter(job => job.status === 'downloading')
      .map(job => job.workshopId)
    syncPendingWorkshopIds(downloadingIds, {
      onTerminal: job => void handleInstallJobTerminal(job),
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
    if (isAuthUnauthorizedError(error)) {
      return
    }
    message.error(getErrorMessage(error, '批量更新失败，请稍后重试'))
  }
  finally {
    batchUpdating.value = false
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

/** 一键更新全部有新版本的 Mod */
async function updateAllOutdatedMods() {
  const targets = installedMods.value.filter(mod => isModUpdatable(mod))
  if (targets.length === 0) {
    message.info('当前没有需要更新的 Mod')
    return
  }
  await runBatchUpdate(targets.map(mod => mod.workshopId))
}

/** 全部重试失败的 Mod：导入存档后一次性把没下全的补齐 */
async function retryAllFailedMods() {
  if (!selectedInstanceId.value) {
    return
  }
  const targets = installedMods.value.filter(mod =>
    mod.installStatus === 'failed' && !isPendingWorkshop(mod.workshopId),
  )
  if (targets.length === 0) {
    return
  }
  retryingFailedMods.value = true
  try {
    for (const mod of targets) {
      await installMod({
        workshopId: mod.workshopId,
        name: mod.name,
        previewImage: mod.previewImage ?? undefined,
      }, {
        onTerminal: job => void handleInstallJobTerminal(job),
      })
    }
    message.success(`已重新排队下载 ${targets.length} 个 Mod，可在列表中查看进度`)
  }
  catch (error: unknown) {
    if (isAuthUnauthorizedError(error)) {
      return
    }
    message.error(getErrorMessage(error, '重新下载失败，请稍后重试'))
  }
  finally {
    retryingFailedMods.value = false
  }
}

/** 检查更新：判断哪些 Mod 不是创意工坊上的最新版，顺带按工坊标题补全名称与缩略图 */
async function checkModUpdates() {
  if (!selectedInstanceId.value || checkingUpdates.value) {
    return
  }
  checkingUpdates.value = true
  try {
    const response = await apiMod.checkModUpdates(selectedInstanceId.value, { force: true })
    await loadInstalledMods()
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
    if (isAuthUnauthorizedError(error)) {
      return
    }
    // 取不到工坊信息时不动已有状态：明确告诉用户「沿用上次结果」而不是当成已是最新
    message.error(getErrorMessage(error, '检查 Mod 更新失败，已沿用上次结果'))
  }
  finally {
    checkingUpdates.value = false
  }
}

/** 可参与排序的 Mod：服务端只对「已就绪」的 Mod 落库加载顺序，其余行禁用上移/下移 */
function isReorderableInstalledMod(row: ModItemDto): boolean {
  return row.installStatus === 'ready' && !isPendingWorkshop(row.workshopId)
}

/**
 * 上移/下移按钮可用性：首行不能上移、末行不能下移、单个 Mod 全部禁用、请求进行中全部禁用；
 * 目标位置本身不可排序时同样禁用，避免出现「提示成功但顺序没变」。
 */
function canMoveInstalledMod(row: ModItemDto, index: number, offset: number): boolean {
  if (reorderingMods.value || !hasSelectedInstance.value || installedMods.value.length < 2) {
    return false
  }
  if (!isReorderableInstalledMod(row)) {
    return false
  }
  const target = index + offset
  if (target < 0 || target >= installedMods.value.length) {
    return false
  }
  return isReorderableInstalledMod(installedMods.value[target])
}

/** 上移/下移一位：提交调整后的完整顺序，成功后以服务端返回的列表为准 */
async function moveInstalledMod(index: number, offset: number) {
  const current = installedMods.value
  const target = index + offset
  const instanceId = selectedInstanceId.value
  if (
    !instanceId
    || reorderingMods.value
    || index < 0
    || index >= current.length
    || target < 0
    || target >= current.length
    || !isReorderableInstalledMod(current[index])
    || !isReorderableInstalledMod(current[target])
  ) {
    return
  }
  const reordered = [...current]
  const moved = reordered.splice(index, 1)
  reordered.splice(target, 0, ...moved)
  reorderingMods.value = true
  try {
    const response = await apiMod.reorderMods(instanceId, {
      workshopIds: reordered.filter(mod => isReorderableInstalledMod(mod)).map(mod => mod.workshopId),
    })
    installedMods.value = response.data.mods
    const riskTip = response.data.riskTip?.trim()
    if (riskTip) {
      riskTipBanner.value = riskTip
    }
    message.success('已调整 Mod 加载顺序，重启实例后生效（可在实例管理执行重启）')
  }
  catch (error: unknown) {
    if (isAuthUnauthorizedError(error)) {
      return
    }
    message.error(getErrorMessage(error, '调整 Mod 加载顺序失败，请稍后重试'))
  }
  finally {
    reorderingMods.value = false
  }
}

async function loadSteamMods(
  resetPage = false,
  options?: { isRetry?: boolean, suppressErrorToast?: boolean },
) {
  if (!selectedInstanceId.value) {
    steamMods.value = []
    steamHasMore.value = false
    steamTotalCount.value = null
    steamTotalPages.value = null
    steamMeta.value = null
    steamUpstreamHint.value = null
    return
  }
  if (resetPage) {
    steamPage.value = 1
  }
  steamAbortController.value?.abort()
  const controller = new AbortController()
  steamAbortController.value = controller
  loadingSteam.value = true
  try {
    const response = await apiMod.getSteamModList(selectedInstanceId.value, {
      keyword: steamKeyword.value.trim() || undefined,
      page: steamPage.value,
      pageSize: steamPageSize.value,
      sort: steamSort.value,
      trendDays: steamTrendDays.value,
    }, {
      signal: controller.signal,
    })
    if (controller.signal.aborted) {
      return
    }
    if (response.data.meta?.upstreamUnavailable) {
      steamUpstreamHint.value = resolveSteamUpstreamHint(response.data.meta.upstreamMessage)
      // 后端给的是「连不上上游且一条缓存都没有」，此时确实没有内容可显示。
      // 但如果本地还留着上一次成功的列表，就保留它——空白页比一份明确标注的
      // 离线列表更没用（用户连自己订阅过什么都想不起来）。
      if (!hasRenderedSteamRows.value) {
        steamMods.value = []
        steamHasMore.value = false
        steamTotalCount.value = null
        steamTotalPages.value = null
      }
      steamSourceUrl.value = response.data.sourceUrl
      steamPage.value = response.data.page
      steamPageSize.value = response.data.pageSize > 0 ? response.data.pageSize : steamPageSize.value
      steamMeta.value = response.data.meta
      return
    }
    steamUpstreamHint.value = isSteamOfflineMeta(response.data.meta)
      ? resolveSteamOfflineHint(response.data.meta)
      : null
    steamLoadError.value = null
    steamMods.value = mergeSteamRowsWithInstalled(response.data.items, installedMods.value)
    steamSourceUrl.value = response.data.sourceUrl
    steamHasMore.value = response.data.hasMore
    steamTotalCount.value = response.data.totalCount
    steamTotalPages.value = response.data.totalPages
    steamPage.value = response.data.page
    steamPageSize.value = response.data.pageSize > 0 ? response.data.pageSize : steamPageSize.value
    steamMeta.value = response.data.meta
    syncPendingWorkshopIds(response.data.pendingWorkshopIds ?? [], {
      onTerminal: job => void handleInstallJobTerminal(job),
    })
  }
  catch (error: unknown) {
    if (isRequestCanceled(error)) {
      return
    }
    if (!options?.isRetry && isSteamTransientError(error)) {
      await sleep(1800)
      if (!controller.signal.aborted) {
        return loadSteamMods(resetPage, { isRetry: true })
      }
      return
    }
    // 请求整个失败了（超时/网络中断）：有内容就留着，只在确实空白时清空。
    // 之前无论有没有内容都清空，用户看到的是「列表自己消失了」。
    if (!hasRenderedSteamRows.value) {
      steamMods.value = []
      steamHasMore.value = false
      steamTotalCount.value = null
      steamTotalPages.value = null
    }
    steamSourceUrl.value = ''
    steamMeta.value = null
    if (isAuthUnauthorizedError(error)) {
      return
    }
    steamLoadError.value = getErrorMessage(error, 'Steam 创意工坊列表加载失败，请点击重试')
    if (!options?.suppressErrorToast) {
      message.error(getErrorMessage(error, '加载 Steam 创意工坊列表失败'))
    }
  }
  finally {
    if (steamAbortController.value === controller) {
      steamAbortController.value = null
    }
    loadingSteam.value = false
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
      onTerminal: job => void handleInstallJobTerminal(job),
    })
  }
  catch (error: unknown) {
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
  if (status === 'failed') {
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
  if (status === 'pending' || isPendingWorkshop(item.workshopId)) return '订阅中'
  return status === 'failed' ? '重试' : '订阅'
}

function marketActionDisabled(item: SteamModListQueryResultItem): boolean {
  return !hasSelectedInstance.value
    || unsubscribingWorkshopIds.value.has(item.workshopId)
    || resolveMarketSubscribeStatus(item) === 'pending'
}

function handleSubscribedAction(item: ModItemDto) {
  if (item.installStatus === 'failed') {
    void retryFailedInstall(item)
    return
  }
  confirmUnsubscribe(item)
}

function confirmUnsubscribe(row: ModItemDto) {
  openUnsubscribeConfirm(row.workshopId, row.name)
}

function confirmUnsubscribeFromMarket(row: SteamModListQueryResultItem) {
  openUnsubscribeConfirm(row.workshopId, row.title)
}

function openUnsubscribeConfirm(workshopId: string, modName: string) {
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
      void unsubscribeMod(workshopId)
    },
  })
}

async function unsubscribeMod(workshopId: string) {
  if (!selectedInstanceId.value || unsubscribingWorkshopIds.value.has(workshopId)) {
    return
  }
  const nextUnsubscribing = new Set(unsubscribingWorkshopIds.value)
  nextUnsubscribing.add(workshopId)
  unsubscribingWorkshopIds.value = nextUnsubscribing
  try {
    await apiMod.deleteMod(selectedInstanceId.value, workshopId)
    installedMods.value = installedMods.value.filter(item => item.workshopId !== workshopId)
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
    if (isAuthUnauthorizedError(error)) {
      return
    }
    message.error(getErrorMessage(error, '取消订阅失败，请稍后重试'))
  }
  finally {
    const next = new Set(unsubscribingWorkshopIds.value)
    next.delete(workshopId)
    unsubscribingWorkshopIds.value = next
  }
}

const manualWorkshopInput = ref('')

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
  const workshopId = extractWorkshopId(manualWorkshopInput.value)
  if (!workshopId) {
    message.warning('请输入有效的创意工坊 ID 或 Mod 详情页链接')
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
  try {
    await installMod({
      workshopId,
      name: `工坊 ${workshopId}`,
    }, {
      onTerminal: job => void handleInstallJobTerminal(job),
    })
    manualWorkshopInput.value = ''
  }
  catch (error: unknown) {
    if (isAuthUnauthorizedError(error)) {
      return
    }
    message.error(getErrorMessage(error, '订阅失败，请稍后重试'))
  }
}

function onInstanceChange(value: string) {
  selectedInstanceId.value = value
  activeTab.value = 'market'
  checkedRowKeys.value = []
  resetState()
  void Promise.all([loadSteamMods(true), loadInstalledMods()])
}

const triggerSteamReloadDebounced = useDebounceFn(() => {
  if (!selectedInstanceId.value) {
    return
  }
  void loadSteamMods(true)
}, 400)

watch([steamSort, steamTrendDays], () => {
  if (Date.now() < suppressSteamSortWatchUntil.value) {
    return
  }
  if (!selectedInstanceId.value) {
    return
  }
  triggerSteamReloadDebounced()
})

watch(steamKeyword, (keyword, previousKeyword) => {
  if (!keyword.trim() && steamSort.value === 'relevance') {
    steamSort.value = 'trend'
    if (selectedInstanceId.value) {
      triggerSteamReloadDebounced()
    }
    return
  }
  if (!selectedInstanceId.value || keyword.trim() === previousKeyword.trim()) {
    return
  }
  triggerSteamReloadDebounced()
})

watch(activeTab, (tab) => {
  if (tab === 'subscribed' && selectedInstanceId.value && !loadingInstalled.value) {
    void loadInstalledMods()
  }
})

onMounted(async () => {
  suppressSteamSortWatchUntil.value = Date.now() + 500
  await loadInstances()
  await Promise.all([loadSteamMods(true), loadInstalledMods()])
})
</script>

<template>
  <!-- 整屏工作台：高度用 layout 的内容区高度变量自撑，不再用 `absolute inset-0`（父级高度为 0 会把整页裁掉） -->
  <div class="dst-mod-page flex h-[var(--g-main-content-height)] flex-col overflow-hidden p-3 md:p-4">
    <FaPageMain 
      class="flex min-h-0 flex-1 flex-col overflow-hidden !m-0 h-full"
      main-class="dst-mod-main flex min-h-0 flex-1 flex-col overflow-y-auto gap-4"
    >
      <div>
        <h2 class="m-0 text-lg font-semibold">
          Mod 订阅
        </h2>
        <p class="mt-1 text-sm text-muted-foreground">
          订阅服务器 Mod：在「Mod 市场」浏览 Steam 创意工坊，或在「已订阅」页签管理当前实例的 Mod 并控制开启状态。开启后需重启实例生效。
        </p>
      </div>

      <NCard size="small" title="实例选择" class="mb-0 shrink-0">
        <div class="flex flex-wrap items-center gap-3">
          <NSelect
            class="w-full md:w-80"
            :value="selectedInstanceId || null"
            :loading="loadingInstances"
            :options="instanceOptions"
            :disabled="!hasInstallableInstances"
            :placeholder="instanceSelectPlaceholder"
            @update:value="onInstanceChange"
          />
          <NButton
            v-if="!hasInstallableInstances && !loadingInstances && hasPermission('instance:read')"
            type="primary"
            @click="router.push(routeToNodeInstance())"
          >
            前往实例管理
          </NButton>
          <span v-if="hasSelectedInstance" class="text-xs text-muted-foreground">
            当前目标实例：{{ selectedInstanceName }}
          </span>
        </div>
      </NCard>

      <NAlert
        v-if="riskTipBanner"
        type="warning"
        class="mb-4 shrink-0"
        closable
        @close="riskTipBanner = null"
      >
        {{ riskTipBanner }}
      </NAlert>

      <NCard
        size="small"
        title="Steam 创意工坊"
        class="dst-mod-workshop-card flex flex-1 flex-col"
        content-class="flex min-h-0 flex-1 flex-col"
      >
        <div class="flex min-h-0 flex-1 flex-col gap-3">
          <div class="flex shrink-0 flex-wrap items-center gap-3">
            <div
              v-if="steamUpstreamHint"
              class="flex w-full flex-wrap items-center justify-between gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning"
            >
              <span>{{ steamUpstreamHint }}</span>
              <NButton size="small" :disabled="!selectedInstanceId || loadingSteam" @click="loadSteamMods(true)">
                重试
              </NButton>
            </div>
            <AdminListToolbar
              v-model:keyword="steamKeyword"
              keyword-placeholder="按名称搜索 Mod"
              :search-loading="loadingSteam"
              :disable-search-loading="loadingSteam"
              :reset-disabled="!steamKeyword && steamSort === 'trend' && steamTrendDays === 7"
              @search="loadSteamMods(true)"
              @reset="() => { steamKeyword = ''; steamSort = 'trend'; steamTrendDays = 7 }"
            >
              <template #filters>
                <NSelect
                  v-model:value="steamSort"
                  class="w-full md:w-36"
                  :options="steamSortOptions"
                />
                <NSelect
                  v-model:value="steamTrendDays"
                  class="w-full md:w-36"
                  :disabled="!isSteamTrendSort"
                  :options="steamTrendDaysOptions"
                />
              </template>
              <template #actions>
                <NInput
                  v-model:value="manualWorkshopInput"
                  class="w-full md:w-56"
                  placeholder="粘贴工坊 ID 或详情页链接"
                  clearable
                  @keydown.enter="subscribeManualWorkshop"
                />
                <NButton :disabled="!selectedInstanceId" @click="subscribeManualWorkshop" v-if="hasPermission('mod:install')">
                  直接订阅
                </NButton>
                <NButton type="primary" :disabled="!selectedInstanceId" @click="loadSteamMods(true)">
                  刷新列表
                </NButton>
              </template>
            </AdminListToolbar>
            <span v-if="steamPagingSummary" class="text-xs text-muted-foreground whitespace-nowrap">
              {{ steamPagingSummary }}
            </span>
            <span v-if="steamMetaText" class="text-xs text-muted-foreground whitespace-nowrap">
              {{ steamMetaText }}
            </span>
            <span v-if="steamSourceUrl" class="text-xs text-muted-foreground whitespace-nowrap">
              数据来源：<a :href="steamSourceUrl" target="_blank" class="underline">Steam Workshop</a>
            </span>
          </div>

          <NTabs v-model:value="activeTab" type="segment" class="dst-mod-tabs min-h-0 flex-1">
            <NTabPane name="market" tab="Mod 市场" display-directive="show" class="h-full">
              <NDataTable
                v-if="!isMobileMode"
                :bordered="false"
                :single-line="false"
                :columns="marketColumns"
                :data="steamMods"
                :loading="loadingSteam"
                :pagination="pagination"
                :row-key="(row: SteamModListQueryResultItem) => row.workshopId"
                class="dst-mod-table h-full"
                flex-height
                remote
                :scroll-x="1180"
              >
                <template #empty>
                  <div class="dst-mod-table-empty">
                    <NEmpty size="large" :description="marketEmptyDescription">
                      <template v-if="steamLoadError" #extra>
                        <NButton size="small" @click="loadSteamMods(true)">
                          重试
                        </NButton>
                      </template>
                    </NEmpty>
                  </div>
                </template>
              </NDataTable>
              <div v-else class="dst-mod-market-list space-y-3 overflow-y-auto pr-1" :aria-busy="loadingSteam">
                <NEmpty v-if="!loadingSteam && steamMods.length === 0" size="small" :description="marketEmptyDescription">
                  <template v-if="steamLoadError" #extra>
                    <NButton size="small" @click="loadSteamMods(true)">
                      重试
                    </NButton>
                  </template>
                </NEmpty>
                <article
                  v-for="mod in steamMods"
                  :key="mod.workshopId"
                  class="rounded-lg border border-border bg-card p-3 space-y-3"
                >
                  <div class="flex gap-3">
                    <NImage
                      v-if="mod.previewImage"
                      :src="mod.previewImage"
                      width="64"
                      height="64"
                      object-fit="cover"
                      lazy
                      class="shrink-0 rounded"
                    />
                    <div class="min-w-0 flex-1">
                      <h3 class="line-clamp-2 font-medium">{{ mod.title }}</h3>
                      <p class="mt-1 text-xs text-muted-foreground">Workshop ID: {{ mod.workshopId }}</p>
                      <NRate v-if="mod.rating != null" class="mt-1" readonly allow-half size="small" :value="mod.rating" />
                    </div>
                    <NTag size="small" :bordered="false" :type="marketStatusType(mod)">
                      {{ marketStatusLabel(mod) }}
                    </NTag>
                  </div>
                  <div class="flex gap-2">
                    <NButton
                      class="flex-1"
                      type="primary"
                      :loading="unsubscribingWorkshopIds.has(mod.workshopId)"
                      :disabled="marketActionDisabled(mod)"
                      @click="handleMarketAction(mod)"
                      v-if="hasPermission('mod:install')"
                    >
                      {{ marketActionLabel(mod) }}
                    </NButton>
                    <NButton :disabled="!hasSelectedInstance" @click="goToModDetail(mod.workshopId)">
                      详情
                    </NButton>
                  </div>
                </article>
                <NPagination
                  v-if="resolvedPageCount > 1"
                  :page="steamPage"
                  :page-count="resolvedPageCount"
                  :disabled="loadingSteam"
                  simple
                  class="justify-center py-2"
                  @update:page="changeSteamPage"
                />
              </div>
            </NTabPane>

            <NTabPane
              name="subscribed"
              display-directive="if"
              class="h-full min-h-0"
            >
              <template #tab>
                已订阅 ({{ subscribedTabCount }})
              </template>
              <div class="flex h-full min-h-0 flex-col">
                <div v-if="!isMobileMode" class="flex shrink-0 flex-wrap items-center gap-3 pb-2">
                  <NButton
                    size="small"
                    :loading="checkingUpdates"
                    :disabled="!hasSelectedInstance || installedMods.length === 0"
                    @click="checkModUpdates"
                  >
                    检查更新
                  </NButton>
                  <NButton
                    size="small"
                    type="primary"
                    secondary
                    :loading="batchUpdating"
                    :disabled="subscribedSummary.outdated === 0"
                    @click="updateAllOutdatedMods"
                   v-if="hasPermission('mod:install')">
                    全部更新 ({{ subscribedSummary.outdated }})
                  </NButton>
                  <NButton
                    v-if="(checkedRowKeys.length > 0) && hasPermission('mod:install')"
                    size="small"
                    secondary
                    :loading="batchUpdating"
                    :disabled="selectedUpdatableMods.length === 0"
                    @click="batchUpdateSelectedMods"
                  >
                    更新选中 ({{ selectedUpdatableMods.length }})
                  </NButton>
                  <NButton
                    v-if="(subscribedSummary.failed > 0) && hasPermission('mod:install')"
                    size="small"
                    type="warning"
                    secondary
                    :loading="retryingFailedMods"
                    @click="retryAllFailedMods"
                  >
                    重试全部失败 ({{ subscribedSummary.failed }})
                  </NButton>
                  <span class="text-xs text-muted-foreground">
                    共 {{ subscribedSummary.total }} · 就绪 {{ subscribedSummary.ready }} · 下载中 {{ subscribedSummary.pending }} · 失败 {{ subscribedSummary.failed }}
                    <template v-if="lastUpdateCheckedAt"> · 上次检查 {{ formatCheckedAt(lastUpdateCheckedAt) }}</template>
                  </span>
                </div>
                <NAlert
                  v-if="!isMobileMode && modCheckHint"
                  class="mb-2 shrink-0"
                  type="info"
                  :bordered="false"
                  closable
                >
                  {{ modCheckHint }}
                </NAlert>
                <NDataTable
                  v-if="!isMobileMode"
                  :key="`subscribed-${selectedInstanceId}`"
                  :bordered="false"
                  :single-line="false"
                  :columns="subscribedColumns"
                  :data="installedMods"
                  :loading="loadingInstalled"
                  :pagination="false"
                  :row-key="(row: ModItemDto) => row.workshopId"
                  :checked-row-keys="checkedRowKeys"
                  class="dst-mod-table min-h-0 flex-1"
                  flex-height
                  :scroll-x="1310"
                  @update:checked-row-keys="(keys: Array<string | number>) => checkedRowKeys = keys"
                >
                  <template #empty>
                    <div class="dst-mod-table-empty">
                      <NEmpty size="large" :description="subscribedEmptyDescription" />
                    </div>
                  </template>
                </NDataTable>
                <div v-else class="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1" :aria-busy="loadingInstalled">
                  <div class="flex flex-wrap gap-2">
                    <NButton
                      size="small"
                      :loading="checkingUpdates"
                      :disabled="!hasSelectedInstance || installedMods.length === 0"
                      @click="checkModUpdates"
                    >
                      检查更新
                    </NButton>
                    <NButton
                      v-if="(subscribedSummary.outdated > 0) && hasPermission('mod:install')"
                      size="small"
                      type="primary"
                      secondary
                      :loading="batchUpdating"
                      @click="updateAllOutdatedMods"
                    >
                      全部更新 ({{ subscribedSummary.outdated }})
                    </NButton>
                    <NButton
                      v-if="(subscribedSummary.failed > 0) && hasPermission('mod:install')"
                      size="small"
                      type="warning"
                      secondary
                      :loading="retryingFailedMods"
                      @click="retryAllFailedMods"
                    >
                      重试失败 ({{ subscribedSummary.failed }})
                    </NButton>
                  </div>
                  <p class="text-xs text-muted-foreground">
                    共 {{ subscribedSummary.total }} · 就绪 {{ subscribedSummary.ready }} · 下载中 {{ subscribedSummary.pending }} · 失败 {{ subscribedSummary.failed }}
                    <template v-if="lastUpdateCheckedAt"> · 上次检查 {{ formatCheckedAt(lastUpdateCheckedAt) }}</template>
                  </p>
                  <NEmpty v-if="!loadingInstalled && installedMods.length === 0" size="small" :description="subscribedEmptyDescription" />
                  <article
                    v-for="(mod, modIndex) in installedMods"
                    :key="mod.workshopId"
                    class="rounded-lg border border-border bg-card p-3 space-y-3"
                  >
                    <div class="flex gap-3">
                      <NImage
                        v-if="mod.previewImage"
                        :src="mod.previewImage"
                        width="64"
                        height="64"
                        object-fit="cover"
                        class="shrink-0 rounded"
                      />
                      <div class="min-w-0 flex-1">
                        <h3 class="line-clamp-2 font-medium">
                          {{ mod.name }}
                          <NTag v-if="!isModNameIdentified(mod)" class="ml-1" size="tiny" :bordered="false" type="warning">
                            未识别名称
                          </NTag>
                        </h3>
                        <p class="mt-1 text-xs text-muted-foreground">Workshop ID: {{ mod.workshopId }}</p>
                        <NRate v-if="mod.rating != null" class="mt-1" readonly allow-half size="small" :value="mod.rating" />
                        <p class="mt-1 text-xs text-muted-foreground">
                          版本：{{ MOD_UPDATE_STATUS[mod.updateStatus].label }}
                        </p>
                      </div>
                      <NTag size="small" :bordered="false" :type="subscribedStatusType(mod)">
                        {{ subscribedStatusLabel(mod) }}
                      </NTag>
                    </div>
                    <p v-if="mod.installError" class="text-sm text-rose-600 dark:text-rose-400">{{ mod.installError }}</p>
                    <div class="flex gap-2">
                      <NButton
                        v-if="isModUpdatable(mod) && hasPermission('mod:install')"
                        class="flex-1"
                        type="primary"
                        :disabled="!hasSelectedInstance || isPendingWorkshop(mod.workshopId)"
                        @click="updateInstalledMod(mod)"
                      >
                        更新
                      </NButton>
                      <NButton
                        v-else-if="canRedownloadMod(mod) && hasPermission('mod:install')"
                        class="flex-1"
                        :disabled="!hasSelectedInstance || isPendingWorkshop(mod.workshopId)"
                        @click="updateInstalledMod(mod)"
                      >
                        重新下载
                      </NButton>
                      <NButton
                        v-if="mod.installStatus === 'ready' && hasPermission('mod:config')"
                        class="flex-1"
                        :disabled="!hasSelectedInstance || isPendingWorkshop(mod.workshopId)"
                        @click="openModConfig(mod)"
                      >
                        配置
                      </NButton>
                      <NButton
                        class="flex-1"
                        :loading="unsubscribingWorkshopIds.has(mod.workshopId)"
                        :disabled="!hasSelectedInstance || mod.installStatus === 'pending' || isPendingWorkshop(mod.workshopId)"
                        @click="handleSubscribedAction(mod)"
                        v-if="hasPermission('mod:install')"
                      >
                        {{ mod.installStatus === 'failed' ? '重试' : '取消订阅' }}
                      </NButton>
                      <NButton :disabled="!hasSelectedInstance" @click="goToModDetail(mod.workshopId)">
                        详情
                      </NButton>
                    </div>
                    <div v-if="installedMods.length > 1 && hasPermission('mod:toggle')" class="flex items-center justify-end gap-2">
                      <span class="text-xs text-muted-foreground">加载顺序</span>
                      <NButton
                        size="small"
                        secondary
                        :disabled="!canMoveInstalledMod(mod, modIndex, -1)"
                        @click="moveInstalledMod(modIndex, -1)"
                      >
                        上移
                      </NButton>
                      <NButton
                        size="small"
                        secondary
                        :disabled="!canMoveInstalledMod(mod, modIndex, 1)"
                        @click="moveInstalledMod(modIndex, 1)"
                      >
                        下移
                      </NButton>
                    </div>
                  </article>
                </div>
              </div>
            </NTabPane>
          </NTabs>
        </div>
      </NCard>

      <ModConfigModal
        v-model:show="configModalShow"
        :instance-id="selectedInstanceId"
        :workshop-id="configTarget?.workshopId ?? ''"
        :mod-name="configTarget?.name ?? ''"
        @saved="onModConfigSaved"
      />
    </FaPageMain>
  </div>
</template>

<style scoped>
.dst-mod-page :deep(.group\/pagemain) {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

/*
 * FaPageMain 的内容区默认是 p-5，移动端这里要还一部分给列表。
 * 用 !important 是因为 p-5 由 UnoCSS 生成，注入顺序不保证在 scoped 样式之后。
 */
.dst-mod-main {
  padding: 0.75rem !important;
}

@media (min-width: 768px) {
  .dst-mod-main {
    padding: 1.25rem !important;
  }
}

/*
 * 表格所在卡片的兜底高度：矮屏下工具栏会换行、卡片被 flex 压扁，
 * 表格只剩表头甚至完全不可见。给一个下限后内容区改为滚动，
 * 表格始终保有约 300px 可用高度（表头 + 分页 + 4~5 行）。
 */
.dst-mod-workshop-card {
  min-height: 480px;
}

/* 列表默认（桌面表格模式）不参与高度分配，由表格自己 flex-height */
.dst-mod-market-list {
  min-height: 0;
}

/*
 * 移动端的列表高度。
 *
 * 移动端这里渲染的是卡片列表而不是表格，工具区（搜索框 + 排序/时间范围两个下拉）
 * 竖排堆叠后要吃掉 300px 以上，而卡片的兜底高度只有 480px，留给列表的不到 200px，
 * 只够看一张卡片，翻起来非常难受。
 *
 * 所以移动端把卡片下限抬高、并给列表一个明确的最小高度：列表内容超出时在框内滚动，
 * 浏览时整块区域都用来显示 Mod；配合下面压缩掉的页面内边距与移动端隐藏的说明段落，
 * 实际可用高度比之前多出约 200px。
 */
@media (max-width: 1023px) {
  .dst-mod-workshop-card {
    min-height: 640px;
  }

  .dst-mod-market-list {
    /* 约 2.5 张卡片，滚动时列表本身占满大部分可视区域 */
    min-height: 420px;
  }
}

.dst-mod-workshop-card :deep(.n-card-header) {
  flex-shrink: 0;
}

.dst-mod-tabs :deep(.n-tabs) {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.dst-mod-tabs :deep(.n-tabs-nav) {
  flex-shrink: 0;
}

.dst-mod-tabs :deep(.n-tabs-pane-wrapper) {
  flex: 1;
  min-height: 0;
}

.dst-mod-tabs :deep(.n-tab-pane) {
  height: 100%;
}

.dst-mod-table :deep(.n-data-table-base-table-body) {
  position: relative;
  flex: 1;
  min-height: 0;
}

/*
 * 表格设置了 scroll-x 时，naive-ui 会给空态节点加内联样式 position: sticky，
 * 内联优先级高于选择器，会让这里的 absolute 失效、空态贴在表格顶部。
 * 因此必须用 !important 覆盖，空态才能铺满表格区域并垂直居中。
 */
.dst-mod-table :deep(.n-data-table-empty) {
  position: absolute !important;
  inset: 0 !important;
  width: auto !important;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}

.dst-mod-table-empty {
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
