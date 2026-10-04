import { registerModImportRoutes } from './mod-import-routes'
import { getModAccessStatus } from './mod-access-service'
import { hasContentRecoveryFailure } from '../../shared/instance-content/operation'
import fs from 'node:fs'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ApiErrorResponse, ApiSuccessResponse } from '../../../../shared/contracts/api'
import type {
  ModConfigDto,
  ModConfigSaveResult,
  ModDeleteResult,
  ModDownloadQueueDto,
  ModInstallJobDto,
  ModInstallPayload,
  ModInstallStatus,
  ModItemDto,
  ModListDto,
  ModMutationResult,
  ModReorderResult,
  ModUpdateCheckResult,
  SteamModSort,
  SteamModTrendDays,
  SteamModListQueryResult,
  SteamModDetailDto,
  ModContentLocale,
} from '../../../../shared/contracts/mod'
import {
  DEFAULT_MOD_CONTENT_LOCALE,
  modInstanceParamsSchema,
  modItemParamsSchema,
  modWorkshopParamsSchema,
  modListQuerySchema,
  steamModListQuerySchema,
  steamModDetailQuerySchema,
  modInstallPayloadSchema,
  modUpdatePayloadSchema,
  modReorderPayloadSchema,
  modBatchUpdatePayloadSchema,
  modUpdateCheckPayloadSchema,
  modConfigPayloadSchema,
  modInstallJobsQuerySchema,
  modDownloadQueueStartSchema,
} from '../../../../shared/contracts/mod'
import { DST_APP_ID } from '../../infra/game-adapter/dst/constants'
import { resolveInstanceInstallPath } from '../../infra/game-adapter/dst/cluster-service'
import {
  parseModInfoConfigurations,
  parseModOverridesConfigurations,
  parseStoredModConfig,
} from '../../infra/game-adapter/dst/mod-config'
import {
  readModDependencyMap,
  writeModDependencyMap,
} from '../../infra/game-adapter/dst/mod-service'
import { isWorldSeedModId } from '../../infra/game-adapter/dst/world-seed'
import { removeDstLegacyModLinks } from '../../infra/game-adapter/dst/ugc-mod-install'
import { LOCAL_NODE_ID, resolveLocalDstInstance } from '../../shared/dst/local-dst-instance'
import type { ModReadinessResult } from './mod-readiness-service'
import { reconcileInstanceModReadiness } from './mod-readiness-service'
import { checkInstanceModUpdates, resolveStoredModUpdateStatus, scheduleModUpdateChecks } from './mod-update-service'
import { syncInstanceModFilesFromDb } from './mod-file-sync-service'
import { fetchDstSteamWorkshopMods, fetchWorkshopFileDetail, fetchWorkshopPreviewImages, fetchWorkshopRatings, isSteamWorkshopFetchError, scheduleWarmSteamWorkshopModCache } from '../../infra/game-adapter/dst/steam-workshop'
import {
  deleteInstanceModByWorkshopId,
  getGameInstanceById,
  getInstanceModByWorkshopId,
  listGameInstances,
  listInstanceMods,
  updateInstanceModByWorkshopId,
} from '../../shared/db/index'
import { businessError, success } from '../../shared/http/response'
import type { PermissionKey } from '../../../../shared/constants/permissions'
import { authorizeInstance } from '../system/auth'
import {
  cancelModDownloadQueue,
  enqueueModDownload,
  enqueueModDownloads,
  getModDownloadQueueSnapshot,
  isModDownloadAutoStartEnabled,
  listModInstallJobs,
  pauseModDownloadQueue,
  resolveModDownloadQueueState,
  resolveModInstallJob,
  startModDownloadQueue,
} from './mod-download-service'

function normalizeWorkshopId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 单次 Mod 列表请求补缩略图的上限（见 enrichMissingModPreviewImages） */
const PREVIEW_ENRICH_LIMIT = 12

function normalizeDependencyIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const unique = new Set<string>()
  for (const item of value) {
    const workshopId = normalizeWorkshopId(item)
    if (workshopId) {
      unique.add(workshopId)
    }
  }
  return [...unique]
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed
    }
  }
  return fallback
}

function normalizeSteamSort(value: unknown): SteamModSort {
  if (value === 'mostrecent' || value === 'totaluniquesubscribers' || value === 'relevance') {
    return value
  }
  return 'trend'
}

function normalizeModContentLocale(value: unknown): ModContentLocale {
  if (value === 'en-US' || value === 'en') {
    return 'en-US'
  }
  return DEFAULT_MOD_CONTENT_LOCALE
}

function normalizeTrendDays(value: unknown): SteamModTrendDays {
  const accepted: SteamModTrendDays[] = [1, 7, 30, 90, 180, 365, -1]
  if (typeof value === 'number' && accepted.includes(value as SteamModTrendDays)) {
    return value as SteamModTrendDays
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (accepted.includes(parsed as SteamModTrendDays)) {
      return parsed as SteamModTrendDays
    }
  }
  return 7
}

function parseModListEnrich(value: unknown): { enrichRatings: boolean, enrichPreviews: boolean } {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) {
    return { enrichRatings: false, enrichPreviews: false }
  }
  const parts = raw.split(',').map(part => part.trim())
  return {
    enrichRatings: parts.includes('ratings'),
    enrichPreviews: parts.includes('previews'),
  }
}

function buildSubscribedModStatusMap(
  mods: Awaited<ReturnType<typeof listInstanceMods>>,
): Map<string, ModInstallStatus> {
  return new Map(mods.map(mod => [mod.workshopId, mod.installStatus]))
}

function normalizeSteamWorkshopError(error: unknown): {
  message: string
  data: Record<string, unknown>
} {
  if (isSteamWorkshopFetchError(error)) {
    if (error.code === 'STEAM_TIMEOUT') {
      return {
        message: '拉取 Steam 超时，请检查网络后重试',
        data: {
          steamErrorCode: error.code,
        },
      }
    }
    if (error.code === 'STEAM_RATE_LIMIT') {
      return {
        message: 'Steam 请求频率过高，请稍后重试',
        data: {
          steamErrorCode: error.code,
          retryAfterMs: error.retryAfterMs ?? undefined,
        },
      }
    }
    if (error.code === 'STEAM_PARSE_FAILED') {
      return {
        message: 'Steam 页面结构变化导致解析失败，请稍后重试',
        data: {
          steamErrorCode: error.code,
        },
      }
    }
    return {
      message: '无法连接 Steam 创意工坊，请检查服务器网络或代理设置后重试',
      data: {
        steamErrorCode: error.code,
        retryAfterMs: error.retryAfterMs ?? undefined,
      },
    }
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.message.includes('fetch failed')) {
      return {
        message: '无法连接 Steam 创意工坊，请检查服务器网络或代理设置后重试',
        data: {},
      }
    }
    const technicalPatterns = [
      /^Command failed:/i,
      /powershell/i,
      /ParserError/i,
      /CategoryInfo/i,
      /FullyQualifiedErrorId/i,
      /At line:\d+/i,
    ]
    const message = error.message.trim()
    if (!message || technicalPatterns.some(pattern => pattern.test(message))) {
      return {
        message: '无法连接 Steam 创意工坊，请检查服务器网络或代理设置后重试',
        data: {},
      }
    }
    return {
      message,
      data: {},
    }
  }
  return {
    message: '拉取 Steam 创意工坊模组失败',
    data: {},
  }
}

function getRuntimeRiskTip(instanceStatus: ModListDto['instanceStatus']): string | null {
  if (instanceStatus !== 'running') {
    return null
  }
  return '实例运行中修改 Mod 可能导致玩家同步失败，建议在停服窗口执行并重启实例。'
}

/** 明显不是 Mod 名字的脏值：展示时一律回落为 workshop-<id>，真实名称由「检查更新」按工坊标题补回 */
const UNRESOLVED_MOD_NAME_PATTERN = /^(null|undefined|nil|nan|false|true)$/i

function resolveDisplayModName(name: string | null | undefined, workshopId: string): string {
  const trimmed = name?.trim() ?? ''
  if (!trimmed || UNRESOLVED_MOD_NAME_PATTERN.test(trimmed)) {
    return `workshop-${workshopId}`
  }
  return trimmed
}

function toDto(
  mod: Awaited<ReturnType<typeof listInstanceMods>>[number],
  dependencyMap: Record<string, string[]>,
  installedIds: Set<string>,
  ratingMap: Map<string, number | null>,
): ModItemDto {
  const dependencyIds = dependencyMap[mod.workshopId] ?? []
  const missingDependencyIds = dependencyIds.filter(id => !installedIds.has(id))
  const dependentModIds = Object.entries(dependencyMap)
    .filter(([workshopId, dependencies]) => workshopId !== mod.workshopId && dependencies.includes(mod.workshopId))
    .map(([workshopId]) => workshopId)
  return {
    id: mod.id,
    workshopId: mod.workshopId,
    name: resolveDisplayModName(mod.name, mod.workshopId),
    previewImage: mod.previewImage,
    rating: ratingMap.get(mod.workshopId) ?? null,
    enabled: mod.enabled,
    loadOrder: mod.loadOrder,
    version: mod.version,
    contentSource: mod.contentSource,
    installStatus: mod.installStatus,
    installError: mod.installError,
    localUpdatedAt: mod.localUpdatedAt,
    remoteUpdatedAt: mod.remoteUpdatedAt,
    updateCheckedAt: mod.updateCheckedAt,
    updateStatus: resolveStoredModUpdateStatus(mod),
    dependencyIds,
    missingDependencyIds,
    dependentModIds,
    createdAt: mod.createdAt,
    updatedAt: mod.updatedAt,
  }
}

function buildActiveInstallJobs(
  instanceId: string,
  mods: Awaited<ReturnType<typeof listInstanceMods>>,
): ModInstallJobDto[] {
  const memoryJobs = listModInstallJobs(instanceId)
  const queue = getModDownloadQueueSnapshot(instanceId)
  const queueRunning = queue?.status === 'running' || queue?.status === 'pausing'
  if (!queueRunning || !queue) {
    // 队列没在跑就不再伪造「下载中」：迁移包导入后 pending 会挂很久，
    // 合成任务会让用户以为一直在下载，而实际等待的是「开始下载」这一步
    return memoryJobs
  }
  const trackedIds = new Set(memoryJobs.map(job => job.workshopId))
  const queueIds = new Set([...queue.currentWorkshopIds, ...queue.queueWorkshopIds])
  const syntheticJobs: ModInstallJobDto[] = []
  for (const mod of mods) {
    if (mod.installStatus !== 'pending' || trackedIds.has(mod.workshopId)) {
      continue
    }
    if (!queueIds.has(mod.workshopId)) {
      continue
    }
    syntheticJobs.push({
      instanceId,
      workshopId: mod.workshopId,
      status: 'downloading',
      phase: null,
      error: null,
      startedAt: mod.updatedAt,
      finishedAt: null,
    })
  }
  return [...memoryJobs, ...syntheticJobs]
}

function collectPendingWorkshopIds(
  instanceId: string,
  mods: Awaited<ReturnType<typeof listInstanceMods>>,
): Set<string> {
  const pending = new Set(
    mods.filter(mod => mod.installStatus === 'pending').map(mod => mod.workshopId),
  )
  for (const job of listModInstallJobs(instanceId)) {
    if (job.status === 'downloading') {
      pending.add(job.workshopId)
    }
  }
  return pending
}

async function enrichMissingModPreviewImages(instanceId: string, mods: Awaited<ReturnType<typeof listInstanceMods>>) {
  // 单次列表请求最多补这么多个缩略图：迁移包导入后可能几十个 Mod 都没图，
  // 一次全问上游会把列表接口拖到超时，缺的留给后续刷新分批补
  const missingIds = mods
    .filter(mod => !mod.previewImage?.trim())
    .map(mod => mod.workshopId)
    .slice(0, PREVIEW_ENRICH_LIMIT)
  if (missingIds.length === 0) {
    return
  }
  const previewMap = await fetchWorkshopPreviewImages(missingIds)
  await Promise.all(missingIds.map(async (workshopId) => {
    const previewImage = previewMap.get(workshopId)
    if (!previewImage) {
      return
    }
    await updateInstanceModByWorkshopId(instanceId, workshopId, { previewImage })
  }))
}

async function buildModListPayload(
  instanceId: string,
  options?: { enrichRatings?: boolean, enrichPreviews?: boolean },
): Promise<ModListDto> {
  const instance = await getGameInstanceById(instanceId)
  if (!instance) {
    throw new Error('实例不存在')
  }
  const installPath = resolveInstanceInstallPath(instance)
  let mods = await listInstanceMods(instanceId)
  if (options?.enrichPreviews) {
    await enrichMissingModPreviewImages(instanceId, mods)
    mods = await listInstanceMods(instanceId)
  }
  const dependencyMap = readModDependencyMap(installPath)
  const installedIds = new Set(
    mods.filter(item => item.installStatus === 'ready').map(item => item.workshopId),
  )
  const ratingMap = options?.enrichRatings
    ? await fetchWorkshopRatings(mods.map(item => item.workshopId))
    : new Map<string, number | null>(mods.map(item => [item.workshopId, null]))
  return {
    instanceId,
    instanceName: instance.name,
    instanceStatus: instance.status,
    riskTip: getRuntimeRiskTip(instance.status),
    mods: mods.map(item => toDto(item, dependencyMap, installedIds, ratingMap)),
    activeInstallJobs: buildActiveInstallJobs(instanceId, mods),
  }
}

async function buildLightweightModDto(instanceId: string, workshopId: string): Promise<ModItemDto | null> {
  const mod = await getInstanceModByWorkshopId(instanceId, workshopId)
  if (!mod) {
    return null
  }
  const instance = await getGameInstanceById(instanceId)
  if (!instance) {
    return null
  }
  const installPath = resolveInstanceInstallPath(instance)
  const dependencyMap = readModDependencyMap(installPath)
  const readyMods = await listInstanceMods(instanceId)
  const installedIds = new Set(
    readyMods.filter(item => item.installStatus === 'ready').map(item => item.workshopId),
  )
  return toDto(mod, dependencyMap, installedIds, new Map([[mod.workshopId, null]]))
}

async function enrichInstallJobDto(instanceId: string, job: ModInstallJobDto): Promise<ModInstallJobDto> {
  if (job.status !== 'success') {
    return job
  }
  const mod = await buildLightweightModDto(instanceId, job.workshopId)
  return mod ? { ...job, mod } : job
}

function normalizeLoadOrder(mods: Awaited<ReturnType<typeof listInstanceMods>>) {
  return mods
    .sort((a, b) => a.loadOrder - b.loadOrder || a.createdAt.localeCompare(b.createdAt))
    .map((mod, index) => ({ ...mod, loadOrder: index }))
}

/** 把一次状态校准的结果落到日志，便于排查「面板说就绪、游戏里没有」 */
function logModReadinessResult(app: FastifyInstance, instanceId: string, result: ModReadinessResult) {
  if (result.demotedToPending.length > 0) {
    app.log.warn(
      { instanceId, workshopIds: result.demotedToPending },
      'Mod 创意工坊内容缺失，已由「已就绪」降级为等待下载',
    )
  }
  for (const item of result.markedFailed) {
    app.log.warn(
      { instanceId, workshopId: item.workshopId, error: item.error },
      'Mod 文件未能落位到 ugc_mods，DST 启动时无法加载该 Mod',
    )
  }
  if (result.renamed.length > 0) {
    app.log.info({ instanceId, renamed: result.renamed }, '已按 modinfo.lua 补齐 Mod 名称')
  }
}

/**
 * mod 模块注册入口
 * 负责创意工坊安装、启停与排序，并维护 modoverrides.lua。
 */
/**
 * mod 模块的实例级鉴权。
 *
 * 这个模块的实例 ID 走**路径参数**（`/app/instances/:instanceId/mods...`），
 * 所以统一在这里取参数——**不要用正则去切 URL**：`.../mods/install-jobs` 这类
 * 固定段会被误当成实例 ID，那样鉴权就查了一个不存在的实例。
 */
function authorizeModInstance(request: FastifyRequest, permission: PermissionKey) {
  const params = request.params as { instanceId?: string } | undefined
  return authorizeInstance(request, params?.instanceId?.trim() ?? '', permission)
}

export function registerModModule(app: FastifyInstance) {
  registerModImportRoutes(app, buildLightweightModDto)
  app.addHook('onReady', async () => {
    scheduleWarmSteamWorkshopModCache()
    // 版本徽标要保持新鲜：与游戏服务端更新检查同节奏，后台定期问一次创意工坊
    scheduleModUpdateChecks(app)
    const instances = await listGameInstances({ nodeId: LOCAL_NODE_ID })
    for (const instance of instances) {
      if (instance.gameCode !== DST_APP_ID || hasContentRecoveryFailure(instance.id)) {
        continue
      }
      const installPath = resolveInstanceInstallPath(instance)
      if (!fs.existsSync(installPath)) {
        continue
      }
      // 先按磁盘校准状态：缺内容的从「已就绪」降级为等待下载，才能被下载队列接手
      const readiness = await reconcileInstanceModReadiness({
        instanceId: instance.id,
        installPath,
      })
      logModReadinessResult(app, instance.id, readiness)
      // 默认不自动开跑：pending 原样留在库里，用户在 Mod 页点「开始下载」才逐批处理
      if (isModDownloadAutoStartEnabled()) {
        await startModDownloadQueue({
          instanceId: instance.id,
          installPath,
        })
      }
      // 不阻塞面板启动：落位与失败标注在后台补齐（DST 只从 ugc_mods 加载创意工坊 Mod）
      void reconcileInstanceModReadiness({
        instanceId: instance.id,
        installPath,
        relocate: true,
      })
        .then(result => logModReadinessResult(app, instance.id, result))
        .catch((error) => {
          app.log.warn({ instanceId: instance.id, err: error }, 'Mod 状态校准时发生异常')
        })
    }
  })

  app.get('/app/instances/:instanceId/mods', async (request): Promise<ApiSuccessResponse<ModListDto> | ApiErrorResponse> => {
    const authorized = await authorizeModInstance(request, 'mod:read')
    if (authorized.error) {
      return authorized.error
    }
    const parsedParams = modInstanceParamsSchema.safeParse(request.params)
    const parsedQuery = modListQuerySchema.safeParse(request.query)
    if (!parsedParams.success || !parsedQuery.success) {
      return businessError('请求参数无效', request)
    }
    const instanceId = parsedParams.data.instanceId
    const resolved = await resolveLocalDstInstance(instanceId, request, {
      messages: {
        wrongNode: '当前仅支持本地节点实例 Mod 管理',
        wrongGame: '当前仅支持 DST 实例 Mod 管理',
        missingInstallPath: '实例安装目录不存在，请先完成安装',
      },
    })
    if (!resolved.ok) {
      return resolved.error
    }
    try {
      // 列表口径必须与磁盘一致：先把缺内容的记录降级为等待下载；
      // 真正的下载由队列负责，列表接口保持只读（不再顺手入队，避免每次刷新都触发下载风暴）
      const readiness = await reconcileInstanceModReadiness({
        instanceId,
        installPath: resolved.instance.installPath,
      })
      logModReadinessResult(app, instanceId, readiness)
      const enrich = parseModListEnrich(parsedQuery.data.enrich)
      const payload = await buildModListPayload(instanceId, enrich)
      return success(payload, request)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : '读取 Mod 列表失败'
      return businessError(message, request)
    }
  })

  app.get('/app/instances/:instanceId/mods/steam', async (request): Promise<ApiSuccessResponse<SteamModListQueryResult> | ApiErrorResponse> => {
    const authorized = await authorizeModInstance(request, 'mod:read')
    if (authorized.error) {
      return authorized.error
    }
    const parsedParams = modInstanceParamsSchema.safeParse(request.params)
    const parsedQuery = steamModListQuerySchema.safeParse(request.query)
    if (!parsedParams.success || !parsedQuery.success) {
      return businessError('请求参数无效', request)
    }
    const instanceId = parsedParams.data.instanceId
    const resolved = await resolveLocalDstInstance(instanceId, request, {
      messages: {
        wrongNode: '当前仅支持本地节点实例 Mod 管理',
        wrongGame: '当前仅支持 DST 实例 Mod 管理',
        missingInstallPath: '实例安装目录不存在，请先完成安装',
      },
    })
    if (!resolved.ok) {
      return resolved.error
    }
    try {
      const installedMods = await listInstanceMods(instanceId)
      const subscribedModStatusByWorkshopId = buildSubscribedModStatusMap(installedMods)
      const pendingWorkshopIds = collectPendingWorkshopIds(instanceId, installedMods)
      const payload = await fetchDstSteamWorkshopMods({
        keyword: parsedQuery.data.keyword ?? '',
        page: normalizePositiveNumber(parsedQuery.data.page, 1),
        pageSize: normalizePositiveNumber(parsedQuery.data.pageSize, 20),
        sort: normalizeSteamSort(parsedQuery.data.sort),
        trendDays: normalizeTrendDays(parsedQuery.data.trendDays),
        subscribedModStatusByWorkshopId,
        pendingWorkshopIds,
      })
      return success(payload, request)
    }
    catch (error) {
      const normalized = normalizeSteamWorkshopError(error)
      return businessError(normalized.message, request, undefined, normalized.data)
    }
  })

  app.get('/app/instances/:instanceId/mods/steam/:workshopId', async (request): Promise<ApiSuccessResponse<SteamModDetailDto> | ApiErrorResponse> => {
    const authorized = await authorizeModInstance(request, 'mod:read')
    if (authorized.error) {
      return authorized.error
    }
    const parsedParams = modWorkshopParamsSchema.safeParse(request.params)
    const parsedQuery = steamModDetailQuerySchema.safeParse(request.query)
    if (!parsedParams.success || !parsedQuery.success) {
      return businessError('请求参数无效', request)
    }
    const instanceId = parsedParams.data.instanceId
    const workshopId = parsedParams.data.workshopId
    const locale = normalizeModContentLocale(parsedQuery.data.locale)
    if (!workshopId) {
      return businessError('创意工坊 ID 不能为空', request)
    }
    const resolved = await resolveLocalDstInstance(instanceId, request, {
      messages: {
        wrongNode: '当前仅支持本地节点实例 Mod 管理',
        wrongGame: '当前仅支持 DST 实例 Mod 管理',
        missingInstallPath: '实例安装目录不存在，请先完成安装',
      },
    })
    if (!resolved.ok) {
      return resolved.error
    }
    try {
      const installedMods = await listInstanceMods(instanceId)
      const detail = await fetchWorkshopFileDetail(workshopId, locale)
      const modRecord = installedMods.find(mod => mod.workshopId === workshopId)
      const subscribeStatus = modRecord?.installStatus ?? null
      const payload: SteamModDetailDto = {
        ...detail,
        subscribed: subscribeStatus !== null,
        subscribeStatus,
        installed: subscribeStatus === 'ready',
      }
      return success(payload, request)
    }
    catch (error) {
      const normalized = normalizeSteamWorkshopError(error)
      return businessError(normalized.message, request, undefined, normalized.data)
    }
  })

  app.post('/app/instances/:instanceId/mods/check-updates', async (request): Promise<ApiSuccessResponse<ModUpdateCheckResult> | ApiErrorResponse> => {
    const authorized = await authorizeModInstance(request, 'mod:read')
    if (authorized.error) {
      return authorized.error
    }
    const parsedParams = modInstanceParamsSchema.safeParse(request.params)
    const parsedBody = modUpdateCheckPayloadSchema.safeParse(request.body ?? {})
    if (!parsedParams.success || !parsedBody.success) {
      return businessError('请求参数无效', request)
    }
    const instanceId = parsedParams.data.instanceId
    const resolved = await resolveLocalDstInstance(instanceId, request, {
      messages: {
        wrongNode: '当前仅支持本地节点实例 Mod 管理',
        wrongGame: '当前仅支持 DST 实例 Mod 管理',
        missingInstallPath: '实例安装目录不存在，请先完成安装',
      },
    })
    if (!resolved.ok) {
      return resolved.error
    }
    try {
      const outcome = await checkInstanceModUpdates({
        instanceId,
        installPath: resolved.instance.installPath,
        force: parsedBody.data.force === true,
      })
      if (outcome.renamed.length > 0) {
        app.log.info({ instanceId, renamed: outcome.renamed }, '已按创意工坊标题补齐 Mod 名称')
      }
      // Steam 一条都没取到时明确报错，前端据此提示「沿用上次结果」而不是当成「全部最新」
      if (!outcome.upstreamOk && outcome.metadataResolved === 0) {
        return businessError(outcome.message ?? '无法连接 Steam 创意工坊，请检查服务器网络或代理设置后重试', request)
      }
      const { renamed: _renamed, metadataResolved: _metadataResolved, ...result } = outcome
      return success(result, request)
    }
    catch (error) {
      const normalized = normalizeSteamWorkshopError(error)
      return businessError(normalized.message, request, undefined, normalized.data)
    }
  })

  app.post('/app/instances/:instanceId/mods/install', async (request): Promise<ApiSuccessResponse<ModInstallJobDto> | ApiErrorResponse> => {
    const authorized = await authorizeModInstance(request, 'mod:install')
    if (authorized.error) {
      return authorized.error
    }
    const parsedParams = modInstanceParamsSchema.safeParse(request.params)
    const parsedBody = modInstallPayloadSchema.safeParse(request.body ?? {})
    if (!parsedParams.success || !parsedBody.success) {
      return businessError('请求参数无效', request)
    }
    const instanceId = parsedParams.data.instanceId
    const resolved = await resolveLocalDstInstance(instanceId, request, {
      messages: {
        wrongNode: '当前仅支持本地节点实例 Mod 管理',
        wrongGame: '当前仅支持 DST 实例 Mod 管理',
        missingInstallPath: '实例安装目录不存在，请先完成安装',
      },
    })
    if (!resolved.ok) {
      return resolved.error
    }
    const body = parsedBody.data
    const workshopId = normalizeWorkshopId(body.workshopId)
    if (!workshopId) {
      return businessError('创意工坊 ID 不能为空', request)
    }
    // 面板内置的世界种子 Mod 占用了这个 ID：允许订阅会把它的文件与面板落位的内容互相覆盖
    if (isWorldSeedModId(workshopId)) {
      return businessError('该创意工坊 ID 为面板保留，请换一个 Mod', request)
    }
    const job = await enqueueModDownload({
      instanceId,
      installPath: resolved.instance.installPath,
      payload: body,
      force: body.force === true,
    })
    return success(await enrichInstallJobDto(instanceId, job), request)
  })

  app.post('/app/instances/:instanceId/mods/batch-update', async (request): Promise<ApiSuccessResponse<ModInstallJobDto[]> | ApiErrorResponse> => {
    const authorized = await authorizeModInstance(request, 'mod:install')
    if (authorized.error) {
      return authorized.error
    }
    const parsedParams = modInstanceParamsSchema.safeParse(request.params)
    const parsedBody = modBatchUpdatePayloadSchema.safeParse(request.body ?? {})
    if (!parsedParams.success || !parsedBody.success) {
      return businessError('请求参数无效', request)
    }
    const instanceId = parsedParams.data.instanceId
    const resolved = await resolveLocalDstInstance(instanceId, request, {
      messages: {
        wrongNode: '当前仅支持本地节点实例 Mod 管理',
        wrongGame: '当前仅支持 DST 实例 Mod 管理',
        missingInstallPath: '实例安装目录不存在，请先完成安装',
      },
    })
    if (!resolved.ok) {
      return resolved.error
    }
    const workshopIds = [...new Set(parsedBody.data.workshopIds.map(id => id.trim()).filter(Boolean))]
    const payloads: ModInstallPayload[] = []
    const notFoundJobs: ModInstallJobDto[] = []
    for (const workshopId of workshopIds) {
      const mod = await getInstanceModByWorkshopId(instanceId, workshopId)
      if (!mod) {
        notFoundJobs.push({
          instanceId,
          workshopId,
          status: 'not_found',
          phase: null,
          error: 'Mod 不存在',
          startedAt: null,
          finishedAt: null,
        })
        continue
      }
      payloads.push({
        workshopId,
        name: mod.name,
        previewImage: mod.previewImage ?? undefined,
      })
    }
    // 一次把整批交给队列：逐个入队会让每个 Mod 各成一批，等于多跑几次 SteamCMD
    const startedJobs = payloads.length > 0
      ? await enqueueModDownloads({
          instanceId,
          installPath: resolved.instance.installPath,
          payloads,
          force: true,
        })
      : []
    const jobByWorkshopId = new Map(
      [...startedJobs, ...notFoundJobs].map(job => [job.workshopId, job]),
    )
    const jobs = workshopIds
      .map(workshopId => jobByWorkshopId.get(workshopId))
      .filter((job): job is ModInstallJobDto => Boolean(job))
    return success(jobs, request)
  })

  app.get('/app/instances/:instanceId/mods/install-jobs/:workshopId', async (request): Promise<ApiSuccessResponse<ModInstallJobDto> | ApiErrorResponse> => {
    const authorized = await authorizeModInstance(request, 'mod:read')
    if (authorized.error) {
      return authorized.error
    }
    const parsedParams = modWorkshopParamsSchema.safeParse(request.params)
    if (!parsedParams.success) {
      return businessError('请求参数无效', request)
    }
    const instanceId = parsedParams.data.instanceId
    const workshopId = parsedParams.data.workshopId
    const resolved = await resolveLocalDstInstance(instanceId, request, {
      messages: {
        wrongNode: '当前仅支持本地节点实例 Mod 管理',
        wrongGame: '当前仅支持 DST 实例 Mod 管理',
        missingInstallPath: '实例安装目录不存在，请先完成安装',
      },
    })
    if (!resolved.ok) {
      return resolved.error
    }
    if (!workshopId) {
      return businessError('创意工坊 ID 不能为空', request)
    }
    const job = await resolveModInstallJob(instanceId, workshopId)
    return success(await enrichInstallJobDto(instanceId, job), request)
  })

  app.get('/app/instances/:instanceId/mods/install-jobs', async (request): Promise<ApiSuccessResponse<ModInstallJobDto[]> | ApiErrorResponse> => {
    const authorized = await authorizeModInstance(request, 'mod:read')
    if (authorized.error) {
      return authorized.error
    }
    const parsedParams = modInstanceParamsSchema.safeParse(request.params)
    const parsedQuery = modInstallJobsQuerySchema.safeParse(request.query)
    if (!parsedParams.success || !parsedQuery.success) {
      return businessError('请求参数无效', request)
    }
    const instanceId = parsedParams.data.instanceId
    const resolved = await resolveLocalDstInstance(instanceId, request, {
      messages: {
        wrongNode: '当前仅支持本地节点实例 Mod 管理',
        wrongGame: '当前仅支持 DST 实例 Mod 管理',
        missingInstallPath: '实例安装目录不存在，请先完成安装',
      },
    })
    if (!resolved.ok) {
      return resolved.error
    }
    const rawIds = parsedQuery.data.workshopIds
    const workshopIds = Array.isArray(rawIds)
      ? rawIds.flatMap(id => normalizeDependencyIds([id]))
      : (typeof rawIds === 'string' && rawIds.trim()
          ? normalizeDependencyIds(rawIds.split(','))
          : undefined)
    const jobs = listModInstallJobs(instanceId, workshopIds)
    // 批量查询不做逐条 enrich：那会按 job 数各读一次库并解析 lua，
    // 前端现在按队列状态渲染，不再需要每个 job 都带上完整 Mod
    return success(jobs, request)
  })

  /**
   * 实例级 Mod 下载队列状态。
   *
   * 前端只轮询这一个接口（默认 3 秒）：一个实例只有一条队列、一个 Queue Manager，
   * 不再为每个 Mod 各起一个轮询。
   */
  app.get('/app/instances/:instanceId/mods/download-queue', async (request): Promise<ApiSuccessResponse<ModDownloadQueueDto> | ApiErrorResponse> => {
    const authorized = await authorizeModInstance(request, 'mod:read')
    if (authorized.error) {
      return authorized.error
    }
    const parsedParams = modInstanceParamsSchema.safeParse(request.params)
    if (!parsedParams.success) {
      return businessError('请求参数无效', request)
    }
    const instanceId = parsedParams.data.instanceId
    const resolved = await resolveLocalDstInstance(instanceId, request, {
      messages: {
        wrongNode: '当前仅支持本地节点实例 Mod 管理',
        wrongGame: '当前仅支持 DST 实例 Mod 管理',
        missingInstallPath: '实例安装目录不存在，请先完成安装',
      },
    })
    if (!resolved.ok) {
      return resolved.error
    }
    const queue = await resolveModDownloadQueueState({
      instanceId,
      installPath: resolved.instance.installPath,
    })
    return success(queue, request)
  })

  app.get('/app/instances/:instanceId/mods/access-status', async (request) => {
    const authorized = await authorizeModInstance(request, 'mod:read')
    if (authorized.error) return authorized.error
    const parsed = modInstanceParamsSchema.safeParse(request.params)
    if (!parsed.success) return businessError('请求参数无效', request)
    const resolved = await resolveLocalDstInstance(parsed.data.instanceId, request, { ensureClusterDirectory: false })
    if (!resolved.ok) return resolved.error
    return success(getModAccessStatus(parsed.data.instanceId), request)
  })

  /** 开始/继续下载队列（幂等：已在跑时返回当前状态） */
  app.post('/app/instances/:instanceId/mods/download-queue/start', async (request): Promise<ApiSuccessResponse<ModDownloadQueueDto> | ApiErrorResponse> => {
    const authorized = await authorizeModInstance(request, 'mod:install')
    if (authorized.error) {
      return authorized.error
    }
    const parsedParams = modInstanceParamsSchema.safeParse(request.params)
    if (!parsedParams.success) {
      return businessError('请求参数无效', request)
    }
    const parsedBody = modDownloadQueueStartSchema.safeParse(request.body ?? {})
    if (!parsedBody.success) return businessError('请求参数无效', request)
    const instanceId = parsedParams.data.instanceId
    const resolved = await resolveLocalDstInstance(instanceId, request, {
      messages: {
        wrongNode: '当前仅支持本地节点实例 Mod 管理',
        wrongGame: '当前仅支持 DST 实例 Mod 管理',
        missingInstallPath: '实例安装目录不存在，请先完成安装',
      },
    })
    if (!resolved.ok) {
      return resolved.error
    }
    const queue = await startModDownloadQueue({
      instanceId,
      installPath: resolved.instance.installPath,
      retryFailed: parsedBody.data.retryFailed,
    })
    return success(queue, request)
  })

  /** 暂停队列：当前批次跑完后停在批次边界 */
  app.post('/app/instances/:instanceId/mods/download-queue/pause', async (request): Promise<ApiSuccessResponse<ModDownloadQueueDto> | ApiErrorResponse> => {
    const authorized = await authorizeModInstance(request, 'mod:install')
    if (authorized.error) {
      return authorized.error
    }
    const parsedParams = modInstanceParamsSchema.safeParse(request.params)
    if (!parsedParams.success) {
      return businessError('请求参数无效', request)
    }
    const instanceId = parsedParams.data.instanceId
    const resolved = await resolveLocalDstInstance(instanceId, request, {
      messages: {
        wrongNode: '当前仅支持本地节点实例 Mod 管理',
        wrongGame: '当前仅支持 DST 实例 Mod 管理',
        missingInstallPath: '实例安装目录不存在，请先完成安装',
      },
    })
    if (!resolved.ok) {
      return resolved.error
    }
    const paused = pauseModDownloadQueue(instanceId)
    if (paused) {
      return success(paused, request)
    }
    return success(await resolveModDownloadQueueState({
      instanceId,
      installPath: resolved.instance.installPath,
    }), request)
  })

  /** 取消当前批次（杀掉正在跑的 SteamCMD）并暂停；未完成的项保持待下载 */
  app.post('/app/instances/:instanceId/mods/download-queue/cancel', async (request): Promise<ApiSuccessResponse<ModDownloadQueueDto> | ApiErrorResponse> => {
    const authorized = await authorizeModInstance(request, 'mod:install')
    if (authorized.error) {
      return authorized.error
    }
    const parsedParams = modInstanceParamsSchema.safeParse(request.params)
    if (!parsedParams.success) {
      return businessError('请求参数无效', request)
    }
    const instanceId = parsedParams.data.instanceId
    const resolved = await resolveLocalDstInstance(instanceId, request, {
      messages: {
        wrongNode: '当前仅支持本地节点实例 Mod 管理',
        wrongGame: '当前仅支持 DST 实例 Mod 管理',
        missingInstallPath: '实例安装目录不存在，请先完成安装',
      },
    })
    if (!resolved.ok) {
      return resolved.error
    }
    const cancelled = await cancelModDownloadQueue(instanceId)
    if (cancelled) {
      return success(cancelled, request)
    }
    return success(await resolveModDownloadQueueState({
      instanceId,
      installPath: resolved.instance.installPath,
    }), request)
  })

  app.put('/app/instances/:instanceId/mods/:modId', async (request): Promise<ApiSuccessResponse<ModMutationResult> | ApiErrorResponse> => {
    const authorized = await authorizeModInstance(request, 'mod:toggle')
    if (authorized.error) {
      return authorized.error
    }
    const parsedParams = modItemParamsSchema.safeParse(request.params)
    const parsedBody = modUpdatePayloadSchema.safeParse(request.body ?? {})
    if (!parsedParams.success || !parsedBody.success) {
      return businessError('请求参数无效', request)
    }
    const instanceId = parsedParams.data.instanceId
    const modId = parsedParams.data.modId
    const resolved = await resolveLocalDstInstance(instanceId, request, {
      messages: {
        wrongNode: '当前仅支持本地节点实例 Mod 管理',
        wrongGame: '当前仅支持 DST 实例 Mod 管理',
        missingInstallPath: '实例安装目录不存在，请先完成安装',
      },
    })
    if (!resolved.ok) {
      return resolved.error
    }
    if (!modId) {
      return businessError('Mod ID 不能为空', request)
    }
    const body = parsedBody.data
    const mod = await getInstanceModByWorkshopId(instanceId, modId)
    if (!mod) {
      return businessError('Mod 不存在', request)
    }
    if (mod.installStatus !== 'ready') {
      return businessError('Mod 尚未下载完成，请等待订阅完成后再操作', request)
    }
    const updated = await updateInstanceModByWorkshopId(instanceId, modId, {
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      name: typeof body.name === 'string' ? body.name.trim() || mod.name : undefined,
      version: typeof body.version === 'string' ? body.version.trim() || null : undefined,
    })
    const dependencyMap = readModDependencyMap(resolved.instance.installPath)
    if (Array.isArray(body.dependencyIds)) {
      dependencyMap[modId] = normalizeDependencyIds(body.dependencyIds)
      writeModDependencyMap(resolved.instance.installPath, dependencyMap)
    }
    await syncInstanceModFilesFromDb(instanceId, resolved.instance.installPath)
    const payload = await buildModListPayload(instanceId)
    const dto = payload.mods.find(item => item.workshopId === modId)
    if (!updated || !dto) {
      return businessError('Mod 更新失败', request)
    }
    return success({
      saved: true,
      riskTip: payload.riskTip,
      mod: dto,
    }, request)
  })

  app.put('/app/instances/:instanceId/mods/reorder', async (request): Promise<ApiSuccessResponse<ModReorderResult> | ApiErrorResponse> => {
    const authorized = await authorizeModInstance(request, 'mod:toggle')
    if (authorized.error) {
      return authorized.error
    }
    const parsedParams = modInstanceParamsSchema.safeParse(request.params)
    const parsedBody = modReorderPayloadSchema.safeParse(request.body ?? {})
    if (!parsedParams.success || !parsedBody.success) {
      return businessError('请求参数无效', request)
    }
    const instanceId = parsedParams.data.instanceId
    const resolved = await resolveLocalDstInstance(instanceId, request, {
      messages: {
        wrongNode: '当前仅支持本地节点实例 Mod 管理',
        wrongGame: '当前仅支持 DST 实例 Mod 管理',
        missingInstallPath: '实例安装目录不存在，请先完成安装',
      },
    })
    if (!resolved.ok) {
      return resolved.error
    }
    const body = parsedBody.data
    const workshopIds = normalizeDependencyIds(body.workshopIds)
    const currentMods = normalizeLoadOrder(
      (await listInstanceMods(instanceId)).filter(mod => mod.installStatus === 'ready'),
    )
    if (currentMods.length !== workshopIds.length) {
      return businessError('排序参数与当前 Mod 数量不一致', request)
    }
    const currentIdSet = new Set(currentMods.map(mod => mod.workshopId))
    if (workshopIds.some(workshopId => !currentIdSet.has(workshopId))) {
      return businessError('排序参数包含未知 Mod ID', request)
    }
    for (let index = 0; index < workshopIds.length; index++) {
      const workshopId = workshopIds[index]
      await updateInstanceModByWorkshopId(instanceId, workshopId, { loadOrder: index })
    }
    await syncInstanceModFilesFromDb(instanceId, resolved.instance.installPath)
    const payload = await buildModListPayload(instanceId)
    return success({
      saved: true,
      riskTip: payload.riskTip,
      mods: payload.mods,
    }, request)
  })

  app.get('/app/instances/:instanceId/mods/:modId/config', async (request): Promise<ApiSuccessResponse<ModConfigDto> | ApiErrorResponse> => {
    const authorized = await authorizeModInstance(request, 'mod:read')
    if (authorized.error) {
      return authorized.error
    }
    const parsedParams = modItemParamsSchema.safeParse(request.params)
    if (!parsedParams.success) {
      return businessError('请求参数无效', request)
    }
    const instanceId = parsedParams.data.instanceId
    const workshopId = parsedParams.data.modId
    const resolved = await resolveLocalDstInstance(instanceId, request, {
      messages: {
        wrongNode: '当前仅支持本地节点实例 Mod 管理',
        wrongGame: '当前仅支持 DST 实例 Mod 管理',
        missingInstallPath: '实例安装目录不存在，请先完成安装',
      },
    })
    if (!resolved.ok) {
      return resolved.error
    }
    if (!workshopId) {
      return businessError('Mod ID 不能为空', request)
    }
    const mod = await getInstanceModByWorkshopId(instanceId, workshopId)
    if (!mod) {
      return businessError('Mod 不存在', request)
    }
    const stored = parseStoredModConfig(mod.config)
    const options = stored
      ?? parseModOverridesConfigurations(resolved.instance.installPath).get(workshopId)
      ?? {}
    const definitions = parseModInfoConfigurations(resolved.instance.installPath, workshopId)
    const payload: ModConfigDto = {
      instanceId,
      workshopId,
      options,
      definitions,
    }
    return success(payload, request)
  })

  app.put('/app/instances/:instanceId/mods/:modId/config', async (request): Promise<ApiSuccessResponse<ModConfigSaveResult> | ApiErrorResponse> => {
    const authorized = await authorizeModInstance(request, 'mod:config')
    if (authorized.error) {
      return authorized.error
    }
    const parsedParams = modItemParamsSchema.safeParse(request.params)
    const parsedBody = modConfigPayloadSchema.safeParse(request.body ?? {})
    if (!parsedParams.success || !parsedBody.success) {
      return businessError('请求参数无效', request)
    }
    const instanceId = parsedParams.data.instanceId
    const workshopId = parsedParams.data.modId
    const resolved = await resolveLocalDstInstance(instanceId, request, {
      messages: {
        wrongNode: '当前仅支持本地节点实例 Mod 管理',
        wrongGame: '当前仅支持 DST 实例 Mod 管理',
        missingInstallPath: '实例安装目录不存在，请先完成安装',
      },
    })
    if (!resolved.ok) {
      return resolved.error
    }
    if (!workshopId) {
      return businessError('Mod ID 不能为空', request)
    }
    const mod = await getInstanceModByWorkshopId(instanceId, workshopId)
    if (!mod) {
      return businessError('Mod 不存在', request)
    }
    if (mod.installStatus !== 'ready') {
      return businessError('Mod 尚未下载完成，请等待订阅完成后再配置', request)
    }
    const options = parsedBody.data.options
    const updated = await updateInstanceModByWorkshopId(instanceId, workshopId, {
      config: Object.keys(options).length > 0 ? JSON.stringify(options) : null,
    })
    if (!updated) {
      return businessError('Mod 配置保存失败', request)
    }
    await syncInstanceModFilesFromDb(instanceId, resolved.instance.installPath)
    return success({
      saved: true,
      riskTip: getRuntimeRiskTip(resolved.instance.status),
    }, request)
  })

  app.delete('/app/instances/:instanceId/mods/:modId', async (request): Promise<ApiSuccessResponse<ModDeleteResult> | ApiErrorResponse> => {
    const authorized = await authorizeModInstance(request, 'mod:install')
    if (authorized.error) {
      return authorized.error
    }
    const parsedParams = modItemParamsSchema.safeParse(request.params)
    if (!parsedParams.success) {
      return businessError('请求参数无效', request)
    }
    const instanceId = parsedParams.data.instanceId
    const modId = parsedParams.data.modId
    const resolved = await resolveLocalDstInstance(instanceId, request, {
      messages: {
        wrongNode: '当前仅支持本地节点实例 Mod 管理',
        wrongGame: '当前仅支持 DST 实例 Mod 管理',
        missingInstallPath: '实例安装目录不存在，请先完成安装',
      },
    })
    if (!resolved.ok) {
      return resolved.error
    }
    if (!modId) {
      return businessError('Mod ID 不能为空', request)
    }
    const deleted = await deleteInstanceModByWorkshopId(instanceId, modId)
    if (!deleted) {
      return businessError('Mod 不存在', request)
    }
    // 删记录的同时收掉 mods/workshop-<id> 接入：残留的链接会被 DST 当成仍在订阅的 Mod 加载
    removeDstLegacyModLinks(resolved.instance.installPath, [modId])
    const dependencyMap = readModDependencyMap(resolved.instance.installPath)
    delete dependencyMap[modId]
    for (const workshopId of Object.keys(dependencyMap)) {
      dependencyMap[workshopId] = dependencyMap[workshopId].filter(dep => dep !== modId)
    }
    writeModDependencyMap(resolved.instance.installPath, dependencyMap)
    const normalized = normalizeLoadOrder(await listInstanceMods(instanceId))
    for (const mod of normalized) {
      await updateInstanceModByWorkshopId(instanceId, mod.workshopId, { loadOrder: mod.loadOrder })
    }
    await syncInstanceModFilesFromDb(instanceId, resolved.instance.installPath)
    return success({
      deleted: true,
      riskTip: getRuntimeRiskTip(resolved.instance.status),
    }, request)
  })
}
