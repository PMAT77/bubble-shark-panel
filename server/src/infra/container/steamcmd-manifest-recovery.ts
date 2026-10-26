import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseKeyValuesRoot, readKeyValues } from '../../shared/steam-update/app-info'
import { findDeniedDepotManifests } from './steamcmd-errors'

/**
 * 仅处理本轮已成功取得新清单、却无法取得本地旧清单的情况。
 * SteamCMD 已结束并完成清理后才调用；只备份安装元数据，由调用方原有重试预算重新 validate。
 */
export function prepareSteamcmdManifestRecovery<T extends {
  ok: boolean, output: string, cancelled?: boolean, timedOut?: boolean, oomKilled?: boolean
}>(result: T, input: {
  hostInstallPath: string
  appId: string
  signal?: AbortSignal
  onLogLine?: (line: string) => void
}): T {
  if (result.ok || result.cancelled || result.timedOut || result.oomKilled || input.signal?.aborted
    || !/^\d+$/.test(input.appId) || /无法确认.*(?:停止|结束)|清理.*失败/.test(result.output)) return result
  const denied = findDeniedDepotManifests(result.output).filter(item => item.appId === input.appId
    && new RegExp(`/depot/${item.depotId}/manifest/(?!${item.manifestId}/)[1-9]\\d*/[^\\n]*manifest request received 200 \\(OK\\)`, 'i').test(result.output))
  if (!denied.length) return result
  const append = (line: string): T => {
    input.onLogLine?.(line)
    return { ...result, output: `${result.output}\n${line}` }
  }
  for (const file of [path.join(input.hostInstallPath, 'steamapps', `appmanifest_${input.appId}.acf`),
    path.join(input.hostInstallPath, `appmanifest_${input.appId}.acf`)]) {
    try {
      if (!fs.existsSync(file)) continue
      if (!fs.lstatSync(file).isFile()) return result
      const content = fs.readFileSync(file, 'utf8')
      const local = parseKeyValuesRoot(content, 'AppState', true)
      if (readKeyValues(local, 'appid') !== input.appId
        || !denied.some(item => readKeyValues(local, 'InstalledDepots', item.depotId, 'manifest') === item.manifestId)) return result
      // 不删除游戏、存档或下载缓存；清单原样保留供排查及恢复。
      const backup = `${file}.denied-${randomUUID()}.bak`
      fs.renameSync(file, backup)
      return append(`Steam 拒绝获取旧版 Depot 清单；已备份安装清单至 ${backup}，下一次尝试将重新校验现有游戏文件（不增加重试次数）。`)
    }
    catch (error) {
      return append(`旧版安装清单备份失败，保留游戏文件：${(error as Error).message}`)
    }
  }
  return result
}
