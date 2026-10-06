import fs from 'node:fs'
import path from 'node:path'
import { runSteamcmdAppInfoInContainer } from '../../infra/container'
import { resolveRuntimeStatus } from '../../infra/runtime'
import { diagnoseDstInstallReadiness } from '../../infra/game-adapter/dst/install-readiness'
import { parseKeyValuesRoot, parsePublicAppInfo, readKeyValues, type PublicAppInfo } from './app-info'

export const REMOTE_BUILD_CACHE_MS = 5 * 60 * 1000

interface RemoteBuildCacheEntry {
  info: PublicAppInfo
  checkedAt: number
}

const remoteBuildCache = new Map<string, RemoteBuildCacheEntry>()
const inflightRemoteBuildFetches = new Map<string, Promise<{ info: PublicAppInfo | null, error?: string }>>()
const remoteBuildGenerations = new Map<string, number>()

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
  options?: { force?: boolean, onFailure?: (message: string) => void },
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

  const generation = remoteBuildGenerations.get(normalizedAppId) ?? 0
  const inflightKey = `${normalizedAppId}:${generation}`
  const inflight = inflightRemoteBuildFetches.get(inflightKey)
  if (inflight) {
    const result = await inflight
    if (result.error) options?.onFailure?.(result.error)
    return result.info
  }

  const discardCache = () => {
    if ((remoteBuildGenerations.get(normalizedAppId) ?? 0) === generation) remoteBuildCache.delete(normalizedAppId)
  }
  const task = (async () => {
    if ((await resolveRuntimeStatus()) !== 'running') {
      discardCache()
      return { info: null, error: '游戏运行时未就绪，无法查询 Steam 版本' }
    }
    const result = await runSteamcmdAppInfoInContainer(normalizedAppId)
    if (!result.ok) {
      discardCache()
      return { info: null, error: `SteamCMD 版本查询失败：${result.output.split('\n').slice(-20).join('\n')}` }
    }
    const info = parsePublicAppInfo(result.output, normalizedAppId)
    if (info) {
      info.checkedAt = new Date().toISOString()
      if ((remoteBuildGenerations.get(normalizedAppId) ?? 0) === generation
        && info.linuxDepots.length && info.linuxDepots.every(id => info.depotManifests[id])) {
        remoteBuildCache.set(normalizedAppId, { info, checkedAt: Date.now() })
      }
      else discardCache()
    }
    else {
      discardCache()
      return { info: null, error: 'SteamCMD 未返回完整的正式分支版本信息' }
    }
    return { info }
  })().catch(() => {
    discardCache()
    return { info: null, error: 'SteamCMD 版本查询异常，请检查面板运行时与镜像配置' }
  }).finally(() => {
    inflightRemoteBuildFetches.delete(inflightKey)
  })

  inflightRemoteBuildFetches.set(inflightKey, task)
  const result = await task
  if (result.error) options?.onFailure?.(result.error)
  return result.info
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
      message: resolveAppManifestPath(input.installPath, input.appId)
        ? '本地安装清单无法读取或缺少 Build ID，无法判断版本'
        : '未找到本地安装清单，可能尚未完成安装',
    }
  }
  let remoteError: string | undefined
  const remote = input.remoteInfo !== undefined ? input.remoteInfo : await fetchRemoteAppInfo(input.steamcmdCommand, input.appId, {
    force: input.forceRemote,
    onFailure: message => { remoteError = message },
  })
  if (!remote) {
    return {
      localBuildId,
      remoteBuildId: null,
      updateAvailable: false,
      checkedAt,
      message: remoteError ?? '无法获取 Steam 远端版本信息',
    }
  }
  const result: InstanceUpdateCheckResult = {
    localBuildId,
    remoteBuildId: remote.buildId,
    updateAvailable: false,
    checkedAt: remote.checkedAt ?? checkedAt,
  }

  // 旧版面板曾改写 buildid；内容清单必须独立匹配，不能只信编号。
  try {
    const manifestPath = resolveAppManifestPath(input.installPath, input.appId)!
    const local = parseKeyValuesRoot(fs.readFileSync(manifestPath, 'utf8'), 'AppState', true)
    if (!local) return { ...result, message: '本地安装清单格式不完整，无法判断版本' }
    const installed = readKeyValues(local, 'InstalledDepots')
    const state = readKeyValues(local, 'StateFlags')
    if (readKeyValues(local, 'appid') !== input.appId.trim()
      || readKeyValues(local, 'buildid') !== localBuildId
      || typeof state !== 'string' || !/^\d+$/.test(state)
      || !installed || typeof installed === 'string' || !Object.keys(installed).length) {
      return { ...result, message: '本地安装或内容清单信息不完整，无法判断版本' }
    }
    if (!remote.linuxDepots.length || remote.linuxDepots.some(id => !remote.depotManifests[id])) {
      return { ...result, message: 'Steam 正式分支的 Linux 内容清单信息不完整，无法判断版本' }
    }
    let contentChanged = false
    for (const [id, depot] of Object.entries(installed)) {
      const gid = typeof depot === 'string' ? null : readKeyValues(depot, 'manifest')
      if (typeof gid !== 'string' || !/^[1-9]\d*$/.test(gid)) {
        return { ...result, message: `本地内容 ${id} 的清单版本无效，无法判断版本` }
      }
      if (!remote.depotManifests[id]) {
        return { ...result, message: `Steam 正式分支缺少已安装内容 ${id} 的清单，无法判断版本` }
      }
      if (gid !== remote.depotManifests[id]) {
        contentChanged = true
      }
    }
    if (state !== '4' || remote.linuxDepots.some(id => !Object.hasOwn(installed, id))
      || (input.appId.trim() === '343050' && !diagnoseDstInstallReadiness(input.installPath).ready)) {
      return { ...result, updateAvailable: true, message: '游戏安装不完整，需要更新服务端' }
    }
    return { ...result, updateAvailable: contentChanged || localBuildId !== remote.buildId,
      ...(contentChanged ? { message: '游戏内容清单与 Steam 正式分支不一致，需要更新' } : {}) }
  }
  catch {
    return { ...result, message: '无法读取本地内容清单，无法判断版本' }
  }
}

export function clearRemoteBuildCache(appId?: string) {
  if (appId?.trim()) {
    remoteBuildCache.delete(appId.trim())
    remoteBuildGenerations.set(appId.trim(), (remoteBuildGenerations.get(appId.trim()) ?? 0) + 1)
    return
  }
  remoteBuildCache.clear()
  for (const key of inflightRemoteBuildFetches.keys()) {
    const id = key.split(':')[0]
    remoteBuildGenerations.set(id, (remoteBuildGenerations.get(id) ?? 0) + 1)
  }
}
