import fs from 'node:fs'
import path from 'node:path'
import { backupFile, writeFileAtomic } from './atomic-write'
import { ensureClusterDirectory, resolveClusterPaths } from './cluster-service'
import { buildLuaConfigurationOptionsInline, parseModInfoDependencies } from './mod-config'
import { readWorldSeeds } from './panel-config-meta'
import { resolveDstUgcShardFolders, type DstShardFolder } from './ugc-mod-install'
import { ensureWorldSeedModLayout, SHARD_ID_BY_FOLDER, toWorldSeedModName } from './world-seed'

const MOD_SETUP_FILE_NAME = 'dedicated_server_mods_setup.lua'
const MOD_OVERRIDES_FILE_NAME = 'modoverrides.lua'
const MOD_META_FILE_NAME = '.bsp-mod-meta.json'

export interface DstModEntry {
  workshopId: string
  enabled: boolean
  loadOrder: number
  /** modoverrides.lua 的 configuration_options；空/undefined 不输出该字段 */
  configurationOptions?: Record<string, string | number | boolean> | null
}

export type DstModDependencyMap = Record<string, string[]>

function toWorkshopKey(workshopId: string) {
  return `workshop-${workshopId}`
}

function normalizeDependencyIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const unique = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') {
      continue
    }
    const normalized = item.trim()
    if (normalized) {
      unique.add(normalized)
    }
  }
  return [...unique]
}

function buildModSetupContent(mods: DstModEntry[]): string {
  const lines = mods
    // 只列启用的 Mod：这份文件决定 DST 启动时自行去工坊拉哪些内容，
    // 列出被禁用的 Mod 等于让游戏绕开面板队列去下载（国内网络下表现为卡启动）。
    .filter(mod => mod.enabled)
    .map(mod => mod.workshopId.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'en'))
    .map(workshopId => `ServerModSetup("${workshopId}")`)
  return `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`
}

function buildModOverridesContent(mods: DstModEntry[], extraRows: string[] = []): string {
  const sorted = [...mods]
    .filter(mod => mod.workshopId.trim())
    .sort((a, b) => a.loadOrder - b.loadOrder || a.workshopId.localeCompare(b.workshopId, 'en'))
  const rows = sorted.map((mod) => {
    const configInline = buildLuaConfigurationOptionsInline(mod.configurationOptions ?? {})
    return `  ["${toWorkshopKey(mod.workshopId)}"]={ enabled=${mod.enabled ? 'true' : 'false'}${configInline} },`
  })
  const allRows = [...rows, ...extraRows]
  if (allRows.length === 0) {
    return 'return {}\n'
  }
  return ['return {', ...allRows, '}'].join('\n') + '\n'
}

/**
 * 世界种子由面板内置 Mod 承载，这里只负责按分片注入启用条目。
 * 它不进 dedicated_server_mods_setup.lua：那个文件是给 SteamCMD 拉取创意工坊内容用的，
 * 内置 Mod 的文件由面板自己落位，列进去只会让游戏去工坊找一份并不存在的 Mod。
 */
function buildWorldSeedModRow(seed: string): string {
  return `  ["${toWorldSeedModName()}"]={ enabled=true${buildLuaConfigurationOptionsInline({ seed })} },`
}

function writeModOverridesByShard(
  installPath: string,
  buildContent: (shardFolder: DstShardFolder) => string,
  backup = true,
) {
  const { clusterRoot } = resolveClusterPaths(installPath)
  const masterDir = path.join(clusterRoot, 'Master')
  const cavesDir = path.join(clusterRoot, 'Caves')
  fs.mkdirSync(masterDir, { recursive: true })
  fs.mkdirSync(cavesDir, { recursive: true })
  const masterModOverridesPath = path.join(masterDir, MOD_OVERRIDES_FILE_NAME)
  if (backup) backupFile(masterModOverridesPath)
  writeFileAtomic(masterModOverridesPath, buildContent('Master'))
  const cavesModOverridesPath = path.join(cavesDir, MOD_OVERRIDES_FILE_NAME)
  if (backup) backupFile(cavesModOverridesPath)
  writeFileAtomic(cavesModOverridesPath, buildContent('Caves'))
}

function writeDedicatedServerModSetup(installPath: string, content: string, backup = true) {
  const modsDir = path.join(installPath, 'mods')
  fs.mkdirSync(modsDir, { recursive: true })
  const legacyPath = path.join(modsDir, MOD_SETUP_FILE_NAME)
  if (backup) backupFile(legacyPath)
  writeFileAtomic(legacyPath, content)
}

function writeClusterModSetup(installPath: string, content: string, backup = true) {
  const { clusterRoot } = resolveClusterPaths(installPath)
  const clusterSetupPath = path.join(clusterRoot, MOD_SETUP_FILE_NAME)
  if (backup) backupFile(clusterSetupPath)
  writeFileAtomic(clusterSetupPath, content)
}

function resolveModMetaPath(installPath: string): string {
  const { clusterRoot } = resolveClusterPaths(installPath)
  return path.join(clusterRoot, MOD_META_FILE_NAME)
}

export function readModDependencyMap(installPath: string): DstModDependencyMap {
  const modMetaPath = resolveModMetaPath(installPath)
  if (!fs.existsSync(modMetaPath)) {
    return {}
  }
  try {
    const raw = JSON.parse(fs.readFileSync(modMetaPath, 'utf8')) as Record<string, unknown>
    const map: DstModDependencyMap = {}
    for (const [workshopId, dependencyIds] of Object.entries(raw)) {
      const normalizedWorkshopId = workshopId.trim()
      if (!normalizedWorkshopId) {
        continue
      }
      map[normalizedWorkshopId] = normalizeDependencyIds(dependencyIds)
    }
    return map
  }
  catch {
    return {}
  }
}

export function writeModDependencyMap(installPath: string, dependencyMap: DstModDependencyMap, backup = true) {
  const modMetaPath = resolveModMetaPath(installPath)
  if (backup) backupFile(modMetaPath)
  writeFileAtomic(modMetaPath, `${JSON.stringify(dependencyMap, null, 2)}\n`)
}

/**
 * 该 Mod 在本地可得的依赖：面板自己记录的（订阅时写入 `.bsp-mod-meta.json`）
 * 加上内容里 `modinfo.lua` 声明的。
 *
 * 下载队列用它把启用项的必要依赖一起排进队列。两处都取不到就是空——内容缺失的 Mod
 * 没有 modinfo.lua 可读，此时不为此去打 Steam 接口。
 */
export function readModDependencies(
  installPath: string,
  workshopId: string,
  dependencyMap: DstModDependencyMap = readModDependencyMap(installPath),
): string[] {
  const fromMeta = normalizeDependencyIds(dependencyMap[workshopId] ?? [])
  const fromModInfo = parseModInfoDependencies(installPath, workshopId)
  return [...new Set([...fromMeta, ...fromModInfo])]
}

export function writeInstanceModFiles(installPath: string, mods: DstModEntry[], options: { backup?: boolean } = {}) {
  ensureClusterDirectory(installPath)
  const modSetupContent = buildModSetupContent(mods)
  // DST 会从安装根目录 mods/dedicated_server_mods_setup.lua 读取订阅列表。
  writeDedicatedServerModSetup(installPath, modSetupContent, options.backup)
  // 兼容已有目录结构，继续同步到 Cluster 根目录，便于历史数据排查。
  writeClusterModSetup(installPath, modSetupContent, options.backup)
  // 世界种子（面板内置 Mod）：先落位文件、再按分片注入启用条目，两件事必须一起做，
  // 否则会出现"启用了但文件不在"或"文件在但没启用"的不一致状态。
  const seeds = readWorldSeeds(installPath)
  const seedFolders = ensureWorldSeedModLayout(
    installPath,
    resolveDstUgcShardFolders(installPath),
    seeds,
  )
  writeModOverridesByShard(installPath, shardFolder =>
    buildModOverridesContent(
      mods,
      seedFolders.includes(shardFolder) ? [buildWorldSeedModRow(seeds[SHARD_ID_BY_FOLDER[shardFolder]]!)] : [],
    ), options.backup)
}
