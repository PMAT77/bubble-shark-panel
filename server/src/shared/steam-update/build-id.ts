import fs from 'node:fs'
import path from 'node:path'
import { runSteamcmdAppInfoInContainer } from '../../infra/container'
import { resolveRuntimeStatus } from '../../infra/runtime'
import { parsePublicBuildIdFromAppInfo } from './app-info'

const REMOTE_BUILD_CACHE_MS = 30 * 60 * 1000

interface RemoteBuildCacheEntry {
  buildId: string
  checkedAt: number
}

const remoteBuildCache = new Map<string, RemoteBuildCacheEntry>()
const inflightRemoteBuildFetches = new Map<string, Promise<string | null>>()

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

export async function fetchRemoteBuildId(
  _steamcmdCommand: string,
  appId: string,
  options?: { force?: boolean },
): Promise<string | null> {
  const normalizedAppId = appId.trim()
  if (!normalizedAppId) {
    return null
  }
  const cached = remoteBuildCache.get(normalizedAppId)
  const now = Date.now()
  if (!options?.force && cached && now - cached.checkedAt < REMOTE_BUILD_CACHE_MS) {
    return cached.buildId
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
    const buildId = parsePublicBuildIdFromAppInfo(result.output, normalizedAppId)
    if (buildId) {
      remoteBuildCache.set(normalizedAppId, { buildId, checkedAt: Date.now() })
    }
    else {
      remoteBuildCache.delete(normalizedAppId)
    }
    return buildId
  })().catch(() => {
    remoteBuildCache.delete(normalizedAppId)
    return null
  }).finally(() => {
    inflightRemoteBuildFetches.delete(inflightKey)
  })

  inflightRemoteBuildFetches.set(inflightKey, task)
  return task
}

export async function checkGameUpdateAvailable(input: {
  installPath: string
  appId: string
  steamcmdCommand: string
  forceRemote?: boolean
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
  const remoteBuildId = await fetchRemoteBuildId(input.steamcmdCommand, input.appId, {
    force: input.forceRemote,
  })
  if (!remoteBuildId) {
    return {
      localBuildId,
      remoteBuildId: null,
      updateAvailable: false,
      checkedAt,
      message: '无法获取 Steam 远端版本信息',
    }
  }
  return {
    localBuildId,
    remoteBuildId,
    updateAvailable: localBuildId !== remoteBuildId,
    checkedAt,
  }
}

export function clearRemoteBuildCache(appId?: string) {
  if (appId?.trim()) {
    remoteBuildCache.delete(appId.trim())
    return
  }
  remoteBuildCache.clear()
}
