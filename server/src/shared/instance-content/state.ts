import type { FastifyInstance } from 'fastify'
import type { DbInstanceMod } from '../db/types'
import { getGameInstanceById, listGameInstances, listInstanceMods, replaceInstanceModRecords } from '../db/index'
import { ContentTransaction, recoverContentTransaction } from '../../infra/backup/content-transaction'
import { resolveClusterPaths, resolveInstanceInstallPath } from '../../infra/game-adapter/dst/cluster-service'
import { markContentRecoveryFailed } from './operation'
import path from 'node:path'
import { GSH_WORLD_SEED_MOD_ID, resolveWorldSeedModDir } from '../../infra/game-adapter/dst/world-seed'
import { resolveDstLegacyModDir } from '../../infra/game-adapter/dst/ugc-mod-install'

export interface ContentSnapshot { instanceId: string, mods: DbInstanceMod[], gamePort: number | null }

export async function beginContentTransaction(instanceId: string, installPath: string): Promise<ContentTransaction<ContentSnapshot>> {
  const instance = await getGameInstanceById(instanceId)
  if (!instance) throw new Error('实例不存在')
  return new ContentTransaction(installPath, { instanceId, mods: await listInstanceMods(instanceId), gamePort: instance.gamePort })
}

export function rollbackContentSnapshot(snapshot: ContentSnapshot | null): void {
  if (snapshot) replaceInstanceModRecords(snapshot.instanceId, snapshot.mods, snapshot.gamePort)
}

export async function recoverInstanceContentOperations(app?: Pick<FastifyInstance, 'log'>): Promise<void> {
  for (const instance of await listGameInstances({ nodeId: 'local-node' })) {
    const installPath = resolveInstanceInstallPath(instance)
    try {
      if (recoverContentTransaction<ContentSnapshot | null>(installPath, rollbackContentSnapshot)) {
        app?.log.info({ instanceId: instance.id }, '已恢复中断的内容操作')
      }
      markContentRecoveryFailed(instance.id, false)
    }
    catch (error) {
      markContentRecoveryFailed(instance.id, true)
      if (app) app.log.error({ instanceId: instance.id, error }, '内容操作恢复失败，实例已禁止启动；请保留事务目录并修复文件权限或日志')
      else console.error(`实例 ${instance.id} 内容恢复失败，禁止启动；请保留事务目录：`, error)
    }
  }
}

export function protectModConfiguration<T>(transaction: ContentTransaction<T>, installPath: string): void {
  const { clusterRoot } = resolveClusterPaths(installPath)
  for (const target of [
    path.join(installPath, 'mods', 'dedicated_server_mods_setup.lua'),
    path.join(clusterRoot, 'dedicated_server_mods_setup.lua'),
    path.join(clusterRoot, '.gsh-mod-meta.json'),
    path.join(clusterRoot, 'Master', 'modoverrides.lua'),
    path.join(clusterRoot, 'Caves', 'modoverrides.lua'),
  ]) transaction.protect(target)
  for (const target of [resolveWorldSeedModDir(installPath, 'Master'), resolveWorldSeedModDir(installPath, 'Caves'), resolveDstLegacyModDir(installPath, GSH_WORLD_SEED_MOD_ID)]) transaction.protect(target)
}

export function makeModRecord(instanceId: string, workshopId: string, values: Partial<DbInstanceMod> = {}): DbInstanceMod {
  const now = new Date().toISOString()
  return {
    id: `${instanceId}:${workshopId}`, instanceId, workshopId, name: `workshop-${workshopId}`,
    previewImage: null, enabled: false, loadOrder: 0, version: null, contentSource: 'steam',
    installStatus: 'pending', installError: null, localUpdatedAt: null, remoteUpdatedAt: null,
    updateCheckedAt: null, loadedCopyStale: false, config: null, retryCount: 0, nextRetryAt: null,
    createdAt: now, updatedAt: now, ...values,
  }
}
