import { assertInstanceContentAvailable, beginInstanceContentActivity } from '../../shared/instance-content/operation'
import type {
  ModDownloadQueueDto,
  ModDownloadQueueStatus,
  ModDownloadQueueItemDto,
  ModInstallJobDto,
  ModInstallJobPhase,
  ModInstallJobStatus,
  ModInstallPayload,
} from '../../../../shared/contracts/mod'
import {
  downloadDstWorkshopMods,
  isDstWorkshopModPresent,
} from '../../infra/game-adapter/dst/mod-download'
import {
  readModDependencies,
  readModDependencyMap,
  writeModDependencyMap,
} from '../../infra/game-adapter/dst/mod-service'
import { resolveModDisplayName, readLocalModInfo } from '../../infra/game-adapter/dst/mod-config'
import { resolveDstSteamWorkshopModDir } from '../../infra/game-adapter/dst/constants'
import path from 'node:path'
import { ensureDstUgcModLayout } from '../../infra/game-adapter/dst/ugc-mod-install'
import { resolveLocalModContentVersion } from '../../infra/game-adapter/dst/mod-content-version'
import { readWorkshopInstalledItems } from '../../infra/game-adapter/dst/workshop-manifest'
import { fetchWorkshopModMetadata } from '../../infra/game-adapter/dst/steam-workshop'
import { observeSteamAccess } from '../../infra/game-adapter/dst/steam-access-observation'
import { syncInstanceModFilesFromDb } from './mod-file-sync-service'
import { isPlaceholderModName, MISSING_MOD_CONTENT_ERROR } from './mod-readiness-service'
import { cancelSteamcmdInstallContainer } from '../../infra/container/steamcmd-runner'
import {
  getInstanceModByWorkshopId,
  listInstanceMods,
  updateInstanceModByWorkshopId,
  upsertInstanceMod,
} from '../../shared/db/index'
import type { DbInstanceMod } from '../../shared/db/index'

/**
 * Mod 下载队列调度器。
 *
 * 导入存档带进来 30 个缺失 Mod 时，绝不为每个 Mod 各起一个后台任务：一个实例只有一条队列、
 * 一个 Queue Manager 决定「下一批下哪些」，一次 SteamCMD 处理一个 Batch。这样做的原因是
 * 上游 SteamCMD 本身全局串行（`steamcmd-app-update-queue.ts`），上层再造 N 个任务只会得到
 * N 个排队等锁的任务、N 份重复的批量集合，以及 N 轮 DB/文件系统收尾。
 *
 * 队列状态本身不落库：待下载集合就是 `instance_mods.install_status = 'pending'`，
 * 退避进度落在 `retry_count` / `next_retry_at` 两列上。面板重启后队列为空，
 * pending 项原样留在库里等用户点「开始下载」——不依赖内存 Job 恢复。
 */

export interface ModDownloadJobInput {
  instanceId: string
  installPath: string
  payload: ModInstallPayload
  /** 为 true 时跳过「已就绪且文件存在」短路，强制重新下载 */
  force?: boolean
}

interface ModInstallJobRecord {
  instanceId: string
  workshopId: string
  status: Exclude<ModInstallJobStatus, 'not_found'>
  phase: ModInstallJobPhase | null
  error: string | null
  startedAt: string | null
  finishedAt: string | null
}

/** 队列里的一项 */
export interface ModDownloadQueueItem {
  workshopId: string
  force: boolean
  /** user = 用户显式订阅/更新（失败即失败，立即反馈）；backfill = 补齐缺失内容（失败进退避） */
  source: 'user' | 'backfill'
  /** user 项带上订阅 payload：成功后据此写回依赖映射 */
  payload?: ModInstallPayload
}

interface InstanceQueueState {
  instanceId: string
  installPath: string
  status: ModDownloadQueueStatus
  batchSize: number
  /** 插队项（用户显式动作），优先于补齐项 */
  head: ModDownloadQueueItem[]
  /** 当前批次 */
  active: ModDownloadQueueItem[]
  /** 本次队列目标总数 */
  total: number
  success: number
  failed: number
  batchIndex: number
  startedAt: string | null
  updatedAt: string | null
  lastError: string | null
  warnings: string[]
  nextBatchAt: string | null
  pauseRequested: boolean
  cancelRequested: boolean
  runPromise: Promise<void> | null
  /** 尚未处理的 Mod（由选批结果维护） */
  waitingIds: string[]
  /** 用户显式点「开始下载」：开场先把退避耗尽的失败项重置后一起排队 */
  retryFailed: boolean
  mods: DbInstanceMod[]
  eligibleIds: string[]
}

const modInstallJobs = new Map<string, ModInstallJobRecord>()
const modInstallJobsInFlight = new Map<string, Promise<void>>()
const queueStates = new Map<string, InstanceQueueState>()

/** 单批上限：一次 SteamCMD 调用最多处理几个 Mod（默认 5，最大 10） */
const MOD_DOWNLOAD_BATCH_SIZE_ENV = 'GSH_MOD_DOWNLOAD_COALESCE_LIMIT'
const MOD_DOWNLOAD_BATCH_SIZE_DEFAULT = 5
const MOD_DOWNLOAD_BATCH_SIZE_MAX = 10

/** 最多尝试三次；第一次和第二次失败后分别等待 10、30 秒。 */
export const MOD_DOWNLOAD_RETRY_DELAYS_MS = [10_000, 30_000]
export const MOD_DOWNLOAD_MAX_ATTEMPTS = 3

/** 退避间隔可被测试替换（真实退避要等几十秒，测试里用毫秒级序列验证同一套逻辑） */
let modDownloadRetryDelaysMs: number[] = [...MOD_DOWNLOAD_RETRY_DELAYS_MS]

/** 退避等待时每秒回来看一次，保证暂停/取消能及时生效 */
const BACKOFF_POLL_STEP_MS = 1000

type ModDownloadExecutor = typeof downloadDstWorkshopMods
let modDownloadExecutor: ModDownloadExecutor = downloadDstWorkshopMods

type ListInstanceModsFn = typeof listInstanceMods
type GetInstanceModByWorkshopIdFn = typeof getInstanceModByWorkshopId
type UpsertInstanceModFn = typeof upsertInstanceMod
type UpdateInstanceModByWorkshopIdFn = typeof updateInstanceModByWorkshopId
type FetchWorkshopModMetadataFn = typeof fetchWorkshopModMetadata

let listInstanceModsFn: ListInstanceModsFn = listInstanceMods
let getInstanceModByWorkshopIdFn: GetInstanceModByWorkshopIdFn = getInstanceModByWorkshopId
let upsertInstanceModFn: UpsertInstanceModFn = upsertInstanceMod
let updateInstanceModByWorkshopIdFn: UpdateInstanceModByWorkshopIdFn = updateInstanceModByWorkshopId
let fetchWorkshopModMetadataFn: FetchWorkshopModMetadataFn = fetchWorkshopModMetadata

function readPositiveIntEnv(key: string, fallback: number): number {
  const rawValue = process.env[key]
  if (!rawValue) {
    return fallback
  }
  const parsed = Number.parseInt(rawValue, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback
  }
  return parsed
}

function resolveModDownloadBatchSize(): number {
  const configured = readPositiveIntEnv(MOD_DOWNLOAD_BATCH_SIZE_ENV, MOD_DOWNLOAD_BATCH_SIZE_DEFAULT)
  return Math.min(configured, MOD_DOWNLOAD_BATCH_SIZE_MAX)
}

/**
 * 导入存档与面板启动时是否自动开跑队列。
 *
 * 默认关闭：迁移包带进来几十个缺失 Mod，一起下在国内网络会长时间占住 SteamCMD 串行锁，
 * 期间面板的其它下载/安装都得排队。用户显式点「开始下载」才跑。
 */
export function isModDownloadAutoStartEnabled(): boolean {
  return readPositiveIntEnv('GSH_MOD_DOWNLOAD_AUTO_START', 0) === 1
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function buildJobKey(instanceId: string, workshopId: string) {
  return `${instanceId}:${workshopId}`
}

function normalizeDependencyIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const unique = new Set<string>()
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) {
      unique.add(item.trim())
    }
  }
  return [...unique]
}

function uniqueOrderedIds(ids: string[]): string[] {
  return [...new Set(ids.map(id => id.trim()).filter(Boolean))]
}

function toJobDto(record: ModInstallJobRecord): ModInstallJobDto {
  return {
    instanceId: record.instanceId,
    workshopId: record.workshopId,
    status: record.status,
    phase: record.phase,
    error: record.error,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
  }
}

function collectDownloadWorkshopIds(payload: ModInstallPayload): string[] {
  const dependencyIds = normalizeDependencyIds(payload.dependencyIds)
  const workshopId = payload.workshopId.trim()
  const ordered = dependencyIds.filter(id => id !== workshopId)
  if (workshopId) {
    ordered.push(workshopId)
  }
  return uniqueOrderedIds(ordered)
}

function patchJobRecord(
  instanceId: string,
  workshopId: string,
  patch: Partial<ModInstallJobRecord>,
) {
  const key = buildJobKey(instanceId, workshopId)
  const existing = modInstallJobs.get(key)
  if (!existing) {
    return
  }
  modInstallJobs.set(key, { ...existing, ...patch })
}

function beginJobRecords(instanceId: string, workshopIds: string[]) {
  const startedAt = new Date().toISOString()
  for (const workshopId of workshopIds) {
    modInstallJobs.set(buildJobKey(instanceId, workshopId), {
      instanceId,
      workshopId,
      status: 'downloading',
      phase: 'waiting_steamcmd',
      error: null,
      startedAt,
      finishedAt: null,
    })
  }
}

function finishJobRecord(
  instanceId: string,
  workshopId: string,
  status: 'success' | 'failed',
  error: string | null,
) {
  patchJobRecord(instanceId, workshopId, {
    status,
    phase: null,
    error,
    finishedAt: new Date().toISOString(),
  })
}

/**
 * 为批次内的 Mod 登记「在途」标记：`waitForModInstallJob` 与单 Mod 轮询靠它判断任务是否结束。
 * 批次结束（无论成败）统一释放。
 */
function trackBatchInFlight(instanceId: string, workshopIds: string[]): () => void {
  const keys = workshopIds.map(workshopId => buildJobKey(instanceId, workshopId))
  const resolvers: Array<() => void> = []
  for (const key of keys) {
    modInstallJobsInFlight.set(key, new Promise<void>((resolve) => {
      resolvers.push(resolve)
    }))
  }
  return () => {
    for (const key of keys) {
      modInstallJobsInFlight.delete(key)
    }
    for (const resolve of resolvers) {
      resolve()
    }
  }
}

function resolvePersistedModName(installPath: string, workshopId: string, requestedName?: string): string {
  const trimmed = requestedName?.trim() ?? ''
  if (trimmed && !isPlaceholderModName(trimmed)) {
    return trimmed
  }
  return resolveModDisplayName(installPath, workshopId) || trimmed || `Workshop Mod ${workshopId}`
}

async function fetchWorkshopUpdatedAtMap(workshopIds: string[]): Promise<Map<string, string>> {
  const ids = uniqueOrderedIds(workshopIds)
  const result = new Map<string, string>()
  if (ids.length === 0) {
    return result
  }
  try {
    const metadata = await fetchWorkshopModMetadataFn(ids)
    for (const [workshopId, item] of metadata.items) {
      const updatedAt = item.updatedAt?.trim()
      if (updatedAt) {
        result.set(workshopId, updatedAt)
      }
    }
  }
  catch {
    // 工坊不可达不影响下载结果：状态留在「未检查」，等下一次检查
  }
  return result
}

async function upsertPendingModRecord(input: ModDownloadJobInput) {
  const { instanceId, payload } = input
  const workshopId = payload.workshopId.trim()
  const mods = await listInstanceModsFn(instanceId)
  const existing = mods.find(mod => mod.workshopId === workshopId)
  const nextLoadOrder = existing ? existing.loadOrder : mods.length
  await upsertInstanceModFn({
    instanceId,
    workshopId,
    name: payload.name?.trim() || existing?.name || `Workshop Mod ${workshopId}`,
    previewImage: payload.previewImage?.trim() || existing?.previewImage || null,
    enabled: typeof payload.enabled === 'boolean'
      ? payload.enabled
      : (existing?.enabled ?? false),
    loadOrder: nextLoadOrder,
    version: payload.version?.trim() || existing?.version || null,
    installStatus: 'pending',
    installError: null,
    downloadIntent: input.force ? 'update' : (existing?.downloadIntent ?? 'install'),
    retryCount: 0,
    nextRetryAt: null,
  })
}

// ---------------------------------------------------------------------------
// 选批：队列统一决定一批下哪些 Mod
// ---------------------------------------------------------------------------

interface BackfillPlan {
  eligibleIds: string[]
  /** 可以进入队列的 workshopId（依赖在前） */
  order: string[]
  /** 有 pending 但都在退避等待时的最早到期时间 */
  nextAvailableAt: string | null
  warnings: string[]
}

/**
 * 补齐项（pending）的选批计划。
 *
 * - 只处理启用中的 Mod；缺失且被禁用的 Mod 不进队列（面板不替用户下载用不上的内容）。
 * - 启用项的必要依赖一并入队（依赖不在库里的补一条启用记录，否则 DST 不会加载它）。
 * - 依赖排在依赖者之前；依赖仍在退避等待时，依赖者也一起推迟到下一轮。
 * - 退避未到期的项本轮跳过；全都在等待时返回最早到期时间。
 */
async function buildBackfillPlan(input: {
  instanceId: string
  installPath: string
  mods: DbInstanceMod[]
  now: number
  persistDependencies?: boolean
}): Promise<BackfillPlan> {
  const { instanceId, installPath, mods, now } = input
  const dependencyMap = readModDependencyMap(installPath)
  const byId = new Map(mods.map(mod => [mod.workshopId, mod]))
  const warnings: string[] = []
  const included = new Set<string>()
  const viaDependencyOf = new Map<string, string>()
  const seeds: DbInstanceMod[] = []
  // modinfo.lua 读取按 workshopId 缓存：选批过程中同一个 Mod 会被依赖闭包与拓扑排序反复问到
  const dependencyCache = new Map<string, string[]>()
  const resolveDependencies = (workshopId: string): string[] => {
    const cached = dependencyCache.get(workshopId)
    if (cached) {
      return cached
    }
    const resolved = readModDependencies(installPath, workshopId, dependencyMap)
    dependencyCache.set(workshopId, resolved)
    return resolved
  }

  for (const mod of mods) {
    if ((!mod.enabled && !mod.downloadIntent) || included.has(mod.workshopId)) {
      continue
    }
    included.add(mod.workshopId)
    seeds.push(mod)
  }

  const queue = seeds.map(mod => mod.workshopId)
  let appendedCount = 0
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const dependencyId of resolveDependencies(current)) {
      if (included.has(dependencyId)) {
        continue
      }
      const dependencyMod = byId.get(dependencyId)
      if (!dependencyMod) {
        // 依赖不在库中：补一条启用记录。不写进库的话它既不会下载，也不会进 modoverrides.lua
        appendedCount += 1
        if (input.persistDependencies) await upsertInstanceModFn({
          instanceId,
          workshopId: dependencyId,
          name: `workshop-${dependencyId}`,
          enabled: true,
          loadOrder: mods.length + appendedCount,
          installStatus: 'pending',
          installError: MISSING_MOD_CONTENT_ERROR,
          retryCount: 0,
          nextRetryAt: null,
        })
      }
      else if (!dependencyMod.enabled) {
        warnings.push(`Mod ${current} 的依赖 ${dependencyId} 处于禁用状态，游戏可能无法加载该 Mod`)
      }
      included.add(dependencyId)
      viaDependencyOf.set(dependencyId, current)
      queue.push(dependencyId)
    }
  }

  if (included.size === 0) {
    return { eligibleIds: [], order: [], nextAvailableAt: null, warnings: uniqueWarnings(warnings) }
  }

  const availableAt = (workshopId: string): number | null => {
    const mod = byId.get(workshopId)
    const raw = mod?.nextRetryAt
    if (!raw) {
      return null
    }
    const at = Date.parse(raw)
    return Number.isFinite(at) ? at : null
  }
  const isAvailable = (workshopId: string): boolean => {
    const at = availableAt(workshopId)
    return at === null || at <= now
  }

  let earliestRetryAt: number | null = null
  for (const workshopId of included) {
    const at = availableAt(workshopId)
    if (at === null || at <= now) {
      continue
    }
    earliestRetryAt = earliestRetryAt === null ? at : Math.min(earliestRetryAt, at)
  }

  // 拓扑序（依赖先入队）+ 依赖不可用则整体推迟
  const ordered: string[] = []
  const visiting = new Set<string>()
  const done = new Set<string>()
  const deferred = new Set<string>()
  const visit = (workshopId: string): void => {
    if (visiting.has(workshopId)) {
      warnings.push('检测到 Mod 循环依赖，将分别下载各项；请检查依赖配置')
      return
    }
    if (done.has(workshopId)) {
      return
    }
    visiting.add(workshopId)
    let blocked = !isAvailable(workshopId)
    for (const dependencyId of resolveDependencies(workshopId)) {
      if (!included.has(dependencyId)) {
        continue
      }
      visit(dependencyId)
      if (deferred.has(dependencyId)) {
        blocked = true
      }
    }
    visiting.delete(workshopId)
    done.add(workshopId)
    if (blocked) {
      deferred.add(workshopId)
      return
    }
    const mod = byId.get(workshopId)
    if (!mod || mod.installStatus === 'pending') ordered.push(workshopId)
  }

  const sortedSeeds = [...seeds].sort(
    (a, b) => Number(Boolean(b.downloadIntent)) - Number(Boolean(a.downloadIntent)) || a.loadOrder - b.loadOrder || a.createdAt.localeCompare(b.createdAt),
  )
  for (const seed of sortedSeeds) {
    visit(seed.workshopId)
  }
  for (const workshopId of included) {
    visit(workshopId)
  }

  return {
    eligibleIds: [...included].filter(id => byId.get(id)?.installStatus !== 'ready'),
    order: ordered,
    nextAvailableAt: earliestRetryAt === null ? null : new Date(earliestRetryAt).toISOString(),
    warnings: uniqueWarnings(warnings),
  }
}

function uniqueWarnings(warnings: string[]): string[] {
  return [...new Set(warnings)].slice(0, 5)
}

interface SelectedBatch {
  items: ModDownloadQueueItem[]
  force: boolean
  /** 取走本批后仍在队列里的 id */
  restIds: string[]
  nextAvailableAt: string | null
  warnings: string[]
}

/**
 * 插队项（用户显式动作）优先：同步取出并立刻登记为当前批次。
 *
 * 「取出」与「进入批次」之间不能跨 await：async 函数返回一定有一个 microtask 边界，
 * 那段时间里该项既不在 head 也不在 active，会被看成「队列已经空了」——重复入队判定
 * 会因此误判，前端也会看到一瞬间的空队列。
 */
function takeHeadBatch(state: InstanceQueueState): SelectedBatch | null {
  if (state.head.length === 0) {
    return null
  }
  const force = state.head[0].force
  const items = state.head.filter(item => item.force === force).slice(0, state.batchSize)
  const consumed = new Set(items)
  state.head = state.head.filter(item => !consumed.has(item))
  state.active = items
  return {
    items,
    force,
    restIds: uniqueOrderedIds([
      ...state.head.map(item => item.workshopId),
      ...state.waitingIds,
    ]),
    nextAvailableAt: null,
    warnings: state.warnings,
  }
}

/** 补齐项：由队列统一选批（可能为缺失依赖补一条待下载记录，所以是异步的） */
async function planBackfillBatch(
  state: InstanceQueueState,
  mods: DbInstanceMod[],
): Promise<SelectedBatch> {
  const plan = await buildBackfillPlan({
    instanceId: state.instanceId,
    installPath: state.installPath,
    mods,
    now: Date.now(),
    persistDependencies: true,
  })
  state.eligibleIds = plan.eligibleIds
  const first = plan.order[0]
  const force = mods.find(mod => mod.workshopId === first)?.downloadIntent === 'update'
  const ids = plan.order.filter(id => (mods.find(mod => mod.workshopId === id)?.downloadIntent === 'update') === force).slice(0, state.batchSize)
  return {
    items: ids.map(workshopId => ({ workshopId, force, source: mods.find(mod => mod.workshopId === workshopId)?.downloadIntent ? 'user' as const : 'backfill' as const })),
    force,
    restIds: plan.order.filter(id => !ids.includes(id)),
    nextAvailableAt: plan.nextAvailableAt,
    warnings: plan.warnings,
  }
}

// ---------------------------------------------------------------------------
// 批次执行
// ---------------------------------------------------------------------------

async function runBatch(
  state: InstanceQueueState,
  items: ModDownloadQueueItem[],
  force: boolean,
): Promise<void> {
  const workshopIds = uniqueOrderedIds(items.map(item => item.workshopId))
  if (workshopIds.length === 0) {
    return
  }
  state.active = items
  state.updatedAt = new Date().toISOString()

  const mods = await listInstanceModsFn(state.instanceId)
  const byId = new Map(mods.map(mod => [mod.workshopId, mod]))
  const payloadById = new Map<string, ModInstallPayload>()
  for (const item of items) {
    if (item.payload) {
      payloadById.set(item.workshopId, item.payload)
    }
  }

  beginJobRecords(state.instanceId, workshopIds)
  const releaseInFlight = trackBatchInFlight(state.instanceId, workshopIds)

  try {
    // 内容已在盘上的先判就绪（上次下完但没来得及写库就会停在这里），不必再跑一次 SteamCMD
    const readyOnDisk: string[] = []
    const toDownload: string[] = []
    for (const workshopId of workshopIds) {
      if (!force && isDstWorkshopModPresent(state.installPath, workshopId)) {
        readyOnDisk.push(workshopId)
      }
      else {
        toDownload.push(workshopId)
      }
    }

    let cancelled = false
    let failureError: string | null = null
    const verifiedDownloads = new Set<string>()
    if (toDownload.length > 0) {
      const result = await modDownloadExecutor({
        hostInstallPath: state.installPath,
        workshopIds: toDownload,
        instanceId: state.instanceId,
        force,
        cancelKey: `modq-${state.instanceId}`,
        onAwaitingSteamcmdLock: () => {
          for (const workshopId of toDownload) {
            patchJobRecord(state.instanceId, workshopId, { phase: 'waiting_steamcmd' })
          }
        },
        onDownloadStart: () => {
          for (const workshopId of toDownload) {
            patchJobRecord(state.instanceId, workshopId, { phase: 'downloading' })
          }
        },
      })
      cancelled = result.cancelled === true
      failureError = result.ok ? null : (result.error ?? 'Mod 下载失败，请稍后重试')
      observeSteamAccess('files', { status: result.cancelled ? 'cancelled' : result.ok ? 'success' : 'failed',
        message: result.cancelled ? '本次下载已取消' : result.ok ? '最近一次 SteamCMD 文件下载成功' : '最近一次 SteamCMD 文件下载失败，请查看失败条目并重试或本地导入' }, state.instanceId)
      for (const id of toDownload) {
        if (result.ok || result.items?.some(item => item.workshopId === id && item.ok)) verifiedDownloads.add(id)
      }
    }

    // 内容就位的（含这次刚下完的）统一落位：DST 只从 ugc_mods 读创意工坊 Mod，
    // 落位失败等于「下载目录有内容、游戏里没有」，必须算这一项失败
    const contentReadyIds = workshopIds.filter((workshopId) => {
      const contentPresent = isDstWorkshopModPresent(state.installPath, workshopId)
      // 强制更新时旧内容仍在盘上，文件存在不能证明这次下载成功，以 SteamCMD 结果为准
      return contentPresent && (!force || verifiedDownloads.has(workshopId))
    })
    // 强制更新时必须重新落位：目标目录里还是旧内容，跳过落位等于「下载目录更新了、
    // 游戏读的还是旧文件」，版本状态会一直停在「有新版本」且再也清不掉
    const layoutOutcomes = contentReadyIds.length > 0
      ? await ensureDstUgcModLayout(state.installPath, contentReadyIds, { refresh: force })
      : []
    const layoutFailed = new Map<string, string>()
    for (const outcome of layoutOutcomes) {
      if (outcome.status === 'failed') {
        layoutFailed.set(outcome.workshopId, outcome.error ?? 'Mod 文件未能安装到服务器目录')
      }
    }
    const contentReady = new Set(contentReadyIds)

    const now = Date.now()
    const succeeded: string[] = []
    let terminalFailedCount = 0
    for (const workshopId of workshopIds) {
      const layoutError = layoutFailed.get(workshopId)
      if (contentReady.has(workshopId) && !layoutError) {
        succeeded.push(workshopId)
        continue
      }
      const item = items.find(candidate => candidate.workshopId === workshopId)
      const retryCount = (byId.get(workshopId)?.retryCount ?? 0) + 1
      const isUserItem = item?.source === 'user'
      if (cancelled) {
        // 用户主动取消：不算失败，也不消耗重试次数，点「继续下载」即可再试
        await patchMod(state.instanceId, workshopId, {
          installStatus: 'pending',
          installError: '下载已取消',
          nextRetryAt: null,
        })
        finishJobRecord(state.instanceId, workshopId, 'failed', '下载已取消')
        continue
      }
      if (!isUserItem && retryCount < MOD_DOWNLOAD_MAX_ATTEMPTS) {
        const delayMs = modDownloadRetryDelaysMs[
          Math.min(retryCount, modDownloadRetryDelaysMs.length) - 1
        ] ?? modDownloadRetryDelaysMs[modDownloadRetryDelaysMs.length - 1] ?? 10_000
        const nextRetryAt = new Date(now + delayMs).toISOString()
        const retryError = `下载失败，${Math.round(delayMs / 1000)} 秒后重试（第 ${retryCount}/${MOD_DOWNLOAD_MAX_ATTEMPTS} 次）`
        await patchMod(state.instanceId, workshopId, {
          installStatus: 'pending',
          installError: retryError,
          retryCount,
          nextRetryAt,
        })
        finishJobRecord(state.instanceId, workshopId, 'failed', retryError)
        continue
      }
      const finalError = layoutError
        ? `Mod 文件未能安装到服务器目录：${layoutError}`
        : (failureError ?? 'Mod 下载失败，请稍后重试')
      await patchMod(state.instanceId, workshopId, {
        installStatus: 'failed',
        installError: finalError,
        retryCount,
        nextRetryAt: null,
      })
      finishJobRecord(state.instanceId, workshopId, 'failed', finalError)
      terminalFailedCount += 1
    }

    if (succeeded.length > 0) {
      // 落位已在上面对整批内容就位的项统一完成，这里只登记状态与写回 lua
      await markBatchReady(state, succeeded, byId, payloadById, verifiedDownloads)
      await syncInstanceModFilesFromDb(state.instanceId, state.installPath)
    }

    // 退避等待中的项不算失败：它们仍是 pending，下一批还会回来
    state.failed += terminalFailedCount
  }
  finally {
    state.active = []
    state.mods = await listInstanceModsFn(state.instanceId)
    releaseInFlight()
    state.updatedAt = new Date().toISOString()
  }
}

/** 单条状态写入失败不影响批次内其余 Mod */
async function patchMod(
  instanceId: string,
  workshopId: string,
  patch: Parameters<UpdateInstanceModByWorkshopIdFn>[2],
): Promise<void> {
  try {
    await updateInstanceModByWorkshopIdFn(instanceId, workshopId, patch)
  }
  catch {
    // ignore
  }
}

async function markBatchReady(
  state: InstanceQueueState,
  workshopIds: string[],
  byId: Map<string, DbInstanceMod>,
  payloadById: Map<string, ModInstallPayload>,
  downloadedIds: Set<string>,
): Promise<void> {
  if (workshopIds.length === 0) {
    return
  }
  // 这一批一起问一次工坊，避免每个 Mod 各打一次接口；清单与依赖映射同样只读一次
  const installedItems = readWorkshopInstalledItems(state.installPath)
  const dependencyMap = readModDependencyMap(state.installPath)
  let dependencyMapDirty = false
  const readyVersions = new Map<string, string>()
  for (const workshopId of workshopIds) {
    const mod = byId.get(workshopId)
    const contentSource = downloadedIds.has(workshopId) ? 'steam' : (mod?.contentSource ?? 'steam')
    const localVersion = resolveLocalModContentVersion(state.installPath, workshopId, { installedItems, contentSource, knownUpdatedAt: mod?.localUpdatedAt })
    try {
      const ready = await upsertInstanceModFn({
        instanceId: state.instanceId,
        workshopId,
        name: resolvePersistedModName(state.installPath, workshopId, mod?.name),
        previewImage: mod?.previewImage ?? null,
        enabled: mod?.enabled ?? false,
        loadOrder: mod?.loadOrder ?? 0,
        version: contentSource === 'steam' && downloadedIds.has(workshopId) ? readLocalModInfo(path.join(resolveDstSteamWorkshopModDir(state.installPath, workshopId), 'modinfo.lua')).version : (mod?.version ?? null),
        installStatus: 'ready',
        contentSource,
        installError: null,
        downloadIntent: null,
        localUpdatedAt: localVersion.updatedAt,
        loadedCopyStale: localVersion.loadedCopyStale,
        retryCount: 0,
        nextRetryAt: null,
      })
      readyVersions.set(workshopId, ready.updatedAt)
      state.success += 1
    }
    catch {
      state.failed += 1
      await patchMod(state.instanceId, workshopId, { installStatus: 'failed', installError: '文件已安装，但状态保存失败，请重试' })
      finishJobRecord(state.instanceId, workshopId, 'failed', '文件已安装，但状态保存失败，请重试')
      continue
    }
    finishJobRecord(state.instanceId, workshopId, 'success', null)

    // 下载前未知的依赖只能从新内容读出；显式下载的禁用父项也要补齐文件。
    if (mod?.downloadIntent) {
      for (const dependencyId of readModDependencies(state.installPath, workshopId, dependencyMap)) {
        if (dependencyId === workshopId) continue
        const existing = await getInstanceModByWorkshopIdFn(state.instanceId, dependencyId)
        if (existing?.installStatus === 'ready' || state.active.some(item => item.workshopId === dependencyId)) continue
        await upsertPendingModRecord({ instanceId: state.instanceId, installPath: state.installPath,
          payload: { workshopId: dependencyId, enabled: existing?.enabled ?? true } })
      }
    }

    const payload = payloadById.get(workshopId)
    const dependencyIds = normalizeDependencyIds(payload?.dependencyIds)
    if (dependencyIds.length > 0) {
      dependencyMap[workshopId] = dependencyIds
      dependencyMapDirty = true
    }
  }
  if (dependencyMapDirty) {
    writeModDependencyMap(state.installPath, dependencyMap)
  }
  // 文件就绪先反馈。远端补全失败不延长下载状态，也不覆盖新的下载/本地导入。
  const enrichmentInstanceId = state.instanceId
  const readMod = getInstanceModByWorkshopIdFn
  const updateMod = updateInstanceModByWorkshopIdFn
  void fetchWorkshopUpdatedAtMap(workshopIds).then(async (metadata) => {
    for (const [id, remoteUpdatedAt] of metadata) {
      const current = await readMod(enrichmentInstanceId, id)
      if (current?.installStatus === 'ready' && current.contentSource !== 'local' && !current.downloadIntent && current.updatedAt === readyVersions.get(id)) {
        await updateMod(enrichmentInstanceId, id, { remoteUpdatedAt, updateCheckedAt: new Date().toISOString() }).catch(() => {})
      }
    }
  }).catch(() => {})
}

// ---------------------------------------------------------------------------
// Queue Manager：一个实例一条队列、一个 worker
// ---------------------------------------------------------------------------

async function runQueueLoop(state: InstanceQueueState): Promise<void> {
  const release = beginInstanceContentActivity(state.instanceId)
  try {
    await prepareQueue(state)
    while (true) {
      if (state.cancelRequested || state.pauseRequested) {
        state.status = 'paused'
        state.nextBatchAt = null
        break
      }
      if (state.retryFailed) await prepareQueue(state)
      const mods = await listInstanceModsFn(state.instanceId)
      state.mods = mods
      const headBatch = takeHeadBatch(state)
      const batch = headBatch ?? (await planBackfillBatch(state, mods))
      state.warnings = uniqueWarnings([...state.warnings, ...batch.warnings])
      state.waitingIds = batch.restIds
      recalcQueueTotal(state, mods)
      if (state.pauseRequested || state.cancelRequested) continue
      if (batch.items.length === 0) {
        if (batch.nextAvailableAt) {
          state.status = 'running'
          state.nextBatchAt = batch.nextAvailableAt
          const dueAt = Date.parse(batch.nextAvailableAt)
          const waitMs = Number.isFinite(dueAt)
            ? Math.min(BACKOFF_POLL_STEP_MS, Math.max(0, dueAt - Date.now()))
            : BACKOFF_POLL_STEP_MS
          await sleep(waitMs)
          continue
        }
        // 没有可下载的项：队列收敛为 idle（pending 里只剩禁用项等用户处理）
        state.status = 'idle'
        state.nextBatchAt = null
        break
      }
      state.nextBatchAt = null
      state.batchIndex += 1
      state.status = 'running'
      await runBatch(state, batch.items, batch.force)
    }
  }
  catch (error) {
    state.status = 'paused'
    state.lastError = error instanceof Error ? error.message : String(error)
  }
  finally {
    release()
    state.active = []
    if (state.status === 'running') {
      state.status = 'idle'
    }
    state.updatedAt = new Date().toISOString()
  }
}

/**
 * 队列开场：读一次 DB 算目标总数；用户显式点「开始下载」时，把退避耗尽的失败项重置后一起排队。
 *
 * 放在 worker 里而不是 `startModDownloadQueue` 里，是为了让 start 在前几个 await 之前就同步占位——
 * 否则重复点击/多标签页并发调用会各自建一条队列，等于又回到「多个下载任务抢锁」。
 */
async function prepareQueue(state: InstanceQueueState): Promise<void> {
  let mods = await listInstanceModsFn(state.instanceId)
  if (state.retryFailed) {
    state.retryFailed = false
    const plan = await buildBackfillPlan({ instanceId: state.instanceId, installPath: state.installPath, mods, now: Date.now() })
    const failedMods = mods.filter(mod => mod.installStatus === 'failed' && plan.eligibleIds.includes(mod.workshopId))
    for (const mod of failedMods) {
      await patchMod(state.instanceId, mod.workshopId, {
        installStatus: 'pending',
        installError: null,
        retryCount: 0,
        nextRetryAt: null,
      })
    }
    if (failedMods.length > 0) {
      mods = await listInstanceModsFn(state.instanceId)
    }
  }
  recalcQueueTotal(state, mods)
  state.mods = mods
  state.updatedAt = new Date().toISOString()
}

/**
 * 目标总数 = 已终结的（成功 + 失败）+ 还在队列里的。
 *
 * 两件事都要照顾到：
 * - 插队项在库里也是 pending，按 id 去重后才不会把同一批数两遍；
 * - 分母不能缩水，否则进度会出现「已完成 3/2」这种自相矛盾的读数。
 */
function recalcQueueTotal(state: InstanceQueueState, mods: DbInstanceMod[]): void {
  const waiting = new Set(state.head.map(item => item.workshopId))
  for (const id of state.eligibleIds) if (!mods.some(mod => mod.workshopId === id)) waiting.add(id)
  for (const mod of mods) {
    if (mod.installStatus === 'pending' && (state.eligibleIds.includes(mod.workshopId) || mod.enabled || mod.downloadIntent)) {
      waiting.add(mod.workshopId)
    }
  }
  state.total = waiting.size + state.success + state.failed
}

function launchQueueWorker(state: InstanceQueueState) {
  const run = runQueueLoop(state)
  state.runPromise = run
  const clear = () => {
    if (state.runPromise === run) {
      state.runPromise = null
    }
  }
  void run.then(clear, clear)
}

function toQueueDto(state: InstanceQueueState): ModDownloadQueueDto {
  const activeCount = state.active.length
  const phase = state.active.length > 0
    ? (modInstallJobs.get(buildJobKey(state.instanceId, state.active[0].workshopId))?.phase ?? 'waiting_steamcmd')
    : state.nextBatchAt ? 'retry_wait' as const : null
  const queuedIds = new Set([...state.head.map(item => item.workshopId), ...state.waitingIds, ...state.eligibleIds])
  const items: ModDownloadQueueItemDto[] = state.mods.map(mod => {
    const active = state.active.some(item => item.workshopId === mod.workshopId)
    const job = modInstallJobs.get(buildJobKey(state.instanceId, mod.workshopId))
    const status = active ? 'pending' : mod.installStatus
    return { workshopId: mod.workshopId, installStatus: status,
      phase: active ? (job?.phase ?? 'waiting_steamcmd') : status === 'ready' ? 'ready' : status === 'failed' ? 'failed' : mod.nextRetryAt ? 'retry_wait' : queuedIds.has(mod.workshopId) ? 'queued' : 'inactive',
      error: mod.installError, nextRetryAt: mod.nextRetryAt }
  })
  for (const id of queuedIds) {
    if (items.some(item => item.workshopId === id)) continue
    items.push({ workshopId: id, installStatus: 'pending', phase: 'queued', error: MISSING_MOD_CONTENT_ERROR, nextRetryAt: null })
  }
  return {
    instanceId: state.instanceId,
    status: state.status,
    phase,
    items,
    eligibleCount: items.filter(item => item.installStatus === 'pending' && item.phase !== 'inactive').length,
    inactiveMissingCount: items.filter(item => item.phase === 'inactive').length,
    retryableFailedCount: items.filter(item => item.phase === 'failed' && queuedIds.has(item.workshopId)).length,
    total: state.total,
    queued: Math.max(0, state.total - state.success - state.failed - activeCount),
    downloading: phase === 'downloading' ? activeCount : 0,
    success: state.success,
    failed: state.failed,
    currentWorkshopIds: state.active.map(item => item.workshopId),
    queueWorkshopIds: uniqueOrderedIds([
      ...state.head.map(item => item.workshopId),
      ...state.waitingIds,
    ]),
    batchSize: state.batchSize,
    currentBatchIndex: state.batchIndex,
    nextBatchAt: state.nextBatchAt,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    lastError: state.lastError,
    warnings: state.warnings,
  }
}

/** 队列是否正在实际跑 SteamCMD（列表接口据此决定要不要把 pending 显示成「下载中」） */
export function getModDownloadQueueSnapshot(instanceId: string): ModDownloadQueueDto | null {
  const state = queueStates.get(instanceId.trim())
  return state ? toQueueDto(state) : null
}

export async function startModDownloadQueue(input: {
  instanceId: string
  installPath: string
  head?: ModDownloadQueueItem[]
  /** 用户显式点「开始下载」时为 true：把退避耗尽的失败项重置后一起排队 */
  retryFailed?: boolean
}): Promise<ModDownloadQueueDto> {
  const instanceId = input.instanceId.trim()
  assertInstanceContentAvailable(instanceId)
  const installPath = input.installPath
  const existing = queueStates.get(instanceId)
  if (existing && existing.runPromise) {
    if (input.head && input.head.length > 0) {
      const previousHeadSize = existing.head.length
      existing.head = mergeQueueItems(existing.head, input.head.filter(item => !existing.active.some(active => active.workshopId === item.workshopId)))
      // 只把真正新增的计入总数；去重后的差额会在下一轮 recalcQueueTotal 里被纠正
      existing.total += existing.head.length - previousHeadSize
    }
    existing.retryFailed = existing.retryFailed || input.retryFailed === true
    return toQueueDto(existing)
  }

  const batchSize = resolveModDownloadBatchSize()
  const head = input.head ? mergeQueueItems([], input.head) : []
  const state: InstanceQueueState = {
    instanceId,
    installPath,
    status: 'running',
    batchSize,
    head,
    active: [],
    total: head.length,
    success: 0,
    failed: 0,
    batchIndex: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastError: null,
    warnings: [],
    nextBatchAt: null,
    pauseRequested: false,
    cancelRequested: false,
    runPromise: null,
    waitingIds: [],
    retryFailed: input.retryFailed === true,
    mods: [],
    eligibleIds: [],
  }
  // 同步占位：worker 在下一个 await 之前就被登记为「已有一条队列」
  queueStates.set(instanceId, state)
  launchQueueWorker(state)
  return toQueueDto(state)
}

function mergeQueueItems(
  current: ModDownloadQueueItem[],
  incoming: ModDownloadQueueItem[],
): ModDownloadQueueItem[] {
  const merged = [...current]
  const seen = new Set(merged.map(item => item.workshopId))
  for (const item of incoming) {
    if (seen.has(item.workshopId)) {
      continue
    }
    seen.add(item.workshopId)
    merged.push(item)
  }
  return merged
}

export function pauseModDownloadQueue(instanceId: string): ModDownloadQueueDto | null {
  const state = queueStates.get(instanceId.trim())
  if (!state) {
    return null
  }
  state.pauseRequested = true
  if (state.active.length > 0 && state.active.every(item => modInstallJobs.get(buildJobKey(state.instanceId, item.workshopId))?.phase === 'waiting_steamcmd')) {
    void cancelSteamcmdInstallContainer(`modq-${state.instanceId}`).catch(() => {})
  }
  state.status = state.runPromise ? 'pausing' : 'paused'
  state.updatedAt = new Date().toISOString()
  return toQueueDto(state)
}

export async function cancelModDownloadQueue(instanceId: string): Promise<ModDownloadQueueDto | null> {
  const state = queueStates.get(instanceId.trim())
  if (!state) {
    return null
  }
  state.cancelRequested = true
  state.pauseRequested = true
  state.status = state.runPromise ? 'pausing' : 'paused'
  state.updatedAt = new Date().toISOString()
  if (state.active.length > 0) {
    await cancelSteamcmdInstallContainer(`modq-${state.instanceId}`)
  }
  return toQueueDto(state)
}

/**
 * 队列状态：内存里有队列就用内存的进度，没有就从数据库的 pending 推导。
 *
 * 面板重启后队列为空、`pending` 原样留在库里，所以这里给出的是「待下载 N 个」而不是
 * 「正在下载」——用户显式点「开始下载」才会真正跑起来。
 *
 * 与 worker 共用候选计算，计入显式意图和已知依赖；只读状态请求不新增依赖记录。
 */
export async function resolveModDownloadQueueState(input: {
  instanceId: string
  installPath: string
}): Promise<ModDownloadQueueDto> {
  const instanceId = input.instanceId.trim()
  const mods = await listInstanceModsFn(instanceId)
  const plan = await buildBackfillPlan({ ...input, mods, now: Date.now() })
  const state = queueStates.get(instanceId)
  if (state) {
    state.mods = mods
    state.eligibleIds = plan.eligibleIds
    state.waitingIds = plan.eligibleIds.filter(id => mods.find(mod => mod.workshopId === id)?.installStatus === 'pending' && !state.active.some(item => item.workshopId === id))
    recalcQueueTotal(state, mods)
    return toQueueDto(state)
  }
  const eligible = mods.filter(mod => mod.installStatus === 'pending' && plan.eligibleIds.includes(mod.workshopId))
  const missingIds = plan.eligibleIds.filter(id => !mods.some(mod => mod.workshopId === id))
  const batchSize = resolveModDownloadBatchSize()
  return {
    instanceId,
    status: 'idle',
    phase: null,
    items: [...mods.map(mod => ({ workshopId: mod.workshopId, installStatus: mod.installStatus,
      phase: mod.installStatus === 'ready' ? 'ready' : mod.installStatus === 'failed' ? 'failed' : plan.eligibleIds.includes(mod.workshopId) ? (mod.nextRetryAt ? 'retry_wait' : 'queued') : 'inactive',
      error: mod.installError, nextRetryAt: mod.nextRetryAt } as ModDownloadQueueItemDto)),
      ...missingIds.map(workshopId => ({ workshopId, installStatus: 'pending' as const, phase: 'queued' as const, error: MISSING_MOD_CONTENT_ERROR, nextRetryAt: null }))],
    eligibleCount: eligible.length + missingIds.length,
    inactiveMissingCount: mods.filter(mod => mod.installStatus === 'pending' && !plan.eligibleIds.includes(mod.workshopId)).length,
    retryableFailedCount: mods.filter(mod => mod.installStatus === 'failed' && plan.eligibleIds.includes(mod.workshopId)).length,
    total: eligible.length + missingIds.length,
    queued: eligible.length + missingIds.length,
    downloading: 0,
    success: 0,
    failed: 0,
    currentWorkshopIds: [],
    queueWorkshopIds: [...eligible.map(mod => mod.workshopId), ...missingIds],
    batchSize,
    currentBatchIndex: 0,
    nextBatchAt: plan.nextAvailableAt,
    startedAt: null,
    updatedAt: null,
    lastError: null,
    warnings: plan.warnings,
  }
}

export async function waitForModDownloadQueueIdle(instanceId: string): Promise<void> {
  const state = queueStates.get(instanceId.trim())
  if (state?.runPromise) {
    await state.runPromise
  }
  // worker 的收尾（清 runPromise）在同一 microtask 链上，再让出一轮确保观察者看到稳定状态
  await Promise.resolve()
}

// ---------------------------------------------------------------------------
// 单 Mod 入口与任务查询
// ---------------------------------------------------------------------------

/**
 * 「已就绪且内容在盘」的订阅直接返回成功。
 *
 * 注意判据里必须有 `installStatus === 'ready'`：只检查磁盘上有没有内容是不够的——
 * legacy 包（`*_legacy.bin`）算「有内容」但还没解压落位到 ugc_mods，跳过队列等于让游戏加载不到。
 */
async function resolveReadyWithoutQueue(
  instanceId: string,
  workshopId: string,
): Promise<ModInstallJobDto> {
  const now = new Date().toISOString()
  const record: ModInstallJobRecord = {
    instanceId,
    workshopId,
    status: 'success',
    phase: null,
    error: null,
    startedAt: now,
    finishedAt: now,
  }
  modInstallJobs.set(buildJobKey(instanceId, workshopId), record)
  return toJobDto(record)
}

export async function enqueueModDownload(input: ModDownloadJobInput): Promise<ModInstallJobDto> {
  const workshopId = input.payload.workshopId.trim()
  const downloadIds = collectDownloadWorkshopIds(input.payload)
  const existingMod = await getInstanceModByWorkshopIdFn(input.instanceId, workshopId)
  const force = input.force === true || existingMod?.downloadIntent === 'update'
  const filesReady = downloadIds.every(id => isDstWorkshopModPresent(input.installPath, id))

  if (!force && existingMod?.installStatus === 'ready' && filesReady) {
    const outcomes = await ensureDstUgcModLayout(input.installPath, downloadIds)
    if (outcomes.every(outcome => outcome.status !== 'failed')) return resolveReadyWithoutQueue(input.instanceId, workshopId)
  }

  // 同一实例内同一个 workshopId 只排一次：它可能已经在队列里等着、或正在当前批次下载
  const jobKey = buildJobKey(input.instanceId, workshopId)
  const currentRecord = modInstallJobs.get(jobKey)
  if (currentRecord?.status === 'downloading') {
    const queueState = queueStates.get(input.instanceId)
    const queued = Boolean(queueState
      && [...queueState.head, ...queueState.active].some(item => item.workshopId === workshopId))
    // in-flight 标记覆盖「已从队列取出、正在跑批次」这段；队列内位置覆盖「还在等着」
    if (queued || modInstallJobsInFlight.has(jobKey)) {
      return toJobDto(currentRecord)
    }
  }

  if (existingMod?.installStatus === 'failed') {
    await patchMod(input.instanceId, workshopId, {
      installStatus: 'pending',
      installError: null,
      retryCount: 0,
      nextRetryAt: null,
    })
  }

  await upsertPendingModRecord({ ...input, force })
  for (const id of downloadIds.filter(id => id !== workshopId)) {
    const existing = await getInstanceModByWorkshopIdFn(input.instanceId, id)
    if (existing?.installStatus === 'ready' && !force) continue
    await upsertPendingModRecord({ ...input, force, payload: { workshopId: id, enabled: existing?.enabled ?? true } })
  }
  beginJobRecords(input.instanceId, [workshopId])
  const head: ModDownloadQueueItem[] = downloadIds.map(id => ({
    workshopId: id,
    force,
    source: 'user' as const,
    payload: id === workshopId ? input.payload : undefined,
  }))
  await startModDownloadQueue({
    instanceId: input.instanceId,
    installPath: input.installPath,
    head,
  })
  return getModInstallJob(input.instanceId, workshopId)
}

/**
 * 批量入队（「批量更新」这类一次传多个 Mod 的入口）。
 *
 * 逐个调用 `enqueueModDownload` 会让每个 Mod 各自成为一个批次：第一批只带第一个，
 * 其余的顺延到后面几批，等于把一次 SteamCMD 能做完的事拆成 N 次登录（国内网络下差别很大）。
 * 这里先把整批插队项攒齐，再一次性交给队列。
 */
export async function enqueueModDownloads(input: {
  instanceId: string
  installPath: string
  payloads: ModInstallPayload[]
  force?: boolean
}): Promise<ModInstallJobDto[]> {
  const jobs: ModInstallJobDto[] = []
  const head: ModDownloadQueueItem[] = []
  for (const payload of input.payloads) {
    const workshopId = payload.workshopId.trim()
    if (!workshopId) {
      continue
    }
    const current = queueStates.get(input.instanceId)
    if (current && [...current.head, ...current.active].some(item => item.workshopId === workshopId)) {
      jobs.push(getModInstallJob(input.instanceId, workshopId))
      continue
    }
    const downloadIds = collectDownloadWorkshopIds(payload)
    const existingMod = await getInstanceModByWorkshopIdFn(input.instanceId, workshopId)
    const force = input.force === true || existingMod?.downloadIntent === 'update'
    const filesReady = downloadIds.every(id => isDstWorkshopModPresent(input.installPath, id))
    if (!force && existingMod?.installStatus === 'ready' && filesReady) {
      jobs.push(await resolveReadyWithoutQueue(input.instanceId, workshopId))
      continue
    }
    if (existingMod?.installStatus === 'failed') {
      await patchMod(input.instanceId, workshopId, {
        installStatus: 'pending',
        installError: null,
        retryCount: 0,
        nextRetryAt: null,
      })
    }
    await upsertPendingModRecord({
      instanceId: input.instanceId,
      installPath: input.installPath,
      payload,
      force,
    })
    for (const id of downloadIds.filter(id => id !== workshopId)) {
      const existing = await getInstanceModByWorkshopIdFn(input.instanceId, id)
      if (existing?.installStatus === 'ready' && !force) continue
      await upsertPendingModRecord({ ...input, force, payload: { workshopId: id, enabled: existing?.enabled ?? true } })
    }
    beginJobRecords(input.instanceId, [workshopId])
    for (const id of downloadIds) {
      head.push({
        workshopId: id,
        force,
        source: 'user',
        payload: id === workshopId ? payload : undefined,
      })
    }
    jobs.push(getModInstallJob(input.instanceId, workshopId))
  }
  if (head.length > 0) {
    await startModDownloadQueue({
      instanceId: input.instanceId,
      installPath: input.installPath,
      head,
    })
  }
  return jobs
}

export function getModInstallJob(instanceId: string, workshopId: string): ModInstallJobDto {
  const key = buildJobKey(instanceId, workshopId.trim())
  const record = modInstallJobs.get(key)
  if (!record) {
    return {
      instanceId,
      workshopId: workshopId.trim(),
      status: 'not_found',
      phase: null,
      error: null,
      startedAt: null,
      finishedAt: null,
    }
  }
  return toJobDto(record)
}

export async function resolveModInstallJob(instanceId: string, workshopId: string): Promise<ModInstallJobDto> {
  const normalizedId = workshopId.trim()
  const memoryJob = getModInstallJob(instanceId, normalizedId)
  if (memoryJob.status !== 'not_found') {
    return memoryJob
  }
  const mod = await getInstanceModByWorkshopIdFn(instanceId, normalizedId)
  if (!mod) {
    return memoryJob
  }
  if (mod.installStatus === 'ready') {
    return {
      instanceId,
      workshopId: normalizedId,
      status: 'success',
      phase: null,
      error: null,
      startedAt: mod.updatedAt,
      finishedAt: mod.updatedAt,
    }
  }
  if (mod.installStatus === 'failed') {
    return {
      instanceId,
      workshopId: normalizedId,
      status: 'failed',
      phase: null,
      error: mod.installError,
      startedAt: mod.updatedAt,
      finishedAt: mod.updatedAt,
    }
  }
  // 仍是 pending：队列可能随时接手（也可能在退避等待）。这里只如实回答「未完成」，
  // 不写库把状态改成失败——那会把退避进度冲掉。
  return {
    instanceId,
    workshopId: normalizedId,
    status: 'downloading',
    phase: null,
    error: mod.installError,
    startedAt: mod.updatedAt,
    finishedAt: null,
  }
}

export function listModInstallJobs(instanceId: string, workshopIds?: string[]): ModInstallJobDto[] {
  const normalizedIds = workshopIds?.map(id => id.trim()).filter(Boolean)
  const jobs: ModInstallJobDto[] = []
  for (const record of modInstallJobs.values()) {
    if (record.instanceId !== instanceId) {
      continue
    }
    if (normalizedIds && normalizedIds.length > 0 && !normalizedIds.includes(record.workshopId)) {
      continue
    }
    jobs.push(toJobDto(record))
  }
  return jobs
}

export async function waitForModInstallJob(instanceId: string, workshopId: string): Promise<void> {
  const key = buildJobKey(instanceId, workshopId.trim())
  const task = modInstallJobsInFlight.get(key)
  if (task) {
    await task
    return
  }
  // 还没进批次：退化为等当前队列这一轮跑完（单 Mod 订阅在入队瞬间就可能命中这里）
  await waitForModDownloadQueueIdle(instanceId)
}

// ---------------------------------------------------------------------------
// 测试专用
// ---------------------------------------------------------------------------

/** 测试专用：清空内存 job 与队列状态 */
export function resetModInstallJobsForTest() {
  modInstallJobs.clear()
  modInstallJobsInFlight.clear()
  resetModDownloadQueueForTest()
}

/** 测试专用：清空内存队列状态（模拟面板重启） */
export function resetModDownloadQueueForTest() {
  queueStates.clear()
}

/** 测试专用：替换退避间隔序列 */
export function setModDownloadRetryDelaysForTest(delays: number[]) {
  modDownloadRetryDelaysMs = [...delays]
}

/** 测试专用：恢复默认退避间隔序列 */
export function resetModDownloadRetryDelaysForTest() {
  modDownloadRetryDelaysMs = [...MOD_DOWNLOAD_RETRY_DELAYS_MS]
}

/** 测试专用：替换 Mod 下载执行器 */
export function setModDownloadExecutorForTest(executor: ModDownloadExecutor) {
  modDownloadExecutor = executor
}

/** 测试专用：恢复默认 Mod 下载执行器 */
export function resetModDownloadExecutorForTest() {
  modDownloadExecutor = downloadDstWorkshopMods
}

export function setModDownloadDbHooksForTest(hooks: {
  listInstanceMods?: ListInstanceModsFn
  getInstanceModByWorkshopId?: GetInstanceModByWorkshopIdFn
  upsertInstanceMod?: UpsertInstanceModFn
  updateInstanceModByWorkshopId?: UpdateInstanceModByWorkshopIdFn
  fetchWorkshopModMetadata?: FetchWorkshopModMetadataFn
}) {
  if (hooks.listInstanceMods) {
    listInstanceModsFn = hooks.listInstanceMods
  }
  if (hooks.getInstanceModByWorkshopId) {
    getInstanceModByWorkshopIdFn = hooks.getInstanceModByWorkshopId
  }
  if (hooks.upsertInstanceMod) {
    upsertInstanceModFn = hooks.upsertInstanceMod
  }
  if (hooks.updateInstanceModByWorkshopId) {
    updateInstanceModByWorkshopIdFn = hooks.updateInstanceModByWorkshopId
  }
  if (hooks.fetchWorkshopModMetadata) {
    fetchWorkshopModMetadataFn = hooks.fetchWorkshopModMetadata
  }
}

export function resetModDownloadDbHooksForTest() {
  listInstanceModsFn = listInstanceMods
  getInstanceModByWorkshopIdFn = getInstanceModByWorkshopId
  upsertInstanceModFn = upsertInstanceMod
  updateInstanceModByWorkshopIdFn = updateInstanceModByWorkshopId
  fetchWorkshopModMetadataFn = fetchWorkshopModMetadata
}
