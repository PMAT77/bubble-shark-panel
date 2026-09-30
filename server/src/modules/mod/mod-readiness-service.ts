import { resolveModDisplayName } from '../../infra/game-adapter/dst/mod-config'
import { isDstWorkshopModPresent } from '../../infra/game-adapter/dst/mod-download'
import { ensureDstUgcModLayout } from '../../infra/game-adapter/dst/ugc-mod-install'
import { listInstanceMods, updateInstanceModByWorkshopId } from '../../shared/db/index'

/**
 * 「已就绪」必须等价于「游戏能加载」。
 *
 * 导入外部存档时源档 modoverrides.lua 只有 workshop ID，创意工坊内容未必在本机，
 * 若把这类记录直接当成就绪，面板会显示 36/36 而游戏里只加载出有文件的那几个。
 * 本模块按磁盘实际情况反向校准数据库状态：缺文件的降级为等待下载（等用户在 Mod 页
 * 点「开始下载」，由下载队列接手），落位失败的标明原因，占位名补齐为真实 Mod 名。
 */

/** 导入存档时的占位名：源档 modoverrides.lua 里没有 Mod 名称 */
const PLACEHOLDER_MOD_NAME_PATTERN = /^workshop-\d+$/i
export const MISSING_MOD_CONTENT_ERROR = '创意工坊内容缺失，未下载'

export interface ModReadinessResult {
  /** 原本显示已就绪、但本机没有创意工坊内容，已降级为等待下载 */
  demotedToPending: string[]
  /** 内容已下载但落位到 ugc_mods 失败，游戏侧加载不到 */
  markedFailed: Array<{ workshopId: string, error: string }>
  /** 占位名补齐为 modinfo.lua 中的真实名称 */
  renamed: Array<{ workshopId: string, name: string }>
}

export interface ModReadinessInput {
  instanceId: string
  installPath: string
  /**
   * true 时额外把已下载内容落位到 ugc_mods（解压/复制，可能耗时数十秒）。
   * 只在面板启动的后台任务里开启；Mod 列表请求等前台路径保持关闭。
   */
  relocate?: boolean
}

type ListInstanceModsFn = typeof listInstanceMods
type UpdateInstanceModByWorkshopIdFn = typeof updateInstanceModByWorkshopId

let listInstanceModsFn: ListInstanceModsFn = listInstanceMods
let updateInstanceModByWorkshopIdFn: UpdateInstanceModByWorkshopIdFn = updateInstanceModByWorkshopId

export function setModReadinessDbHooksForTest(hooks: {
  listInstanceMods?: ListInstanceModsFn
  updateInstanceModByWorkshopId?: UpdateInstanceModByWorkshopIdFn
}) {
  if (hooks.listInstanceMods) {
    listInstanceModsFn = hooks.listInstanceMods
  }
  if (hooks.updateInstanceModByWorkshopId) {
    updateInstanceModByWorkshopIdFn = hooks.updateInstanceModByWorkshopId
  }
}

export function resetModReadinessDbHooksForTest() {
  listInstanceModsFn = listInstanceMods
  updateInstanceModByWorkshopIdFn = updateInstanceModByWorkshopId
}

/** 判断是否为导入存档留下的占位名（workshop-<id>） */
export function isPlaceholderModName(name: string): boolean {
  return PLACEHOLDER_MOD_NAME_PATTERN.test(name.trim())
}

/** 单条状态写入失败不影响其余 Mod 的校准 */
async function patchMod(
  instanceId: string,
  workshopId: string,
  patch: Parameters<UpdateInstanceModByWorkshopIdFn>[2],
): Promise<boolean> {
  try {
    const updated = await updateInstanceModByWorkshopIdFn(instanceId, workshopId, patch)
    return Boolean(updated)
  }
  catch {
    return false
  }
}

export async function reconcileInstanceModReadiness(input: ModReadinessInput): Promise<ModReadinessResult> {
  const result: ModReadinessResult = { demotedToPending: [], markedFailed: [], renamed: [] }
  const { instanceId, installPath } = input
  if (!instanceId.trim() || !installPath.trim()) {
    return result
  }
  const readyMods = (await listInstanceModsFn(instanceId))
    .filter(mod => mod.installStatus === 'ready')
  if (readyMods.length === 0) {
    return result
  }

  // 先落位：内容已下载但没进 ugc_mods 时 DST 加载不到，不能继续显示「已就绪」
  if (input.relocate) {
    const presentMods = readyMods.filter(mod => isDstWorkshopModPresent(installPath, mod.workshopId))
    if (presentMods.length > 0) {
      const outcomes = await ensureDstUgcModLayout(installPath, presentMods.map(mod => mod.workshopId))
      for (const outcome of outcomes) {
        if (outcome.status !== 'failed') {
          continue
        }
        const error = outcome.error ?? 'Mod 文件未能安装到服务器目录'
        if (await patchMod(instanceId, outcome.workshopId, { installStatus: 'failed', installError: error })) {
          result.markedFailed.push({ workshopId: outcome.workshopId, error })
        }
      }
    }
  }

  const failedIds = new Set(result.markedFailed.map(item => item.workshopId))
  for (const mod of readyMods) {
    if (failedIds.has(mod.workshopId)) {
      continue
    }
    if (!isDstWorkshopModPresent(installPath, mod.workshopId)) {
      const demoted = await patchMod(instanceId, mod.workshopId, {
        installStatus: 'pending',
        installError: MISSING_MOD_CONTENT_ERROR,
      })
      if (demoted) {
        result.demotedToPending.push(mod.workshopId)
      }
      continue
    }
    if (!isPlaceholderModName(mod.name)) {
      continue
    }
    const displayName = resolveModDisplayName(installPath, mod.workshopId)
    // 名字没变就不写库：Mod 列表会被反复请求，无变化的同步写会白占事件循环
    if (displayName && displayName !== mod.name && await patchMod(instanceId, mod.workshopId, { name: displayName })) {
      result.renamed.push({ workshopId: mod.workshopId, name: displayName })
    }
  }
  return result
}
