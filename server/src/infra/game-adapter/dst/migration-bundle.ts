import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { migrationManifestSchema, type MigrationMod, type MigrationManifest, type MigrationContentSummary } from '../../../../../shared/contracts/migration'
import { createArchiveFromEntries, DEFAULT_TAR_EXTRACT_LIMITS, extractArchive } from '../../backup/archive'
import { resolveMaxUploadBytes } from '../../backup/upload'
import { assertFreeSpace, inspectContentTree, type ContentTree } from './mod-content'
import { readLocalModInfo } from './mod-config'
import { resolveDstLegacyModDir, resolveDstUgcModDir, resolveDstUgcShardFolders } from './ugc-mod-install'
import { resolveDstSteamWorkshopModDir } from './constants'
import { isWorldSeedModId } from './world-seed'

export const MIGRATION_META_DIRECTORY = '.gsh-migration'
export function requiredMigrationMods(mods: MigrationMod[]): Set<string> {
  const byId = new Map(mods.map(mod => [mod.workshopId, mod]))
  const required = new Set<string>()
  const visit = (id: string) => {
    if (required.has(id)) return
    required.add(id)
    for (const dependency of byId.get(id)?.dependencyIds ?? []) visit(dependency)
  }
  for (const mod of mods.filter(item => item.enabled)) visit(mod.workshopId)
  return required
}

/** 加载入口优先；外部链接和不同副本不能被静默打包为完整迁移。 */
export async function resolveInstanceMigrationModSource(installPath: string, id: string): Promise<string | null> {
  const legacy = resolveDstLegacyModDir(installPath, id)
  const candidates = [legacy, ...resolveDstUgcShardFolders(installPath).map(shard => resolveDstUgcModDir(installPath, shard, id)), resolveDstSteamWorkshopModDir(installPath, id)]
  let source: string | null = null
  let expected: string | null = null
  const seen = new Set<string>()
  for (const candidate of candidates) {
    let real: string
    try { real = fs.realpathSync(candidate) }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue; throw error }
    const rel = path.relative(fs.realpathSync(installPath), real)
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Mod ${id} 的内容链接指向实例外部`)
    if (seen.has(real) || !fs.existsSync(path.join(real, 'modinfo.lua'))) continue
    seen.add(real)
    // Steam 原始 legacy 下载包属于下载凭据；比较解包后的实际加载文件。
    const tree = await inspectContentTree(real, { requireModInfo: true, ignoreSteamArchives: candidate === resolveDstSteamWorkshopModDir(installPath, id) })
    if (expected && expected !== tree.sha256) throw new Error(`Mod ${id} 的加载目录与下载/UGC 内容不一致，请先修复或重新安装`)
    expected = tree.sha256
    source ??= real
  }
  return source
}

export interface InspectedMigrationContent {
  mods: MigrationMod[]
  sources: Map<string, { directory: string, tree: ContentTree }>
  summary: MigrationContentSummary
}
export async function inspectMigrationContents(input: MigrationMod[], includeMods: boolean, resolveSource: (id: string) => Promise<string | null>): Promise<InspectedMigrationContent> {
  const mods = input.map(mod => ({ ...mod, dependencyIds: [...mod.dependencyIds], content: null })) as MigrationMod[]
  const sources = new Map<string, { directory: string, tree: ContentTree }>()
  if (includeMods) {
    for (let index = 0; index < mods.length; index += 1) {
      const mod = mods[index]!
      if (mods.length > 10_000) throw new Error('Mod 数量超过迁移上限')
      const directory = await resolveSource(mod.workshopId)
      if (directory) {
        const tree = await inspectContentTree(directory, { requireModInfo: true })
        sources.set(mod.workshopId, { directory, tree })
        const info = readLocalModInfo(path.join(directory, 'modinfo.lua'))
        mod.dependencyIds = [...new Set([...mod.dependencyIds, ...info.dependencyIds])]
        mod.content = { sizeBytes: tree.sizeBytes, fileCount: tree.fileCount, sha256: tree.sha256, hashAlgorithm: 'sha256-tree-v1' }
      }
      for (const id of mod.dependencyIds) {
        if (!mods.some(item => item.workshopId === id)) mods.push({ workshopId: id, name: `workshop-${id}`, enabled: false, loadOrder: mods.length, configurationOptions: {}, dependencyIds: [], version: null, localUpdatedAt: null, content: null })
      }
    }
  }
  const required = requiredMigrationMods(mods)
  const missingRequiredMods = includeMods ? [...required].filter(id => !sources.has(id)) : []
  const missingOptionalMods = includeMods ? mods.filter(mod => !required.has(mod.workshopId) && !sources.has(mod.workshopId)).map(mod => mod.workshopId) : []
  return { mods, sources, summary: { includedModCount: sources.size, estimatedContentBytes: [...sources.values()].reduce((sum, item) => sum + item.tree.sizeBytes, 0), missingRequiredMods, missingOptionalMods, canExport: missingRequiredMods.length === 0 } }
}

export async function writeMigrationBundle(options: { clusterPath: string, archivePath: string, reportText: string, inspected: InspectedMigrationContent, includeMods: boolean }): Promise<MigrationManifest> {
  const { inspected, clusterPath, archivePath } = options
  if (!inspected.summary.canExport) throw new Error(`缺少必需 Mod 文件：${inspected.summary.missingRequiredMods.join('、')}`)
  const clusterTree = await inspectContentTree(clusterPath)
  const bytes = clusterTree.sizeBytes + inspected.summary.estimatedContentBytes
  const entries = clusterTree.fileCount + [...inspected.sources.values()].reduce((sum, item) => sum + item.tree.fileCount, 0)
  if (bytes + entries * 1024 + 1024 * 1024 > DEFAULT_TAR_EXTRACT_LIMITS.maxTotalUncompressedBytes || entries + inspected.mods.length * 10 + 32 > DEFAULT_TAR_EXTRACT_LIMITS.maxEntries) throw new Error('迁移内容超过存档导入上限，请减少内容后重试')
  const outputRoot = path.dirname(archivePath)
  fs.mkdirSync(outputRoot, { recursive: true })
  assertFreeSpace(outputRoot, bytes * 2 + entries * 1024)
  assertFreeSpace(clusterPath, 0)
  const root = fs.mkdtempSync(path.join(outputRoot, '.migration-staging-'))
  const partial = `${archivePath}.partial-${randomUUID()}`
  try {
    const clusterDirectory = path.basename(clusterPath)
    await fs.promises.cp(clusterPath, path.join(root, clusterDirectory), { recursive: true, preserveTimestamps: true })
    const copiedCluster = await inspectContentTree(path.join(root, clusterDirectory))
    if (copiedCluster.sha256 !== clusterTree.sha256 || (await inspectContentTree(clusterPath)).sha256 !== clusterTree.sha256) throw new Error('导出期间存档发生变化，请停止源服务器后重试')
    const meta = path.join(root, MIGRATION_META_DIRECTORY)
    fs.mkdirSync(meta, { recursive: true, mode: 0o700 })
    for (const [id, source] of inspected.sources) {
      const target = path.join(meta, 'mods', id)
      await fs.promises.cp(source.directory, target, { recursive: true, preserveTimestamps: true, filter: file => path.basename(file) !== '.gsh-legacy-copy.json' })
      if ((await inspectContentTree(target)).sha256 !== source.tree.sha256 || (await inspectContentTree(source.directory)).sha256 !== source.tree.sha256) throw new Error(`导出期间 Mod ${id} 发生变化，请重试`)
    }
    const manifest = migrationManifestSchema.parse({ formatVersion: 1, game: 'dont-starve-together', clusterDirectory, includeMods: options.includeMods, mods: inspected.mods })
    fs.writeFileSync(path.join(meta, 'manifest.json'), JSON.stringify(manifest, null, 2))
    fs.writeFileSync(path.join(meta, 'report.txt'), options.reportText)
    await createArchiveFromEntries(root, [clusterDirectory, MIGRATION_META_DIRECTORY], partial)
    if (fs.statSync(partial).size > resolveMaxUploadBytes()) throw new Error('迁移包超过存档上传上限，请减少内容后重试')
    await extractArchive(partial, path.join(root, 'validation'), DEFAULT_TAR_EXTRACT_LIMITS, true)
    fs.renameSync(partial, archivePath)
    return manifest
  }
  finally { fs.rmSync(partial, { force: true }); fs.rmSync(root, { recursive: true, force: true }) }
}

export async function readMigrationBundle(clusterPath: string): Promise<{ manifest: MigrationManifest, modRoot: string } | null> {
  const meta = path.join(path.dirname(clusterPath), MIGRATION_META_DIRECTORY)
  if (!fs.existsSync(meta)) return null
  const file = path.join(meta, 'manifest.json')
  if (!fs.existsSync(file) || fs.statSync(file).size > 16 * 1024 ** 2) throw new Error('迁移 manifest 缺失或过大')
  const parsed = migrationManifestSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')))
  if (!parsed.success) throw new Error(`迁移格式不兼容或元数据无效：${parsed.error.issues.map(issue => issue.message).join('；')}`)
  const manifest = parsed.data
  if (manifest.mods.some(mod => isWorldSeedModId(mod.workshopId) || mod.dependencyIds.some(isWorldSeedModId))) throw new Error('迁移包不能包含面板内置 Mod 保留 ID')
  if (manifest.clusterDirectory !== path.basename(clusterPath)) throw new Error('迁移 manifest 与所选集群不匹配')
  const modRoot = path.join(meta, 'mods')
  const declared = new Set(manifest.mods.filter(mod => mod.content).map(mod => mod.workshopId))
  if (fs.existsSync(modRoot) && fs.readdirSync(modRoot).some(id => !declared.has(id))) throw new Error('迁移包包含未声明的 Mod 文件')
  for (const mod of manifest.mods) {
    if (!mod.content) continue
    const tree = await inspectContentTree(path.join(modRoot, mod.workshopId), { requireModInfo: true })
    if (tree.sha256 !== mod.content.sha256 || tree.sizeBytes !== mod.content.sizeBytes || tree.fileCount !== mod.content.fileCount) throw new Error(`Mod ${mod.workshopId} 内容完整性校验失败`)
    const info = readLocalModInfo(path.join(modRoot, mod.workshopId, 'modinfo.lua'))
    if (info.dependencyIds.some(id => !mod.dependencyIds.includes(id))) throw new Error(`Mod ${mod.workshopId} 的依赖清单不完整`)
  }
  return { manifest, modRoot }
}

/** 发现元数据即按迁移包处理，禁止因包装位置错误退回普通存档。 */
export function assertMigrationBundleLayout(root: string, clusterPaths: string[]): void {
  const parents = new Set(clusterPaths.map(file => path.dirname(file)))
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === MIGRATION_META_DIRECTORY) {
        if (!entry.isDirectory() || !parents.has(directory)) throw new Error('迁移元数据与集群目录位置不匹配，请重新导出')
      }
      else if (entry.isDirectory()) walk(path.join(directory, entry.name))
    }
  }
  walk(root)
}
