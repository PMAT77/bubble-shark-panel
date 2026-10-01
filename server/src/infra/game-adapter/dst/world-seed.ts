import fs from 'node:fs'
import path from 'node:path'
import type { ShardId } from '../../../../../shared/contracts/shard'
import { worldSeedPattern } from '../../../../../shared/contracts/shard'
import { DST_CLUSTER_NAME, DST_WORKSHOP_APP_ID } from './constants'
import { writeFileAtomic } from './atomic-write'
import { ensureDstLegacyModLink, removeDstLegacyModLinks, type DstShardFolder } from './ugc-mod-install'
import { isCavesShardConfigured } from './shard-layout'

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
 * 于是面板自带一个仅服务端的极小 Mod：种子直接写死在它的 modworldgenmain.lua 里
 * （不依赖 Mod 配置项——DST 的 configuration_options 只有下拉选项，没有自由文本输入）。
 */
export const GSH_WORLD_SEED_MOD_ID = '99999999999'

/**
 * 保留 ID：11 位数字，远超 Steam 创意工坊实际分配的 UGC ID 区间，避免与真实 Mod 撞号。
 * 若日后 Steam 真的分配了该 ID，改这个常量即可（旧目录由落位逻辑清理）。
 */
export function toWorldSeedModName(): string {
  return `workshop-${GSH_WORLD_SEED_MOD_ID}`
}

/** 是否为面板内置的世界种子 Mod（导入存档、订阅入口等处要把它排除在外） */
export function isWorldSeedModId(value: string): boolean {
  return value.trim() === GSH_WORLD_SEED_MOD_ID
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
 * 所以地上与洞穴可以各带一份内容不同的 modworldgenmain.lua——这正是两个分片能各用种子的原因。
 */
export function resolveWorldSeedModDir(installPath: string, shardFolder: DstShardFolder): string {
  return path.join(
    installPath,
    'ugc_mods',
    DST_CLUSTER_NAME,
    shardFolder,
    'content',
    DST_WORKSHOP_APP_ID,
    GSH_WORLD_SEED_MOD_ID,
  )
}

/**
 * modinfo.lua 内容。
 *
 * api_version 必须与游戏的 MOD_API_VERSION 一致（当前为 10），否则游戏会把 Mod 判为过期；
 * 仅服务端的正确写法是 `all_clients_require_mod = false` 且不设 `client_only_mod`
 * （DST 没有 `server_only_mod` 这个字段）；`configuration_options` 必须存在，故给空表。
 */
export function buildWorldSeedModInfoContent(): string {
  return [
    'name = "GSH World Seed"',
    'description = "由服务器面板写入的世界生成种子；只在本分片生成地图时生效。"',
    'author = "Game Server Hub"',
    'version = "1.0.0"',
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
    'configuration_options = {}',
    '',
  ].join('\n')
}

/**
 * modworldgenmain.lua 内容：把种子写死为数字字面量。
 *
 * 写成数字（而不是字符串）可以保证存档里的 `meta.seed` 与面板填写值类型一致；
 * 种子已由 worldSeedPattern 保证是 1–15 位纯数字，内联进 Lua 安全。
 */
export function buildWorldSeedModWorldgenMainContent(seed: string): string {
  return [
    '-- 由 Game Server Hub 自动生成，请勿手工编辑：本分片的世界生成种子。',
    '-- worldgen_main.lua 会在加载完所有 Mod 之后执行 SEED = SetWorldGenSeed(SEED)，',
    '-- 因此这里设置的全局 SEED 就是本次生成实际使用的种子（并写入存档 meta.seed）。',
    `GLOBAL.SEED = ${seed}`,
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
  if (path.basename(modDir) !== GSH_WORLD_SEED_MOD_ID) {
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
      removeWorldSeedModDir(installPath, shardFolder)
      continue
    }
    const modDir = resolveWorldSeedModDir(installPath, shardFolder)
    writeIfChanged(path.join(modDir, 'modinfo.lua'), buildWorldSeedModInfoContent())
    writeIfChanged(path.join(modDir, 'modworldgenmain.lua'), buildWorldSeedModWorldgenMainContent(seed))
    enabledFolders.push(shardFolder)
  }
  syncWorldSeedLegacyLink(installPath, enabledFolders, seeds)
  return enabledFolders
}

/**
 * 内置 Mod 同样要接入 DST 实际读取的 `mods/workshop-<id>`（理由见 resolveDstLegacyModDir）。
 *
 * 但 `mods/` 是两个分片共用的一份：分片各自有不同种子时无法表达，链接过去会让洞穴
 * 也用上地上世界的种子——那是比「内置 Mod 不生效」更糟的结果，所以这种情况下不建链接。
 */
function syncWorldSeedLegacyLink(
  installPath: string,
  enabledFolders: DstShardFolder[],
  seeds: Partial<Record<ShardId, string>>,
): void {
  const sameSeed = (seeds.master?.trim() ?? '') === (seeds.caves?.trim() ?? '')
  if (enabledFolders.length === 0 || (isCavesShardConfigured(installPath) && !sameSeed)) {
    removeDstLegacyModLinks(installPath, [GSH_WORLD_SEED_MOD_ID])
    return
  }
  try {
    ensureDstLegacyModLink(installPath, GSH_WORLD_SEED_MOD_ID, resolveWorldSeedModDir(installPath, enabledFolders[0]))
  }
  catch {
    // best-effort：接入失败只影响内置种子生效，不影响实例启动
  }
}
