import fs from 'node:fs'
import path from 'node:path'
import { runSteamcmdAppInfoInContainer } from '../../infra/container'
import { resolveRuntimeStatus } from '../../infra/runtime'
import { diagnoseDstInstallReadiness } from '../../infra/game-adapter/dst/install-readiness'
import { parseKeyValuesRoot, parsePublicAppInfo, readKeyValues, type PublicAppInfo } from './app-info'

const REMOTE_BUILD_CACHE_MS = 30 * 60 * 1000

interface RemoteBuildCacheEntry {
  info: PublicAppInfo
  checkedAt: number
}

const remoteBuildCache = new Map<string, RemoteBuildCacheEntry>()
const inflightRemoteBuildFetches = new Map<string, Promise<PublicAppInfo | null>>()

export interface InstanceUpdateCheckResult {
  localBuildId: string | null
  remoteBuildId: string | null
  updateAvailable: boolean
  checkedAt: string
  message?: string
}

function resolveAppManifestPath(installPath: string, appId: string): string | null {
  const normalizedAppId = appId.trim()
  const candidates = [
    path.join(installPath, 'steamapps', `appmanifest_${normalizedAppId}.acf`),
    path.join(installPath, `appmanifest_${normalizedAppId}.acf`),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

export function readLocalBuildId(installPath: string, appId: string): string | null {
  const manifestPath = resolveAppManifestPath(installPath, appId)
  if (!manifestPath) {
    return null
  }
  try {
    const content = fs.readFileSync(manifestPath, 'utf8')
    const match = content.match(/"buildid"\s+"(\d+)"/i)
    return match?.[1] ?? null
  }
  catch {
    return null
  }
}

export async function fetchRemoteAppInfo(
  _steamcmdCommand: string,
  appId: string,
  options?: { force?: boolean },
): Promise<PublicAppInfo | null> {
  const normalizedAppId = appId.trim()
  if (!normalizedAppId) {
    return null
  }
  const cached = remoteBuildCache.get(normalizedAppId)
  const now = Date.now()
  if (!options?.force && cached && now - cached.checkedAt < REMOTE_BUILD_CACHE_MS) {
    return cached.info
  }

  const inflightKey = normalizedAppId
  const inflight = inflightRemoteBuildFetches.get(inflightKey)
  if (inflight) {
    return inflight
  }

  const task = (async () => {
    if ((await resolveRuntimeStatus()) !== 'running') {
      remoteBuildCache.delete(normalizedAppId)
      return null
    }
    const result = await runSteamcmdAppInfoInContainer(normalizedAppId)
    if (!result.ok) {
      remoteBuildCache.delete(normalizedAppId)
      return null
    }
    const info = parsePublicAppInfo(result.output, normalizedAppId)
    if (info) {
      remoteBuildCache.set(normalizedAppId, { info, checkedAt: Date.now() })
    }
    else {
      remoteBuildCache.delete(normalizedAppId)
    }
    return info
  })().catch(() => {
    remoteBuildCache.delete(normalizedAppId)
    return null
  }).finally(() => {
    inflightRemoteBuildFetches.delete(inflightKey)
  })

  inflightRemoteBuildFetches.set(inflightKey, task)
  return task
}

export async function fetchRemoteBuildId(steamcmdCommand: string, appId: string, options?: { force?: boolean }): Promise<string | null> {
  return (await fetchRemoteAppInfo(steamcmdCommand, appId, options))?.buildId ?? null
}

export async function checkGameUpdateAvailable(input: {
  installPath: string
  appId: string
  steamcmdCommand: string
  forceRemote?: boolean
  remoteInfo?: PublicAppInfo | null
}): Promise<InstanceUpdateCheckResult> {
  const checkedAt = new Date().toISOString()
  const localBuildId = readLocalBuildId(input.installPath, input.appId)
  if (!localBuildId) {
    return {
      localBuildId: null,
      remoteBuildId: null,
      updateAvailable: false,
      checkedAt,
      message: '未找到本地安装清单，可能尚未完成安装',
    }
  }
  const remote = input.remoteInfo !== undefined ? input.remoteInfo : await fetchRemoteAppInfo(input.steamcmdCommand, input.appId, {
    force: input.forceRemote,
  })
  if (!remote) {
    return {
      localBuildId,
      remoteBuildId: null,
      updateAvailable: false,
      checkedAt,
      message: '无法获取 Steam 远端版本信息',
    }
  }
  const result: InstanceUpdateCheckResult = {
    localBuildId,
    remoteBuildId: remote.buildId,
    updateAvailable: localBuildId !== remote.buildId,
    checkedAt,
  }
  if (result.updateAvailable) return result

  // 旧版面板曾改写 buildid；内容清单必须独立匹配，不能只信编号。
  try {
    const manifestPath = resolveAppManifestPath(input.installPath, input.appId)!
    const local = parseKeyValuesRoot(fs.readFileSync(manifestPath, 'utf8'), 'AppState', true)
    const installed = readKeyValues(local, 'InstalledDepots')
    const state = readKeyValues(local, 'StateFlags')
    if (readKeyValues(local, 'appid') !== input.appId.trim()
      || readKeyValues(local, 'buildid') !== localBuildId
      || typeof state !== 'string' || !/^\d+$/.test(state)
      || !installed || typeof installed === 'string' || !Object.keys(installed).length
      || !remote.linuxDepots.length || remote.linuxDepots.some(id => !remote.depotManifests[id])) {
      return { ...result, localBuildId: null, message: '安装或内容清单信息不完整，无法判断版本；可强制更新所选实例' }
    }
    for (const [id, depot] of Object.entries(installed)) {
      const gid = typeof depot === 'string' ? null : readKeyValues(depot, 'manifest')
      if (typeof gid !== 'string' || !/^[1-9]\d*$/.test(gid) || !remote.depotManifests[id]) {
        return { ...result, localBuildId: null, message: '无法核对已安装的内容清单；可强制更新所选实例' }
      }
      if (gid !== remote.depotManifests[id]) {
        return { ...result, updateAvailable: true, message: '游戏内容清单与 Steam 正式分支不一致，需要更新' }
      }
    }
    if (state !== '4' || remote.linuxDepots.some(id => !Object.hasOwn(installed, id))
      || (input.appId.trim() === '343050' && !diagnoseDstInstallReadiness(input.installPath).ready)) {
      return { ...result, updateAvailable: true, message: '游戏安装不完整，需要更新服务端' }
    }
    return result
  }
  catch {
    return { ...result, localBuildId: null, message: '无法读取本地内容清单，无法判断版本' }
  }
}

export function clearRemoteBuildCache(appId?: string) {
  if (appId?.trim()) {
    remoteBuildCache.delete(appId.trim())
    return
  }
  remoteBuildCache.clear()
}
