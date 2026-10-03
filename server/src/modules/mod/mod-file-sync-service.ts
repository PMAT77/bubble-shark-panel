import fs from 'node:fs'
import { hasContentRecoveryFailure, withInstanceContentActivity } from '../../shared/instance-content/operation'
import { DST_APP_ID } from '../../infra/game-adapter/dst/constants'
import { resolveInstanceInstallPath } from '../../infra/game-adapter/dst/cluster-service'
import { writeInstanceModFiles } from '../../infra/game-adapter/dst/mod-service'
import { parseStoredModConfig } from '../../infra/game-adapter/dst/mod-config'
import { ensureDstUgcModLayout } from '../../infra/game-adapter/dst/ugc-mod-install'
import { LOCAL_NODE_ID } from '../../shared/dst/local-dst-instance'
import { listGameInstances, listReadyInstanceMods } from '../../shared/db/index'

type ListReadyInstanceModsFn = typeof listReadyInstanceMods

let listReadyInstanceModsFn: ListReadyInstanceModsFn = listReadyInstanceMods

export function setModFileSyncDbHooksForTest(hooks: {
  listReadyInstanceMods?: ListReadyInstanceModsFn
}) {
  if (hooks.listReadyInstanceMods) {
    listReadyInstanceModsFn = hooks.listReadyInstanceMods
  }
}

export function resetModFileSyncDbHooksForTest() {
  listReadyInstanceModsFn = listReadyInstanceMods
}

/** 将 DB 中已就绪的 Mod 写回实例安装目录（Lua / setup 文件） */
export async function syncInstanceModFilesFromDbUnlocked(instanceId: string, installPath: string) {
  if (!installPath || !fs.existsSync(installPath)) {
    return
  }
  const mods = await listReadyInstanceModsFn(instanceId)
  // DST 专用服只从 ugc_mods 读取创意工坊 Mod，先落位再写 Lua。
  // 落位失败不阻断 Lua 写入，避免 Mod 从 modoverrides.lua 里整条消失。
  try {
    await ensureDstUgcModLayout(installPath, mods.map(mod => mod.workshopId))
  }
  catch {
    // best-effort：面板启动自愈与下载流程会分别上报失败
  }
  writeInstanceModFiles(installPath, mods.map(mod => ({
    workshopId: mod.workshopId,
    enabled: mod.enabled,
    loadOrder: mod.loadOrder,
    configurationOptions: parseStoredModConfig(mod.config),
  })))
}
export async function syncInstanceModFilesFromDb(instanceId: string, installPath: string) {
  return withInstanceContentActivity(instanceId, () => syncInstanceModFilesFromDbUnlocked(instanceId, installPath))
}

/** 迁移或面板启动后：同步所有本地 DST 实例的 Mod 配置 */
export async function syncAllLocalDstInstanceModFilesFromDb() {
  const instances = await listGameInstances({ nodeId: LOCAL_NODE_ID })
  for (const instance of instances) {
    if (instance.gameCode !== DST_APP_ID || hasContentRecoveryFailure(instance.id)) {
      continue
    }
    const installPath = resolveInstanceInstallPath(instance)
    await syncInstanceModFilesFromDb(instance.id, installPath)
  }
}
