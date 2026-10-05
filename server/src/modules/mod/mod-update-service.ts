import { readBrandEnv } from '../../../../shared/brand-env'
import type { FastifyInstance } from 'fastify'
import type {
  ModUpdateCheckResult,
  ModUpdateInfo,
  ModUpdateStatus,
} from '../../../../shared/contracts/mod'
import type { DbInstanceMod } from '../../shared/db/index'
import type { WorkshopModMetadata } from '../../infra/game-adapter/dst/steam-workshop'
import fs from 'node:fs'
import { withInstanceContentActivity } from '../../shared/instance-content/operation'
import { DST_APP_ID } from '../../infra/game-adapter/dst/constants'
import { resolveInstanceInstallPath } from '../../infra/game-adapter/dst/cluster-service'
import { fetchWorkshopModMetadata } from '../../infra/game-adapter/dst/steam-workshop'
import { resolveLocalModContentVersion } from '../../infra/game-adapter/dst/mod-content-version'
import { readWorkshopInstalledItems } from '../../infra/game-adapter/dst/workshop-manifest'
import { LOCAL_NODE_ID } from '../../shared/dst/local-dst-instance'
import {
  listGameInstances,
  listInstanceMods,
  updateInstanceModByWorkshopId,
} from '../../shared/db/index'

/**
 * Mod 版本检查：回答「面板里这份 Mod 是不是创意工坊上的最新版」。
 *
 * 面板用 `-skip_update_server_mods` 启动 DST，游戏侧永远不会自己更新 Mod，因此
 * 「服务器启用了一些老版本的 Mod、新玩家进不来」这类问题只能由面板发现并解决：
 *
 *  本机版本 = 内容凭据：SteamCMD 清单 timeupdated，缺失时用内容文件的落地时间
 *  远端版本 = 公开接口 GetPublishedFileDetails 返回的 time_updated
 *
 * 两侧都是「版本时间」，远端更新即认定有新版本。比较用严格大于：误报的代价是用户多点一次
 * 「更新」（SteamCMD 校验后内容不变，状态随即回到已最新），漏报的代价是玩家进不了游戏。
 * 缺任一侧就老实回答「无法判定」，绝不猜成「已是最新」——尤其**绝不**拿「面板记录这份内容的
 * 时间」顶上：记录时刻必然晚于当时的工坊版本，拿它比较等于恒定报「已是最新」。
 *
 * 内容凭据统一由 mod-content-version.ts 解析，那里还回答「游戏实际加载的那份（ugc_mods）
 * 是否比已下载内容旧」——DST 专用服只读 ugc_mods，落位被跳过时两份内容会不一致。
 *
 * 同一次请求顺带把工坊标题与缩略图写回面板：导入存档后那些名字不对、没有图的 Mod，
 * 就是靠这一步被认出来的（面板没有重命名入口，工坊标题即权威名称）。
 */

/** 非强制检查时，距上次检查多久之内不重复问 Steam */
export const MOD_UPDATE_CHECK_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000
const PERIODIC_MOD_UPDATE_CHECK_MS = 6 * 60 * 60 * 1000
const PERIODIC_FIRST_DELAY_MS = 45 * 1000

export interface RenamedMod {
  workshopId: string
  previousName: string
  name: string
}

export interface ModUpdateCheckOutcome extends ModUpdateCheckResult {
  /** 本次按创意工坊标题修正了名称的 Mod（异常名称的来源可据此回溯） */
  renamed: RenamedMod[]
  /** 本次真正从创意工坊取到信息的 Mod 条数；为 0 且 upstreamOk=false 表示整体不可达 */
  metadataResolved: number
}

export interface ModUpdateCheckInput {
  instanceId: string
  installPath: string
  /** 为 true 时忽略「距上次检查多久」的限制，强制重新问一次 Steam */
  force?: boolean
}

type ListInstanceModsFn = typeof listInstanceMods
type UpdateInstanceModByWorkshopIdFn = typeof updateInstanceModByWorkshopId
type FetchWorkshopModMetadataFn = typeof fetchWorkshopModMetadata

let listInstanceModsFn: ListInstanceModsFn = listInstanceMods
let updateInstanceModByWorkshopIdFn: UpdateInstanceModByWorkshopIdFn = updateInstanceModByWorkshopId
let fetchWorkshopModMetadataFn: FetchWorkshopModMetadataFn = fetchWorkshopModMetadata

export function setModUpdateDbHooksForTest(hooks: {
  listInstanceMods?: ListInstanceModsFn
  updateInstanceModByWorkshopId?: UpdateInstanceModByWorkshopIdFn
  fetchWorkshopModMetadata?: FetchWorkshopModMetadataFn
}) {
  if (hooks.listInstanceMods) {
    listInstanceModsFn = hooks.listInstanceMods
  }
  if (hooks.updateInstanceModByWorkshopId) {
    updateInstanceModByWorkshopIdFn = hooks.updateInstanceModByWorkshopId
  }
  if (hooks.fetchWorkshopModMetadata) {
    fetchWorkshopModMetadataFn = hooks.fetchWorkshopModMetadata
  }
}

export function resetModUpdateDbHooksForTest() {
  listInstanceModsFn = listInstanceMods
  updateInstanceModByWorkshopIdFn = updateInstanceModByWorkshopId
  fetchWorkshopModMetadataFn = fetchWorkshopModMetadata
}

function toIsoMs(value: string | null | undefined): number | null {
  if (!value?.trim()) {
    return null
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** 版本状态判定：缺任一侧 → unknown；远端更晚 → outdated */
export function resolveModUpdateStatus(
  localUpdatedAt: string | null | undefined,
  remoteUpdatedAt: string | null | undefined,
): ModUpdateStatus {
  const localMs = toIsoMs(localUpdatedAt)
  const remoteMs = toIsoMs(remoteUpdatedAt)
  if (localMs === null || remoteMs === null) {
    return 'unknown'
  }
  return remoteMs > localMs ? 'outdated' : 'up_to_date'
}

function resolveUnknownReason(input: {
  installStatus: DbInstanceMod['installStatus']
  localUpdatedAt: string | null
  remoteUpdatedAt: string | null
  metadataKnown: boolean
}): string | null {
  if (!input.metadataKnown) {
    return '未能从创意工坊取到该 Mod 的信息，本次未改变原有状态'
  }
  if (!input.remoteUpdatedAt) {
    return '创意工坊上没有该 Mod 的版本信息，可能已下架或设为私密'
  }
  if (input.installStatus !== 'ready') {
    return 'Mod 尚未下载完成，暂不判断版本'
  }
  if (!input.localUpdatedAt) {
    return '本机找不到该 Mod 的版本记录（SteamCMD 清单与内容文件都没有），无法判断版本，可点「重新下载」重新入账'
  }
  return '本机没有该 Mod 的下载记录，无法判断版本（可重新下载）'
}

/** 游戏加载的副本比已下载内容旧：重新下载并由面板重新落位后，重启实例才会生效 */
const STALE_LOADED_COPY_REASON = '游戏实际加载的 Mod 文件比已下载内容旧（落位没有跟上），需重新下载并由面板重新落位，重启实例后生效'

/**
 * 库里存着的状态：游戏加载的副本陈旧优先于时间比较。
 *
 * 这一条必须落库（`instance_mods.loaded_copy_stale`），否则「下载目录已最新、游戏里
 * 还是旧内容」只存在于检查响应里，列表刷新后又按两个时间戳算出「已是最新」——
 * 用户会看到「发现 1 个 Mod 有新版本」却找不到任何可更新的行。
 */
export function resolveStoredModUpdateStatus(mod: Pick<DbInstanceMod, 'loadedCopyStale' | 'localUpdatedAt' | 'remoteUpdatedAt'>): ModUpdateStatus {
  if (mod.loadedCopyStale) {
    return 'outdated'
  }
  return resolveModUpdateStatus(mod.localUpdatedAt, mod.remoteUpdatedAt)
}

function buildEmptyResult(instanceId: string): ModUpdateCheckOutcome {
  return {
    instanceId,
    checkedAt: new Date().toISOString(),
    upstreamOk: true,
    message: null,
    summary: { total: 0, outdated: 0, upToDate: 0, unknown: 0 },
    items: [],
    renamed: [],
    metadataResolved: 0,
  }
}

/** 距上次检查是否仍在「不必再问 Steam」的窗口内（取全实例最近一次检查时间） */
function isCheckFresh(mods: DbInstanceMod[]): boolean {
  let latest = 0
  for (const mod of mods) {
    const checkedMs = toIsoMs(mod.updateCheckedAt)
    if (checkedMs !== null && checkedMs > latest) {
      latest = checkedMs
    }
  }
  return latest > 0 && Date.now() - latest < MOD_UPDATE_CHECK_MIN_INTERVAL_MS
}

/** 沿用库中状态（未真正问 Steam）：不重新解析磁盘凭据，也不改判 */
function buildItemsFromStoredState(mods: DbInstanceMod[]): ModUpdateInfo[] {
  return mods.map((mod) => {
    const updateStatus = resolveStoredModUpdateStatus(mod)
    return {
      workshopId: mod.workshopId,
      title: null,
      updateStatus,
      localUpdatedAt: mod.localUpdatedAt,
      remoteUpdatedAt: mod.remoteUpdatedAt,
      localVersionSource: null,
      reason: updateStatus === 'unknown'
        ? resolveUnknownReason({
            installStatus: mod.installStatus,
            localUpdatedAt: mod.localUpdatedAt,
            remoteUpdatedAt: mod.remoteUpdatedAt,
            metadataKnown: true,
          })
        : (mod.loadedCopyStale ? STALE_LOADED_COPY_REASON : null),
    }
  })
}

function summarize(items: ModUpdateInfo[]): ModUpdateCheckResult['summary'] {
  return {
    total: items.length,
    outdated: items.filter(item => item.updateStatus === 'outdated').length,
    upToDate: items.filter(item => item.updateStatus === 'up_to_date').length,
    unknown: items.filter(item => item.updateStatus === 'unknown').length,
  }
}

/**
 * 检查实例全部已订阅 Mod 的版本，并把结果、工坊标题与缩略图写回数据库。
 * Steam 取不到时保留原有状态（不写库），避免把「不知道」污染成「已是最新」。
 */
async function checkInstanceModUpdatesUnlocked(input: ModUpdateCheckInput): Promise<ModUpdateCheckOutcome> {
  const instanceId = input.instanceId.trim()
  if (!instanceId) {
    return buildEmptyResult(instanceId)
  }
  const mods = await listInstanceModsFn(instanceId)
  if (mods.length === 0) {
    return buildEmptyResult(instanceId)
  }
  if (!input.force && isCheckFresh(mods)) {
    const items = buildItemsFromStoredState(mods)
    return {
      instanceId,
      checkedAt: new Date().toISOString(),
      upstreamOk: true,
      message: null,
      summary: summarize(items),
      items,
      renamed: [],
      metadataResolved: 0,
    }
  }

  // 清单只读一次：逐个 Mod 重读重解析一份几百 KB 的 ACF 纯属浪费
  const installedItems = readWorkshopInstalledItems(input.installPath)
  const metadataResult = await fetchWorkshopModMetadataFn(mods.map(mod => mod.workshopId), {
    force: input.force === true,
  })
  const checkedAt = new Date().toISOString()
  const renamed: RenamedMod[] = []
  const items: ModUpdateInfo[] = []
  let metadataResolved = 0

  for (const mod of mods) {
    const metadata: WorkshopModMetadata | undefined = metadataResult.items.get(mod.workshopId)
    // 取不到的条目保留原值：既不改状态，也不推进检查时间
    if (!metadata) {
      const storedStatus = resolveStoredModUpdateStatus(mod)
      items.push({
        workshopId: mod.workshopId,
        title: null,
        updateStatus: storedStatus,
        localUpdatedAt: mod.localUpdatedAt,
        remoteUpdatedAt: mod.remoteUpdatedAt,
        localVersionSource: null,
        reason: storedStatus === 'unknown'
          ? resolveUnknownReason({
              installStatus: mod.installStatus,
              localUpdatedAt: mod.localUpdatedAt,
              remoteUpdatedAt: mod.remoteUpdatedAt,
              metadataKnown: false,
            })
          : (mod.loadedCopyStale ? STALE_LOADED_COPY_REASON : null),
      })
      continue
    }

    // 本机版本只认内容凭据：SteamCMD 清单优先，其次内容文件的落地时间。
    // 两者都取不到就是没有依据，绝不拿库里「记录这份内容的时间」顶上——
    // 记录时刻必然晚于当时的工坊版本，比较结果会恒定是「已是最新」。
    const localVersion = resolveLocalModContentVersion(input.installPath, mod.workshopId, { installedItems, contentSource: mod.contentSource, knownUpdatedAt: mod.localUpdatedAt })
    const localUpdatedAt = localVersion.updatedAt
    const remoteUpdatedAt = metadata.updatedAt ?? null
    // 游戏实际加载的那份比已下载内容旧：内容本身没问题，但游戏读到的仍是旧版本
    const updateStatus: ModUpdateStatus = localVersion.loadedCopyStale
      ? 'outdated'
      : resolveModUpdateStatus(localUpdatedAt, remoteUpdatedAt)
    metadataResolved += 1

    const patch: Parameters<UpdateInstanceModByWorkshopIdFn>[2] = {
      localUpdatedAt,
      remoteUpdatedAt,
      updateCheckedAt: checkedAt,
      // 必须落库：列表由库里的状态渲染，只放进本次响应会变成「说有新版本却无从更新」
      loadedCopyStale: localVersion.loadedCopyStale,
    }
    const workshopTitle = metadata?.title?.trim()
    if (workshopTitle && workshopTitle !== mod.name) {
      patch.name = workshopTitle
      renamed.push({ workshopId: mod.workshopId, previousName: mod.name, name: workshopTitle })
    }
    if (metadata?.previewImage && !mod.previewImage?.trim()) {
      patch.previewImage = metadata.previewImage
    }
    try {
      await updateInstanceModByWorkshopIdFn(instanceId, mod.workshopId, patch)
    }
    catch {
      // 单条写入失败不影响其余 Mod 的检查结果
    }

    items.push({
      workshopId: mod.workshopId,
      title: workshopTitle ?? null,
      updateStatus,
      localUpdatedAt,
      remoteUpdatedAt,
      localVersionSource: localVersion.source,
      reason: localVersion.loadedCopyStale
        ? STALE_LOADED_COPY_REASON
        : (updateStatus === 'unknown'
            ? resolveUnknownReason({
                installStatus: mod.installStatus,
                localUpdatedAt,
                remoteUpdatedAt,
                metadataKnown: true,
              })
            : null),
    })
  }

  return {
    instanceId,
    checkedAt,
    upstreamOk: metadataResult.ok,
    message: metadataResult.ok ? null : (metadataResult.message ?? '部分 Mod 未能从创意工坊取到信息'),
    summary: summarize(items),
    items,
    renamed,
    metadataResolved,
  }
}

export async function checkInstanceModUpdates(input: ModUpdateCheckInput): Promise<ModUpdateCheckOutcome> {
  return withInstanceContentActivity(input.instanceId, () => checkInstanceModUpdatesUnlocked(input))
}

/** 后台定时检查：与游戏服务端更新检查同节奏，让列表里的版本徽标平时就是新鲜的 */
export function scheduleModUpdateChecks(app: FastifyInstance) {
  if (readBrandEnv('BSP_UNIT_TEST') === '1') {
    return
  }
  const run = async () => {
    try {
      const instances = await listGameInstances({ nodeId: LOCAL_NODE_ID })
      for (const instance of instances) {
        if (instance.gameCode !== DST_APP_ID) {
          continue
        }
        const installPath = resolveInstanceInstallPath(instance)
        if (!installPath || !fs.existsSync(installPath)) {
          continue
        }
        const outcome = await checkInstanceModUpdates({ instanceId: instance.id, installPath })
        if (outcome.renamed.length > 0) {
          app.log.info({ instanceId: instance.id, renamed: outcome.renamed }, '已按创意工坊标题补齐 Mod 名称')
        }
      }
    }
    catch (error) {
      app.log.warn({ err: error }, '定时检查 Mod 更新失败')
    }
  }
  setTimeout(() => void run(), PERIODIC_FIRST_DELAY_MS)
  setInterval(() => void run(), PERIODIC_MOD_UPDATE_CHECK_MS)
}
