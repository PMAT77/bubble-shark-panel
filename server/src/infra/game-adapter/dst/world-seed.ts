import fs from 'node:fs'
import path from 'node:path'
import type { ShardId } from '../../../../../shared/contracts/shard'
import { worldSeedPattern } from '../../../../../shared/contracts/shard'
import { DST_CLUSTER_NAME, DST_WORKSHOP_APP_ID } from './constants'
import { writeFileAtomic } from './atomic-write'
import { ensureDstLegacyModLink, removeDstLegacyModLinks, type DstShardFolder } from './ugc-mod-install'

/**
 * 面板内置的世界种子 Mod。
 *
 * 官方没有填写种子的入口：worldgenoverride.lua 只认 preset/overrides，cluster.ini 与启动参数
 * 里也没有种子项。唯一的官方扩展点在世界生成脚本自身——scripts/worldgen_main.lua 里有
 * `SEED = SetWorldGenSeed(SEED)`，`seed == nil` 时取 `os.time()` 反转后的 6 位随机值；这次赋值
 * 发生在 `ModManager:LoadMods(true)` **之后**，所以 mod 的 modworldgenmain.lua 只要设置全局
 * SEED，就能覆盖随机值。生成结果会记进存档的 `savedata.meta.seed`（即游戏内的
 * `TheWorld.meta.seed`），这也是社区「Worldgen Seed」类 Mod 的全部原理。
 *
 * 各分片使用相同脚本，从各自 modoverrides.lua 的 seed 配置读取指定种子。
 */
export const BSP_WORLD_SEED_MOD_ID = '99999999999'

/**
 * 保留 ID：11 位数字，远超 Steam 创意工坊实际分配的 UGC ID 区间，避免与真实 Mod 撞号。
 * 若日后 Steam 真的分配了该 ID，改这个常量即可（旧目录由落位逻辑清理）。
 */
export function toWorldSeedModName(): string {
  return `workshop-${BSP_WORLD_SEED_MOD_ID}`
}

/** 是否为面板内置的世界种子 Mod（导入存档、订阅入口等处要把它排除在外） */
export function isWorldSeedModId(value: string): boolean {
  return value.trim() === BSP_WORLD_SEED_MOD_ID
}

export const SHARD_FOLDER_BY_ID: Record<ShardId, DstShardFolder> = {
  master: 'Master',
  caves: 'Caves',
}

export const SHARD_ID_BY_FOLDER: Record<DstShardFolder, ShardId> = {
  Master: 'master',
  Caves: 'caves',
}

/**
 * 内置 Mod 的落位目录：与创意工坊 Mod 走同一套 UGC 布局。
 * DST 专用服只从 ugc_mods 读取 Mod（见 ugc-mod-install.ts 的说明），且按分片各存一份，
 * 两个分片的脚本保持相同，种子由各自的配置传入。
 */
export function resolveWorldSeedModDir(installPath: string, shardFolder: DstShardFolder): string {
  return path.join(
    installPath,
    'ugc_mods',
    DST_CLUSTER_NAME,
    shardFolder,
    'content',
    DST_WORKSHOP_APP_ID,
    BSP_WORLD_SEED_MOD_ID,
  )
}

/**
 * modinfo.lua 内容。
 *
 * api_version 必须与游戏的 MOD_API_VERSION 一致（当前为 10），否则游戏会把 Mod 判为过期；
 * 仅服务端的正确写法是 `all_clients_require_mod = false` 且不设 `client_only_mod`
 * （DST 没有 `server_only_mod` 这个字段）；`configuration_options` 提供各分片独立的种子参数。
 */
export function buildWorldSeedModInfoContent(): string {
  return [
    'name = "GSH World Seed"',
    'description = "由服务器面板写入的世界生成种子；只在本分片生成地图时生效。"',
    'author = "BubbleSharkPanel"',
    'version = "2.0.0"',
    'api_version = 10',
    // priority 取较大值：DST 按 priority 升序加载 Mod，靠后加载可以让本 Mod 最后设置 SEED，
    // 万一玩家另外启用了别的种子 Mod，以面板填写的种子为准。
    'priority = 100',
    'dont_starve_compatible = true',
    'reign_of_giants_compatible = true',
    'shipwrecked_compatible = false',
    'dst_compatible = true',
    'all_clients_require_mod = false',
    'client_only_mod = false',
    'configuration_options = {{ name = "seed", label = "Seed", options = {{ description = "Random", data = "" }}, default = "" }}',
    '',
  ].join('\n')
}

/** 共享脚本；配置来自当前分片，不把种子写进共享加载入口。 */
export function buildWorldSeedModWorldgenMainContent(): string {
  return [
    '-- BubbleSharkPanel: seed is scoped to this shard modoverrides.lua.',
    'local seed = GetModConfigData("seed", true)',
    'if type(seed) == "string" and seed:match("^%d+$") and #seed <= 15 then',
    '  GLOBAL.SEED = GLOBAL.tonumber(seed)',
    'end',
    '',
  ].join('\n')
}

/** 校验世界种子；通过返回 null，否则返回面向用户的中文说明 */
export function validateWorldSeed(seed: string): string | null {
  if (!seed.trim()) {
    return '世界种子不能为空；不需要指定时请留空'
  }
  if (!worldSeedPattern.test(seed)) {
    return '世界种子只能是 1–15 位数字'
  }
  return null
}

/** 内容一致时跳过写入，避免每次同步都无谓改动 mtime */
function writeIfChanged(filePath: string, content: string): void {
  try {
    if (fs.readFileSync(filePath, 'utf8') === content) {
      return
    }
  }
  catch {
    // 文件不存在或读不到：按需要写入处理
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileAtomic(filePath, content)
}

/** 移除某个分片的内置 Mod 目录（仅限保留 ID 目录，防误删） */
function removeWorldSeedModDir(installPath: string, shardFolder: DstShardFolder): void {
  const modDir = resolveWorldSeedModDir(installPath, shardFolder)
  if (path.basename(modDir) !== BSP_WORLD_SEED_MOD_ID) {
    return
  }
  fs.rmSync(modDir, { recursive: true, force: true })
}

/**
 * 把世界种子 Mod 落位到指定分片（幂等）。
 *
 * - 该分片有合法种子：写入 modinfo.lua + modworldgenmain.lua，返回该分片；
 * - 该分片没有种子：删除内置 Mod 目录，保证"不留空 Mod"（此时游戏回到官方随机）。
 *
 * 返回"已带上种子 Mod"的分片列表，调用方据此决定往哪些分片的 modoverrides.lua 注入条目。
 */
export function ensureWorldSeedModLayout(
  installPath: string,
  shardFolders: DstShardFolder[],
  seeds: Partial<Record<ShardId, string>>,
): DstShardFolder[] {
  const enabledFolders: DstShardFolder[] = []
  for (const shardFolder of shardFolders) {
    const seed = seeds[SHARD_ID_BY_FOLDER[shardFolder]]
    if (!seed || validateWorldSeed(seed)) {
      // 先撤加载入口，再删除内容，避免留下悬空接入。
      removeDstLegacyModLinks(installPath, [BSP_WORLD_SEED_MOD_ID])
      removeWorldSeedModDir(installPath, shardFolder)
      continue
    }
    const modDir = resolveWorldSeedModDir(installPath, shardFolder)
    writeIfChanged(path.join(modDir, 'modinfo.lua'), buildWorldSeedModInfoContent())
    writeIfChanged(path.join(modDir, 'modworldgenmain.lua'), buildWorldSeedModWorldgenMainContent())
    enabledFolders.push(shardFolder)
  }
  syncWorldSeedLegacyLink(installPath, enabledFolders)
  return enabledFolders
}

/** 两个分片的脚本相同，任何种子组合都可共享加载入口。失败必须报告。 */
function syncWorldSeedLegacyLink(installPath: string, enabledFolders: DstShardFolder[]): void {
  if (enabledFolders.length === 0) {
    removeDstLegacyModLinks(installPath, [BSP_WORLD_SEED_MOD_ID])
    return
  }
  ensureDstLegacyModLink(installPath, BSP_WORLD_SEED_MOD_ID, resolveWorldSeedModDir(installPath, enabledFolders[0]))
}
