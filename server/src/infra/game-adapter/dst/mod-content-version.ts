import fs from 'node:fs'
import path from 'node:path'
import {
  resolveDstUgcModDir,
  resolveDstUgcShardFolders,
  resolveDstWorkshopSourceDirs,
} from './ugc-mod-install'
import { readWorkshopInstalledItems, unixSecondsToIsoOrNull } from './workshop-manifest'
import type { WorkshopInstalledItem } from './workshop-manifest'

/**
 * 「本机这份 Mod 是哪个版本」的统一口径。
 *
 * 面板用 `-skip_update_server_mods` 启动 DST，游戏侧永远不会自己更新 Mod，
 * 「服务器上的 Mod 是旧版本、新玩家进不来」只能由面板发现；而发现的前提是知道
 * 本机内容的版本时间。可信来源只有两个：
 *
 *   1. SteamCMD 清单 `steamapps/workshop/appworkshop_322330.acf` 里该条目的 timeupdated
 *   2. 内容目录里关键文件的落地时间（没有清单时的兜底）
 *
 * 两者都取不到就老实回答「不知道」。这里刻意**不**回落到「面板记录这份内容的时间」：
 * 记录时刻必然晚于当时的工坊版本时间，拿它去比等于恒定得出「已是最新」，
 * 真正的旧版本会被永久漏报。
 *
 * 时间之外还回答一个独立问题：游戏实际加载的那份（ugc_mods）是否比下载内容旧。
 * DST 专用服只读 ugc_mods，而落位在目标目录已存在时会跳过 —— 两者不一致时
 * 「下载目录已最新、游戏里仍是旧内容」会同时成立，只看下载目录的面板发现不了。
 */

/** 能代表「这份内容被写过」的顶层文件：与 mod-download.ts 的就位判定保持同一组 */
const CONTENT_MARKER_FILES = ['modinfo.lua', 'modmain.lua', 'mod.manifest']
const LEGACY_ARCHIVE_SUFFIX = '_legacy.bin'

export type LocalModContentVersionSource = 'workshop-manifest' | 'content-mtime' | 'migration-manifest'

export interface LocalModContentVersion {
  /** 本机内容对应的时间（ISO）；无从得知为 null */
  updatedAt: string | null
  /** 这个时间的来源；null 表示本机没有任何版本凭据 */
  source: LocalModContentVersionSource | null
  /** 游戏实际加载的副本比已下载内容旧，需要重新下载并重新落位 */
  loadedCopyStale: boolean
}

const UNKNOWN_LOCAL_MOD_CONTENT_VERSION: LocalModContentVersion = {
  updatedAt: null,
  source: null,
  loadedCopyStale: false,
}

function statMtimeMs(target: string): number | null {
  try {
    return fs.statSync(target).mtimeMs
  }
  catch {
    return null
  }
}

/**
 * 目录里「内容被写入」的时间：取关键文件里最新的 mtime，只有 legacy 包时看包。
 *
 * 一个关键文件都没有（空目录、下到一半的目录）不产出时间：那不是一份可用的内容，
 * 拿目录自身的时间当版本凭据只会把「没下完」说成「刚下过最新版」。
 */
function readContentMtimeMs(dir: string): number | null {
  if (statMtimeMs(dir) === null) {
    return null
  }
  let latest: number | null = null
  const merge = (mtime: number | null) => {
    if (mtime !== null && (latest === null || mtime > latest)) {
      latest = mtime
    }
  }
  for (const fileName of CONTENT_MARKER_FILES) {
    merge(statMtimeMs(path.join(dir, fileName)))
  }
  if (latest === null) {
    let entries: string[] = []
    try {
      entries = fs.readdirSync(dir)
    }
    catch {
      entries = []
    }
    for (const entry of entries) {
      if (entry.toLowerCase().endsWith(LEGACY_ARCHIVE_SUFFIX)) {
        merge(statMtimeMs(path.join(dir, entry)))
      }
    }
  }
  return latest
}

/** 已下载内容的落地时间：steamapps/workshop 优先，其次历史布局 mods/workshop-<id> */
function readDownloadedContentMtimeMs(installPath: string, workshopId: string): number | null {
  for (const dir of resolveDstWorkshopSourceDirs(installPath, workshopId)) {
    const mtime = readContentMtimeMs(dir)
    if (mtime !== null) {
      return mtime
    }
  }
  return null
}

/**
 * 游戏加载的副本是否陈旧。没有这一份副本（还没落位）不算陈旧 ——
 * 那种情况由安装状态表达，不在这里重复判定。
 */
function isLoadedCopyStale(installPath: string, workshopId: string, downloadedMtimeMs: number | null): boolean {
  if (downloadedMtimeMs === null) {
    return false
  }
  for (const shardFolder of resolveDstUgcShardFolders(installPath)) {
    const mtime = readContentMtimeMs(resolveDstUgcModDir(installPath, shardFolder, workshopId))
    // utimes / 文件系统精度可能让同一次复制的时间小于来源不足 1 ms。
    if (mtime !== null && mtime + 1 < downloadedMtimeMs) {
      return true
    }
  }
  return false
}

/**
 * 解析单个 Mod 的本机内容版本。
 *
 * 批量调用（例如一次检查几十个 Mod）时把 `installedItems` 传进来复用：
 * SteamCMD 清单是一次读入并整体解析的，每个 Mod 各读一遍纯属浪费。
 */
export function resolveLocalModContentVersion(
  installPath: string,
  workshopId: string,
  options?: { installedItems?: Map<string, WorkshopInstalledItem>, contentSource?: 'steam' | 'local' | 'migration', knownUpdatedAt?: string | null },
): LocalModContentVersion {
  const normalizedId = workshopId.trim()
  if (!installPath?.trim() || !normalizedId) {
    return UNKNOWN_LOCAL_MOD_CONTENT_VERSION
  }
  if (options?.contentSource === 'local') return UNKNOWN_LOCAL_MOD_CONTENT_VERSION
  if (options?.contentSource === 'migration') {
    return { updatedAt: options.knownUpdatedAt ?? null, source: options.knownUpdatedAt ? 'migration-manifest' : null, loadedCopyStale: false }
  }
  const downloadedMtimeMs = readDownloadedContentMtimeMs(installPath, normalizedId)
  const loadedCopyStale = isLoadedCopyStale(installPath, normalizedId, downloadedMtimeMs)
  const installedItems = options?.installedItems ?? readWorkshopInstalledItems(installPath)
  const fromManifest = unixSecondsToIsoOrNull(installedItems.get(normalizedId)?.timeupdated)
  if (fromManifest) {
    return { updatedAt: fromManifest, source: 'workshop-manifest', loadedCopyStale }
  }
  if (downloadedMtimeMs !== null) {
    return {
      updatedAt: new Date(downloadedMtimeMs).toISOString(),
      source: 'content-mtime',
      loadedCopyStale,
    }
  }
  return { ...UNKNOWN_LOCAL_MOD_CONTENT_VERSION, loadedCopyStale }
}
