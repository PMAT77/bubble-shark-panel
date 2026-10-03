import fs from 'node:fs'
import path from 'node:path'
import { ContentTransaction } from '../../backup/content-transaction'
import { assertFreeSpace, assertWorkshopId, inspectContentTree } from './mod-content'
import { resolveDstSteamWorkshopModDir } from './constants'
import { resolveDstLegacyModDir, resolveDstUgcModDir, resolveDstUgcShardFolders, writeDstLegacyCopyRecord, type DstShardFolder } from './ugc-mod-install'

/** 为本地、Steam 与迁移准备相同的加载布局，正式替换由外层事务统一执行。 */
export async function prepareDstModContent<T>(transaction: ContentTransaction<T>, installPath: string, workshopId: string, sourceDir: string, options: { shardFolders?: DstShardFolder[], copySource?: boolean } = {}): Promise<void> {
  assertWorkshopId(workshopId)
  const tree = await inspectContentTree(sourceDir, { requireModInfo: true })
  const shards = options.shardFolders ?? resolveDstUgcShardFolders(installPath)
  assertFreeSpace(installPath, tree.sizeBytes * (shards.length + 2))
  const canonical = resolveDstSteamWorkshopModDir(installPath, workshopId)
  const preparedDirectories: string[] = []
  if (options.copySource !== false && path.resolve(sourceDir) !== path.resolve(canonical)) {
    preparedDirectories.push(await transaction.prepareDirectory(sourceDir, canonical))
  }
  const preparedShards = new Map<DstShardFolder, string>()
  for (const shard of shards) {
    const prepared = await transaction.prepareDirectory(sourceDir, resolveDstUgcModDir(installPath, shard, workshopId))
    preparedDirectories.push(prepared)
    preparedShards.set(shard, prepared)
  }
  // 清掉未配置分片的旧副本，日后启用洞穴时从规范化来源补建。
  for (const shard of ['Master', 'Caves'] as const) {
    if (!shards.includes(shard)) transaction.remove(resolveDstUgcModDir(installPath, shard, workshopId))
  }
  const legacy = resolveDstLegacyModDir(installPath, workshopId)
  const first = resolveDstUgcModDir(installPath, shards[0] ?? 'Master', workshopId)
  try {
    transaction.prepareLink(first, legacy)
  }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    const prepared = await transaction.prepareDirectory(sourceDir, legacy)
    preparedDirectories.push(prepared)
    writeDstLegacyCopyRecord(prepared, first, fs.statSync(preparedShards.get(shards[0] ?? 'Master')!).mtimeMs)
  }
  // 使用实例目录的所有者，包内 uid/mode 不参与生产运行时权限。
  if (process.platform !== 'win32') {
    const { uid, gid } = fs.statSync(installPath)
    const align = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name)
        if (entry.isSymbolicLink()) continue
        fs.chmodSync(file, entry.isDirectory() ? 0o755 : 0o644)
        try { fs.chownSync(file, uid, gid) } catch { /* unprivileged same-owner deployment */ }
        if (entry.isDirectory()) align(file)
      }
    }
    for (const directory of preparedDirectories) {
      fs.chmodSync(directory, 0o755)
      try { fs.chownSync(directory, uid, gid) } catch { /* same-owner deployment */ }
      align(directory)
    }
  }
}
