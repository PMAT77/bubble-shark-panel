import { z } from 'zod'
import { instanceIdSchema } from './instance'

export type ModInstanceStatus = 'pending_install' | 'running' | 'stopped' | 'installing' | 'error'

export type ModInstallStatus = 'pending' | 'ready' | 'failed'

export const modImportSingleCommitSchema = z.object({
  importId: z.string().uuid(),
  workshopId: z.string().regex(/^[1-9]\d{0,19}$/),
  overwrite: z.boolean().default(false),
}).strict()
export const modImportBatchCommitSchema = z.object({
  importId: z.string().uuid(),
  items: z.array(z.object({ itemId: z.string().uuid(), workshopId: z.string().regex(/^[1-9]\d{0,19}$/) }).strict()).min(1),
  overwrite: z.boolean().default(false),
}).strict()
export const modImportCommitSchema = z.union([modImportSingleCommitSchema, modImportBatchCommitSchema])
export type ModImportCommit = z.infer<typeof modImportCommitSchema>
export type ModImportSingleCommit = z.infer<typeof modImportSingleCommitSchema>
export type ModImportBatchCommit = z.infer<typeof modImportBatchCommitSchema>
export interface ModImportItemInspection {
  itemId: string
  directory: string
  workshopId: string | null
  idCandidates: Array<{ workshopId: string, source: 'directory' | 'filename' }>
  name: string | null
  version: string | null
  fileCount: number
  sizeBytes: number
  warnings: string[]
  existing: boolean
}
export interface ModImportInspection extends Omit<ModImportItemInspection, 'itemId' | 'directory'> {
  importId: string
  items: ModImportItemInspection[]
  reservedWorkshopIds: string[]
}
export interface ModImportItemResult {
  itemId: string
  workshopId: string
  status: 'installed' | 'failed' | 'not_processed'
  error: string | null
}
export interface ModImportBatchResult {
  saved: boolean
  riskTip: string | null
  results: ModImportItemResult[]
  mods: ModItemDto[]
  summary: { installed: number, failed: number, remaining: number }
  retryBlocked: boolean
  error: string | null
}

/**
 * Mod 版本状态（面板不显示「版本号」，只回答「是不是工坊上的最新版」）：
 * - outdated：工坊上的最新版本时间晚于本机内容 → 需要更新
 * - up_to_date：两侧时间一致
 * - unknown：缺一侧信息（从未检查、本机清单缺失、工坊上找不到该 Mod）→ 不能判定
 */
export type ModUpdateStatus = 'outdated' | 'up_to_date' | 'unknown'

export interface ModItemDto {
  id: string
  workshopId: string
  name: string
  previewImage: string | null
  /** Steam 评价 0–5 星；无数据时为 null */
  rating: number | null
  enabled: boolean
  loadOrder: number
  version: string | null
  contentSource?: 'steam' | 'local' | 'migration'
  installStatus: ModInstallStatus
  installError: string | null
  /** 本机已下载内容对应的工坊版本时间（ISO）；未知为 null */
  localUpdatedAt: string | null
  /** 工坊上的最新版本时间（ISO）；未知为 null */
  remoteUpdatedAt: string | null
  /** 最近一次版本检查时间（ISO）；从未检查为 null */
  updateCheckedAt: string | null
  updateStatus: ModUpdateStatus
  dependencyIds: string[]
  missingDependencyIds: string[]
  dependentModIds: string[]
  createdAt: string
  updatedAt: string
}

export interface ModListDto {
  instanceId: string
  instanceName: string
  instanceStatus: ModInstanceStatus
  riskTip: string | null
  mods: ModItemDto[]
  /** 内存中仍在进行的下载任务（含 phase） */
  activeInstallJobs: ModInstallJobDto[]
}

export interface ModInstallPayload {
  workshopId: string
  name?: string
  previewImage?: string
  version?: string
  enabled?: boolean
  dependencyIds?: string[]
  /** 为 true 时忽略已就绪状态，强制重新下载（用于更新已订阅 Mod） */
  force?: boolean
}

export interface ModUpdatePayload {
  enabled?: boolean
  name?: string
  version?: string
  dependencyIds?: string[]
}

export interface ModReorderPayload {
  workshopIds: string[]
}

export interface ModMutationResult {
  saved: true
  riskTip: string | null
  mod: ModItemDto
}

export type ModInstallJobStatus = 'downloading' | 'success' | 'failed' | 'not_found'

export type ModInstallJobPhase = 'waiting_steamcmd' | 'downloading'

export interface ModInstallJobDto {
  instanceId: string
  workshopId: string
  status: ModInstallJobStatus
  phase: ModInstallJobPhase | null
  error: string | null
  startedAt: string | null
  finishedAt: string | null
  mod?: ModItemDto
}

/**
 * 实例级 Mod 下载队列状态。
 *
 * 一个实例只有一条队列、一个 Queue Manager 负责选批：前端只轮询这一个接口，
 * 不再为每个 Mod 各起一个轮询。
 */
export type ModDownloadQueueStatus = 'idle' | 'running' | 'pausing' | 'paused'

export const modDownloadQueueStartSchema = z.object({ retryFailed: z.boolean().default(true) })
export type ModDownloadItemPhase = ModInstallJobPhase | 'queued' | 'retry_wait' | 'ready' | 'failed' | 'inactive'
export interface ModDownloadQueueItemDto {
  workshopId: string
  installStatus: ModInstallStatus
  phase: ModDownloadItemPhase
  error: string | null
  nextRetryAt: string | null
}

export interface ModDownloadQueueDto {
  instanceId: string
  status: ModDownloadQueueStatus
  phase: ModInstallJobPhase | 'retry_wait' | null
  items: ModDownloadQueueItemDto[]
  eligibleCount: number
  inactiveMissingCount: number
  retryableFailedCount: number
  /** 本次队列的目标总数（未开始时 = 当前可下载候选数） */
  total: number
  /** 尚未处理（含等待退避的） */
  queued: number
  /** 当前批次内正在下载的 Mod 数 */
  downloading: number
  /** 本次队列已成功数 */
  success: number
  /** 本次队列已失败数（退避用尽） */
  failed: number
  /** 当前批次里的 Mod（批内是多个，故不用单数） */
  currentWorkshopIds: string[]
  /** 队列里还没处理的 Mod（去重后） */
  queueWorkshopIds: string[]
  /** 单批上限 */
  batchSize: number
  /** 当前批次序号（从 1 开始；未开始为 0） */
  currentBatchIndex: number
  /** 退避等待中的下次可尝试时间（ISO）；无等待为 null */
  nextBatchAt: string | null
  startedAt: string | null
  updatedAt: string | null
  lastError: string | null
  /** 选批时跳过或需要注意的项（例如被禁用的依赖） */
  warnings: string[]
}

export interface ModReorderResult {
  saved: true
  riskTip: string | null
  mods: ModItemDto[]
}

/** 本机版本时间的来源：SteamCMD 清单里的 timeupdated / 内容文件的落地时间 */
export type ModUpdateLocalVersionSource = 'workshop-manifest' | 'content-mtime' | 'migration-manifest'

/** 单个 Mod 的版本检查结果 */
export interface ModUpdateInfo {
  workshopId: string
  /** 工坊标题；取不到时为 null（调用方用它回填面板里的名字） */
  title: string | null
  updateStatus: ModUpdateStatus
  localUpdatedAt: string | null
  remoteUpdatedAt: string | null
  /** 上面那个本机版本时间的来源；null 表示本次没取到任何内容凭据（对应「无法判定」） */
  localVersionSource: ModUpdateLocalVersionSource | null
  /** 无法判定时的原因；可判定时为 null */
  reason: string | null
}

export interface ModUpdateCheckSummary {
  total: number
  outdated: number
  upToDate: number
  unknown: number
}

export interface ModUpdateCheckResult {
  instanceId: string
  checkedAt: string
  /** 工坊元数据是否全部取到；false 表示有批次失败，结果按已取到的部分计算 */
  upstreamOk: boolean
  /** upstreamOk 为 false 时的提示 */
  message: string | null
  summary: ModUpdateCheckSummary
  items: ModUpdateInfo[]
}

export interface ModDeleteResult {
  deleted: true
  riskTip: string | null
}

export interface ModConfigOption {
  description: string
  data: string | number | boolean
}

/** modinfo.lua 中单个配置项定义 */
export interface ModConfigDefinition {
  name: string
  /** 分组标题，仅展示，不写入配置 */
  isHeader?: boolean
  label: string | null
  hover: string | null
  options: ModConfigOption[]
  default: string | number | boolean | null
}

export type ModConfigValues = Record<string, string | number | boolean>

export type ModConfigDefinitionStatus = 'parsed' | 'empty' | 'missing_file' | 'parse_failed' | 'timeout' | 'limit_exceeded'

export interface ModConfigDefinitionResult {
  definitions: ModConfigDefinition[]
  definitionStatus: ModConfigDefinitionStatus
  /** 面向用户的读取说明，不含文件路径或第三方异常原文 */
  definitionMessage: string | null
}

export interface ModConfigDto extends ModConfigDefinitionResult {
  instanceId: string
  workshopId: string
  /** 当前生效配置值：DB 优先，为空时从现有 modoverrides.lua 导入预填 */
  options: ModConfigValues
}

export interface ModConfigSaveResult {
  saved: true
  riskTip: string | null
}

export interface SteamModListQueryResultItem {
  workshopId: string
  title: string
  previewImage: string | null
  detailUrl: string
  /** Steam 评价 0–5 星；无数据时为 null */
  rating: number | null
  /** 实例内存在订阅记录（含 pending/failed/ready） */
  subscribed: boolean
  /** 未订阅时为 null */
  subscribeStatus: ModInstallStatus | null
  /** 文件已就绪（installStatus=ready）；与 subscribeStatus 区分 */
  installed: boolean
  /** 已发起订阅但文件尚未就绪（DB pending 或 job downloading） */
  pendingDownload: boolean
}

export const MOD_CONTENT_LOCALES = ['zh-CN', 'en-US'] as const
export type ModContentLocale = (typeof MOD_CONTENT_LOCALES)[number]
export const DEFAULT_MOD_CONTENT_LOCALE: ModContentLocale = 'zh-CN'
export type ModLocalizedTextMap = Partial<Record<ModContentLocale, string>>

export function resolveModLocalizedText(
  map: ModLocalizedTextMap,
  preferredLocale: ModContentLocale,
): { value: string, contentLocale: ModContentLocale } {
  const fallbackLocale: ModContentLocale = preferredLocale === 'zh-CN' ? 'en-US' : 'zh-CN'
  const order: ModContentLocale[] = [preferredLocale, fallbackLocale]
  for (const locale of order) {
    const value = map[locale]?.trim()
    if (value) {
      return { value, contentLocale: locale }
    }
  }
  for (const locale of MOD_CONTENT_LOCALES) {
    const value = map[locale]?.trim()
    if (value) {
      return { value, contentLocale: locale }
    }
  }
  return { value: '', contentLocale: preferredLocale }
}

export interface SteamModDetailDto {
  cache?: { source: 'live' | 'cache-fresh' | 'cache-offline', fetchedAt: string }
  workshopId: string
  /** 当前 locale 下解析后的展示标题 */
  title: string
  /** 当前 locale 下解析后的展示描述 */
  description: string
  /** 实际用于解析 title/description 的 locale */
  contentLocale: ModContentLocale
  /** 多语言标题，供 i18n 切换 */
  titles: ModLocalizedTextMap
  /** 多语言描述，供 i18n 切换 */
  descriptions: ModLocalizedTextMap
  previewImage: string | null
  /** 字节数；未知时为 null */
  fileSize: number | null
  tags: string[]
  /** ISO8601；未知时为 null */
  publishedAt: string | null
  /** ISO8601；未知时为 null */
  updatedAt: string | null
  detailUrl: string
  /** 实例内存在订阅记录（含 pending/failed/ready） */
  subscribed: boolean
  /** 未订阅时为 null */
  subscribeStatus: ModInstallStatus | null
  /** 文件已就绪（installStatus=ready） */
  installed: boolean
  /** 创作者显示名；无法解析时为 null */
  creatorName: string | null
}

export type SteamModSort = 'trend' | 'mostrecent' | 'relevance' | 'totaluniquesubscribers'

export interface ModAccessObservation {
  status: 'success' | 'failed' | 'cancelled' | 'unknown'
  observedAt: string | null
  message: string | null
  cached?: boolean
  fetchedAt?: string | null
}
export interface ModAccessStatusDto {
  market: ModAccessObservation
  metadata: ModAccessObservation
  files: ModAccessObservation
  configuration: {
    httpProxyConfigured: boolean
    steamcmdProxyConfigured: boolean
    relayListsOnly: boolean
    webApiConfigured: boolean
    runtime: 'docker' | 'native'
    networkMode: 'bridge' | 'host'
  }
}

/** 仅在 sort=trend（最热门）时生效 */
export type SteamModTrendDays = 1 | 7 | 30 | 90 | 180 | 365 | -1

export interface SteamModListQueryResult {
  keyword: string
  page: number
  pageSize: number
  sort: SteamModSort
  trendDays: SteamModTrendDays
  hasMore: boolean
  /** 上游返回的总条数；未知时为 null */
  totalCount: number | null
  /** 上游返回的总页数；未知时为 null */
  totalPages: number | null
  sourceUrl: string
  meta: SteamModListMeta
  items: SteamModListQueryResultItem[]
  /** 当前实例正在下载中的 Workshop ID */
  pendingWorkshopIds: string[]
}

export type SteamModFetchSource = 'live' | 'cache-fresh' | 'cache-stale'
export type SteamModUpstreamSource = 'official' | 'relay' | 'html'

export type SteamModFetchErrorCode =
  | 'STEAM_TIMEOUT'
  | 'STEAM_RATE_LIMIT'
  | 'STEAM_PARSE_FAILED'
  | 'STEAM_UPSTREAM_UNAVAILABLE'

export interface SteamModListMeta {
  cached: boolean
  stale: boolean
  cacheAgeMs: number
  source: SteamModFetchSource
  upstreamSource: SteamModUpstreamSource
  lastSuccessSource?: SteamModUpstreamSource
  lastSuccessAt?: string
  retryAfterMs?: number
  fetchTraceId: string
  /** live 拉取失败且无缓存时的降级标记 */
  upstreamUnavailable?: boolean
  /** 降级时的友好提示，供前端 inline 展示 */
  upstreamMessage?: string
  steamErrorCode?: SteamModFetchErrorCode
  /**
   * 命中的是离线兜底数据：上游不可达，内容来自最后一次成功拉取。
   *
   * 与 `stale` 的区别是「还能不能刷新」——stale 只说明内容不新鲜但后台正在刷新，
   * offline 说明上游根本连不上，列表只能停在这个版本。前端据此提示用户。
   */
  offline?: boolean
  /** 离线数据的最后成功拉取时间（ISO）；配合 offline 展示「最后更新于」 */
  dataFetchedAt?: string
}

const workshopIdSchema = z.string().trim().min(1).max(64)
const optionalTextSchema = z.string().trim().max(512).optional()

export const modInstanceParamsSchema = z.object({
  instanceId: instanceIdSchema,
})
export type ModInstanceParams = z.infer<typeof modInstanceParamsSchema>

export const modItemParamsSchema = modInstanceParamsSchema.extend({
  modId: workshopIdSchema,
})
export type ModItemParams = z.infer<typeof modItemParamsSchema>

export const modWorkshopParamsSchema = modInstanceParamsSchema.extend({
  workshopId: workshopIdSchema,
})
export type ModWorkshopParams = z.infer<typeof modWorkshopParamsSchema>

export const modListQuerySchema = z.object({
  enrich: z.string().trim().max(128).optional(),
})
export type ModListQuery = z.infer<typeof modListQuerySchema>

const queryNumberSchema = z.union([z.string().trim().max(16), z.number().finite()]).optional()

export const steamModListQuerySchema = z.object({
  keyword: z.string().trim().max(256).optional(),
  page: queryNumberSchema,
  pageSize: queryNumberSchema,
  sort: z.string().trim().max(64).optional(),
  trendDays: queryNumberSchema,
})
export type SteamModListQuery = z.infer<typeof steamModListQuerySchema>

export const steamModDetailQuerySchema = z.object({
  locale: z.string().trim().max(16).optional(),
})
export type SteamModDetailQuery = z.infer<typeof steamModDetailQuerySchema>

export const modInstallPayloadSchema = z.object({
  workshopId: workshopIdSchema,
  name: optionalTextSchema,
  previewImage: z.string().trim().max(2048).optional(),
  version: optionalTextSchema,
  enabled: z.boolean().optional(),
  dependencyIds: z.array(workshopIdSchema).max(128).optional(),
  /** 为 true 时忽略已就绪状态，强制重新下载（用于更新已订阅 Mod） */
  force: z.boolean().optional(),
})

export const modUpdatePayloadSchema = z.object({
  enabled: z.boolean().optional(),
  name: optionalTextSchema,
  version: optionalTextSchema,
  dependencyIds: z.array(workshopIdSchema).max(128).optional(),
})

export const modReorderPayloadSchema = z.object({
  workshopIds: z.array(workshopIdSchema).max(512),
})

export const modBatchUpdatePayloadSchema = z.object({
  workshopIds: z.array(workshopIdSchema).min(1).max(512),
})
export type ModBatchUpdatePayload = z.infer<typeof modBatchUpdatePayloadSchema>

export const modUpdateCheckPayloadSchema = z.object({
  /** 为 true 时忽略缓存与上次检查时间，强制重新问一次 Steam */
  force: z.boolean().optional(),
})
export type ModUpdateCheckPayload = z.infer<typeof modUpdateCheckPayloadSchema>

export const modConfigPayloadSchema = z.object({
  options: z.record(
    z.string().trim().min(1).max(128),
    z.union([z.string().max(4096), z.number().finite(), z.boolean()]),
  ).refine(options => Object.keys(options).length <= 256, '配置项数量超出上限'),
})
export type ModConfigPayload = z.infer<typeof modConfigPayloadSchema>

export const modInstallJobsQuerySchema = z.object({
  workshopIds: z.union([
    z.string().trim().max(16_384),
    z.array(workshopIdSchema).max(512),
  ]).optional(),
})
