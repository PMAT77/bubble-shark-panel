import fs from 'node:fs'
import { assertInstanceRuntimeStopped } from '../../infra/container/instance-stopped'
import path from 'node:path'
import type { DbGameInstance } from '../../shared/db/types'
import type { ImportSaveToInstanceOptions, ImportSaveToInstanceResult } from './import-service'
import { resolveTargetShardPorts, rewriteStagedServerIni, alignClusterOwnership } from './import-service'
import { readMigrationBundle } from '../../infra/game-adapter/dst/migration-bundle'
import { resolveClusterPaths } from '../../infra/game-adapter/dst/cluster-service'
import { DST_STORAGE_DIR, DST_CONF_DIR, DST_CLUSTER_NAME, resolveDstSteamWorkshopModDir } from '../../infra/game-adapter/dst/constants'
import { resolveDstLegacyModDir, resolveDstUgcModDir, type DstShardFolder } from '../../infra/game-adapter/dst/ugc-mod-install'
import { prepareDstModContent } from '../../infra/game-adapter/dst/mod-content-install'
import { inspectContentTree, assertFreeSpace } from '../../infra/game-adapter/dst/mod-content'
import { parseStoredModConfig } from '../../infra/game-adapter/dst/mod-config'
import { writeInstanceModFiles, writeModDependencyMap } from '../../infra/game-adapter/dst/mod-service'
import { markPanelRoomSaved, markPanelMasterWorldSaved } from '../../infra/game-adapter/dst/panel-config-meta'
import { readClusterTokenFile, validateClusterToken, writeClusterTokenFile } from '../../infra/game-adapter/dst/cluster-token'
import { beginContentTransaction, makeModRecord, protectModConfiguration, rollbackContentSnapshot } from '../../shared/instance-content/state'
import { markContentRecoveryFailed } from '../../shared/instance-content/operation'
import { listInstanceMods, replaceInstanceModRecords } from '../../shared/db/index'
import { createInstanceBackupUnlocked } from './backup-service'

/** 已持有实例独占锁；全部校验先于旧数据替换，禁止在线补齐。 */
export async function importMigrationBundle(options: ImportSaveToInstanceOptions, instance: DbGameInstance, installPath: string, bundle: NonNullable<Awaited<ReturnType<typeof readMigrationBundle>>>): Promise<ImportSaveToInstanceResult> {
  const { instanceId } = options
  await assertInstanceRuntimeStopped(instanceId)
  const source = options.sourceClusterPath
  const { clusterRoot } = resolveClusterPaths(installPath)
  const warnings: string[] = []
  const world = await inspectContentTree(source)
  const modBytes = bundle.manifest.mods.reduce((sum, mod) => sum + (mod.content?.sizeBytes ?? 0), 0)
  assertFreeSpace(installPath, world.sizeBytes * 3 + modBytes * 4)
  const provided = options.clusterToken?.trim()
  if (provided && validateClusterToken(provided)) throw new Error(validateClusterToken(provided)!)
  let safetyBackupId: string | undefined
  if (fs.existsSync(path.join(installPath, DST_STORAGE_DIR))) {
    const safety = await createInstanceBackupUnlocked({ app: options.app, instanceId, kind: 'pre_import', note: `导入 ${options.sourceLabel || path.basename(source)} 前的自动安全备份`, createdBy: options.createdBy ?? '', saveBeforeArchive: false })
    if (!safety.ok || !safety.backup) throw new Error(safety.message ?? '安全备份失败')
    safetyBackupId = safety.backup.id
  }
  const transaction = await beginContentTransaction(instanceId, installPath)
  try {
    const stagedInstall = path.join(transaction.root, 'world')
    const stagedCluster = path.join(stagedInstall, DST_STORAGE_DIR, DST_CONF_DIR, DST_CLUSTER_NAME)
    await fs.promises.cp(source, stagedCluster, { recursive: true, preserveTimestamps: true })
    const ports = resolveTargetShardPorts(instance, installPath)
    const importedShards: Array<'master' | 'caves'> = []
    if (rewriteStagedServerIni(stagedCluster, 'Master', ports.master)) importedShards.push('master')
    if (rewriteStagedServerIni(stagedCluster, 'Caves', ports.caves)) importedShards.push('caves')
    const token = path.join(stagedCluster, 'cluster_token.txt')
    const existing = readClusterTokenFile(path.join(clusterRoot, 'cluster_token.txt'))
    let tokenSource: 'provided' | 'existing' | 'source' | 'none' = 'none'
    if (provided) { writeClusterTokenFile(token, provided); tokenSource = 'provided' }
    else if (existing && !validateClusterToken(existing)) { writeClusterTokenFile(token, existing); tokenSource = 'existing' }
    else if (fs.existsSync(token)) tokenSource = 'source'
    if (tokenSource === 'none') warnings.push('未配置 Klei 集群令牌，公网游玩需在房间设置补填')
    markPanelRoomSaved(stagedInstall)
    markPanelMasterWorldSaved(stagedInstall)
    const mods = bundle.manifest.mods.map(mod => makeModRecord(instanceId, mod.workshopId, {
      name: mod.name, enabled: mod.enabled, loadOrder: mod.loadOrder, version: mod.version,
      config: JSON.stringify(mod.configurationOptions), contentSource: 'migration',
      localUpdatedAt: mod.content ? mod.localUpdatedAt : null,
      installStatus: mod.content ? 'ready' : 'pending', installError: mod.content ? null : '迁移包未包含该 Mod 文件，请手动补齐',
    }))
    const shards: DstShardFolder[] = fs.existsSync(path.join(stagedCluster, 'Caves', 'server.ini')) ? ['Master', 'Caves'] : ['Master']
    const included = new Set(bundle.manifest.mods.filter(mod => mod.content).map(mod => mod.workshopId))
    const previous = await listInstanceMods(instanceId)
    for (const id of new Set([...previous.map(mod => mod.workshopId), ...mods.map(mod => mod.workshopId)])) {
      if (included.has(id)) continue
      for (const target of [resolveDstSteamWorkshopModDir(installPath, id), resolveDstLegacyModDir(installPath, id), resolveDstUgcModDir(installPath, 'Master', id), resolveDstUgcModDir(installPath, 'Caves', id)]) transaction.remove(target)
    }
    for (const mod of bundle.manifest.mods.filter(item => item.content)) {
      await prepareDstModContent(transaction, installPath, mod.workshopId, path.join(bundle.modRoot, mod.workshopId), { shardFolders: shards })
    }
    await transaction.prepareDirectory(stagedCluster, clusterRoot)
    transaction.apply()
    protectModConfiguration(transaction, installPath)
    writeModDependencyMap(installPath, Object.fromEntries(bundle.manifest.mods.map(mod => [mod.workshopId, mod.dependencyIds])), false)
    writeInstanceModFiles(installPath, mods.filter(mod => mod.installStatus === 'ready').map(mod => ({ workshopId: mod.workshopId, enabled: mod.enabled, loadOrder: mod.loadOrder, configurationOptions: parseStoredModConfig(mod.config) })), { backup: false })
    alignClusterOwnership(clusterRoot)
    const gamePortSynced = instance.gamePort !== null && instance.gamePort !== ports.master.serverPort
    replaceInstanceModRecords(instanceId, mods, gamePortSynced ? ports.master.serverPort : undefined)
    transaction.commit()
    const missingWorkshopContent = mods.filter(mod => mod.installStatus === 'pending').map(mod => mod.workshopId)
    if (missingWorkshopContent.length) warnings.push(`${missingWorkshopContent.length} 个 Mod 只恢复了配置，请在 Mod 页手动补齐文件`)
    return { ok: true, result: { importedShards, modCount: mods.length, missingWorkshopContent, tokenSource, safetyBackupId, gamePortSynced, warnings } }
  }
  catch (error) {
    try { transaction.rollback(rollbackContentSnapshot) }
    catch (rollbackError) { markContentRecoveryFailed(instanceId, true); throw new Error(`迁移失败且回滚未完成，请重启面板恢复：${String(rollbackError)}`) }
    throw error
  }
}
