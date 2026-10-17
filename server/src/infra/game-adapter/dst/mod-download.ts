import fs from 'node:fs'
import path from 'node:path'
import { runWorkshopDownload, type WorkshopDownloadInput, type WorkshopDownloadResult } from './workshop-download'
import { resolveDstSteamWorkshopModDir } from './constants'
import { resolveDstLegacyModDir, resolveDstUgcModDir } from './ugc-mod-install'
import type { SteamcmdTimeoutPhase } from '../../container/steamcmd-timeout'

function normalizeWorkshopIds(workshopIds: string[]): string[] {
  const unique = new Set<string>()
  for (const workshopId of workshopIds) {
    const normalized = workshopId.trim()
    if (normalized) {
      unique.add(normalized)
    }
  }
  return [...unique]
}

function hasWorkshopDownloadArtifacts(modDir: string): boolean {
  if (!fs.existsSync(modDir)) {
    return false
  }
  if (fs.existsSync(path.join(modDir, 'modinfo.lua'))
    || fs.existsSync(path.join(modDir, 'modmain.lua'))
    || fs.existsSync(path.join(modDir, 'mod.manifest'))) {
    return true
  }
  try {
    return fs.readdirSync(modDir).some(name => name.endsWith('_legacy.bin'))
  }
  catch {
    return false
  }
}

export { resolveDstSteamWorkshopModDir }

function resolveDstUgcModDirs(installPath: string, workshopId: string): string[] {
  return (['Master', 'Caves'] as const).map(shard => resolveDstUgcModDir(installPath, shard, workshopId))
}

export function isDstWorkshopModPresent(installPath: string, workshopId: string): boolean {
  const normalizedId = workshopId.trim()
  if (!normalizedId) {
    return false
  }
  if (hasWorkshopDownloadArtifacts(resolveDstSteamWorkshopModDir(installPath, normalizedId))) {
    return true
  }
  if (hasWorkshopDownloadArtifacts(resolveDstLegacyModDir(installPath, normalizedId))) {
    return true
  }
  return resolveDstUgcModDirs(installPath, normalizedId).some(hasWorkshopDownloadArtifacts)
}

export function formatMissingWorkshopModError(installPath: string, workshopIds: string[]): string {
  const details = workshopIds.map((workshopId) => {
    const workshopDir = resolveDstSteamWorkshopModDir(installPath, workshopId)
    if (!fs.existsSync(workshopDir)) {
      return `${workshopId}（目录不存在：${workshopDir}）`
    }
    let entries: string[] = []
    try {
      entries = fs.readdirSync(workshopDir)
    }
    catch {
      entries = []
    }
    if (entries.length === 0) {
      return `${workshopId}（目录为空：${workshopDir}）`
    }
    return `${workshopId}（未找到 modinfo.lua / modmain.lua / mod.manifest / *_legacy.bin，现有：${entries.slice(0, 5).join(', ')}）`
  })
  return `Mod 下载未完成，缺少文件：${details.join('；')}`
}

export function collectMissingWorkshopIds(installPath: string, workshopIds: string[]): string[] {
  return normalizeWorkshopIds(workshopIds).filter(workshopId => !isDstWorkshopModPresent(installPath, workshopId))
}

/**
 * 该交给 SteamCMD 的 id 列表：订阅/补齐只下缺的，强制更新则原样交给 SteamCMD
 * （由它自己比对工坊清单决定是否真的重新下载）。
 */
export function resolveWorkshopDownloadIds(
  installPath: string,
  workshopIds: string[],
  options?: { force?: boolean },
): string[] {
  const requestedIds = normalizeWorkshopIds(workshopIds)
  return options?.force ? requestedIds : collectMissingWorkshopIds(installPath, requestedIds)
}

export function formatModDownloadFailureMessage(output: string, timeoutPhase?: SteamcmdTimeoutPhase): string {
  const text = output.trim()
  const technical = timeoutPhase && text ? `\n${text.slice(-2000)}` : ''
  if (timeoutPhase === 'bootstrap') return `SteamCMD 自更新超时，尚未开始下载 Mod；未完成的自更新组件重试时可能重新下载${technical}`
  if (!text) {
    return 'Mod 下载失败，请检查 Steam 网络连接后重试'
  }
  if (/timed out|timeout|ETIMEDOUT/i.test(text)) {
    return `Mod 下载超时，请检查 Steam 网络连接后重试${technical}`
  }
  if (/Access Denied|No subscription|Invalid item/i.test(text)) {
    return '无法下载该 Mod，请确认创意工坊 ID 有效且为公开 Mod'
  }
  if (/Missing file permissions/i.test(text)) {
    return 'Mod 下载失败：实例目录权限不足'
  }
  const tail = text.slice(-500).split(/\r?\n/).slice(-3).join(' ').trim()
  return tail ? `Mod 下载失败：${tail}` : 'Mod 下载失败，请稍后重试'
}

/**
 * SteamCMD 会「失败但退出码为 0」：日志里已经写明下载失败，进程却正常退出。
 * 只看退出码会把它当成更新成功——而本机旧文件仍在盘上，`collectMissingWorkshopIds`
 * 同样看不出问题，于是旧内容被记成「已是最新」，真实的更新被永久漏掉。
 *
 * 这里只匹配强特征：命中即判失败。宁可报一次可重试的失败，也不谎报成功。
 */
const WORKSHOP_DOWNLOAD_FAILURE_PATTERN
  = /No subscription|Access Denied|Invalid item|Missing file permissions|ERROR!\s*Failed to download|failed to download/i

/** 命中失败特征时返回原始输出（交给 formatModDownloadFailureMessage 归类），未命中返回 null */
export function detectWorkshopDownloadFailure(output: string): string | null {
  const text = output.trim()
  if (!text) {
    return null
  }
  return WORKSHOP_DOWNLOAD_FAILURE_PATTERN.test(text) ? text : null
}

export async function downloadDstWorkshopMods(input: WorkshopDownloadInput): Promise<WorkshopDownloadResult> {
  const workshopIds = resolveWorkshopDownloadIds(input.hostInstallPath, input.workshopIds, { force: input.force })
  return runWorkshopDownload({ ...input, workshopIds })
}