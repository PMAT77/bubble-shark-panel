import fs from 'node:fs'
import DockerClient from 'dockerode'
import { resolveDockerConnectOptions } from '../docker-connect'
import { getServerContainerConfig } from '../../shared/config/container'
import { runSteamcmdJob } from './steamcmd-job'
import { buildSteamcmdAppUpdateArgs, buildSteamcmdWorkshopDownloadArgs } from './steamcmd-args'
import { resolveSteamcmdInstallBind } from './steamcmd-install-bind'
import { appendSteamcmdBindMountOptions, resolveSteamcmdContainerUser } from './steamcmd-container-user'
import { withSteamcmdAppUpdateLock } from './steamcmd-app-update-queue'
import { loadServerConfig, resolveInstallLogsDir } from '../../shared/config'
import {
  formatSteamcmdTimeoutForLog,
  loadSteamcmdRuntimeConfig,
  resolveSteamcmdAppUpdateTimeoutMs,
} from '../../shared/config/steamcmd'
import { appendInstallResourceSnapshot } from './install-resource-monitor'
import { formatSteamcmdMemoryLimitForLog, resolveSteamcmdContainerMemoryLimits } from './steamcmd-container-resources'
import { DST_WORKSHOP_APP_ID } from '../game-adapter/dst/constants'
import {
  buildImageCandidates,
  formatPullError,
  isImagePresentByRef,
  OFFICIAL_UNIFIED_IMAGE_REPOSITORY,
  pullImageWithCandidates,
} from './image-candidates'
import {
  cancelNativeSteamcmdJob,
  isNativeSteamcmdJobRunning,
  runSteamcmdAppInfoNative,
  runSteamcmdAppUpdateNative,
  runSteamcmdWorkshopDownloadNative,
} from './native-steamcmd-runner'
import {
  cancelSteamcmdInstallContainer as cancelDockerSteamcmdInstallContainer,
  cleanupAllRunningSteamcmdInstallContainers as cleanupAllDockerSteamcmdInstallContainers,
  cleanupOrphanedSteamcmdInstallContainers as cleanupOrphanedDockerSteamcmdInstallContainers,
  isSteamcmdJobRunning as isDockerSteamcmdJobRunning,
} from './steamcmd-job'


const STEAMCMD_APP_INFO_TIMEOUT_MS = 90_000
const DEFAULT_STEAMCMD_WORKSHOP_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000

function resolveDocker() {
  const { dockerHost } = getServerContainerConfig()
  return new DockerClient(resolveDockerConnectOptions(dockerHost))
}

function buildSteamcmdAppInfoArgs(appId: string) {
  return [
    '+@ShutdownOnFailedCommand',
    '1',
    '+@NoPromptForPassword',
    '1',
    '+login',
    'anonymous',
    '+app_info_update',
    '1',
    '+app_info_print',
    appId,
    '+quit',
  ]
}

export async function cancelSteamcmdInstallContainer(cancelKey: string): Promise<void> {
  if (getServerContainerConfig().runtimeMode === 'native') {
    return cancelNativeSteamcmdJob(cancelKey)
  }
  return cancelDockerSteamcmdInstallContainer(cancelKey)
}

export async function cleanupAllRunningSteamcmdInstallContainers(): Promise<number> {
  if (getServerContainerConfig().runtimeMode === 'native') {
    return 0
  }
  return cleanupAllDockerSteamcmdInstallContainers()
}

export async function cleanupOrphanedSteamcmdInstallContainers(jobId?: string): Promise<number> {
  if (getServerContainerConfig().runtimeMode === 'native') {
    return 0
  }
  return cleanupOrphanedDockerSteamcmdInstallContainers(jobId)
}

export async function isSteamcmdJobRunning(jobId: string): Promise<boolean> {
  if (getServerContainerConfig().runtimeMode === 'native') {
    return isNativeSteamcmdJobRunning(jobId)
  }
  return isDockerSteamcmdJobRunning(jobId)
}

export async function runSteamcmdAppUpdateInContainer(input: {
  hostInstallPath: string
  appId: string
  loginArgs: string[]
  cancelKey?: string
  onLogLine?: (line: string) => void
  onAwaitingSteamcmdLock?: () => void | Promise<void>
}): Promise<{ ok: boolean, output: string, cancelled?: boolean }> {
  if (getServerContainerConfig().runtimeMode === 'native') {
    return runSteamcmdAppUpdateNative(input)
  }
  const jobId = input.cancelKey?.trim() || 'anonymous'
  return withSteamcmdAppUpdateLock(
    jobId,
    () => runSteamcmdAppUpdateInContainerUnlocked(input),
    { onQueued: input.onAwaitingSteamcmdLock },
  )
}

async function runSteamcmdAppUpdateInContainerUnlocked(input: {
  hostInstallPath: string
  appId: string
  loginArgs: string[]
  cancelKey?: string
  onLogLine?: (line: string) => void
}): Promise<{ ok: boolean, output: string, cancelled?: boolean }> {
  const { steamcmdImage, instancesRoot } = getServerContainerConfig()
  const docker = resolveDocker()
  const bindPlan = await resolveSteamcmdInstallBind(docker, input.hostInstallPath, instancesRoot)
  const logLines: string[] = []
  const pushLine = (line: string) => {
    logLines.push(line)
    input.onLogLine?.(line)
  }

  pushLine(`准备启动 SteamCMD 容器（镜像 ${steamcmdImage}）`)
  pushLine(`安装目录（面板侧）: ${input.hostInstallPath}`)
  pushLine(`AppID: ${input.appId}`)
  pushLine(`SteamCMD bind 模式: ${bindPlan.mode}`)
  if (bindPlan.error) {
    pushLine(bindPlan.error)
    return {
      ok: false,
      output: logLines.slice(-20).join('\n') || bindPlan.error,
    }
  }
  if (bindPlan.mode === 'direct') {
    pushLine(`SteamCMD 直 bind: ${bindPlan.hostBinds[0]} → force_install_dir ${bindPlan.containerInstallPath}`)
  }
  else {
    pushLine(`SteamCMD 卷挂载: ${bindPlan.hostBinds[0]} → force_install_dir ${bindPlan.containerInstallPath}`)
  }

  const steamcmdConfig = loadSteamcmdRuntimeConfig()
  if (steamcmdConfig.downloadRegion) {
    pushLine(`Steam 下载区域：${steamcmdConfig.downloadRegion}`)
  }
  if (steamcmdConfig.httpProxy || steamcmdConfig.httpsProxy) {
    pushLine('SteamCMD 代理：已配置（HTTP/HTTPS）')
  }
  if (steamcmdConfig.networkMode === 'host') {
    pushLine('SteamCMD 网络模式：host')
  }

  const steamcmdArgs = buildSteamcmdAppUpdateArgs(
    bindPlan.containerInstallPath,
    input.appId,
    input.loginArgs,
    { downloadRegion: steamcmdConfig.downloadRegion || undefined },
  )

  const memoryLimits = resolveSteamcmdContainerMemoryLimits('app-update')
  pushLine(`SteamCMD 容器内存上限: ${formatSteamcmdMemoryLimitForLog(memoryLimits)}`)

  const appUpdateTimeoutMs = resolveSteamcmdAppUpdateTimeoutMs()
  pushLine(
    `SteamCMD app_update 单次超时上限: ${formatSteamcmdTimeoutForLog(appUpdateTimeoutMs)}（GSH_STEAMCMD_APP_UPDATE_TIMEOUT_MS 可调；大体积游戏慢速下载需调高）`,
  )

  const instanceId = input.cancelKey?.trim()
  if (instanceId) {
    try {
      const installLogsDir = resolveInstallLogsDir(loadServerConfig().dbPath)
      const resourceLines = await appendInstallResourceSnapshot(installLogsDir, docker, {
        instanceId,
        phase: 'steamcmd_before',
      })
      for (const line of resourceLines) {
        pushLine(line)
      }
    }
    catch {
      pushLine('[资源快照] 写入失败（不影响安装继续）')
    }
  }

  const result = await runSteamcmdJob({
    image: steamcmdImage,
    cmd: [
      '/home/steam/steamcmd/steamcmd.sh',
      ...steamcmdArgs,
    ],
    hostBinds: bindPlan.hostBinds.map(appendSteamcmdBindMountOptions),
    user: resolveSteamcmdContainerUser(),
    jobId: input.cancelKey,
    kind: 'app-update',
    timeoutMs: appUpdateTimeoutMs,
    onLogLine: input.onLogLine,
  })

  if (result.ok) {
    pushLine('SteamCMD app_update 已完成')
  }

  // 超时与取消也走 SIGKILL（137）：只有面板没主动杀容器时，137 才是真的 OOM
  const oomKilled = result.exitCode === 137 && !result.timedOut && !result.cancelled

  if (instanceId) {
    try {
      const installLogsDir = resolveInstallLogsDir(loadServerConfig().dbPath)
      const resourceLines = await appendInstallResourceSnapshot(installLogsDir, docker, {
        instanceId,
        phase: 'steamcmd_after',
        extra: {
          ok: result.ok,
          exitCode: result.exitCode,
          cancelled: result.cancelled ?? false,
          timedOut: result.timedOut ?? false,
          oomKilled,
        },
      })
      for (const line of resourceLines) {
        pushLine(line)
      }
      if (oomKilled) {
        pushLine('SteamCMD 容器因内存硬上限 OOM 被终止（exit 137）；可在 panel.env 酌情调高 GSH_STEAMCMD_CONTAINER_MEMORY_MB，并避免与运行中实例同时安装')
      }
    }
    catch {
      // ignore snapshot errors
    }
  }

  return {
    ok: result.ok,
    output: result.output || logLines.slice(-20).join('\n'),
    cancelled: result.cancelled,
  }
}

export async function runSteamcmdWorkshopDownloadInContainer(input: {
  hostInstallPath: string
  workshopIds: string[]
  cancelKey?: string
  onLogLine?: (line: string) => void
  onAwaitingSteamcmdLock?: () => void | Promise<void>
  onDownloadStart?: () => void | Promise<void>
  timeoutMs?: number
}): Promise<{ ok: boolean, output: string, cancelled?: boolean }> {
  if (getServerContainerConfig().runtimeMode === 'native') {
    return runSteamcmdWorkshopDownloadNative(input)
  }
  const jobId = input.cancelKey?.trim() || 'anonymous'
  return withSteamcmdAppUpdateLock(
    jobId,
    () => runSteamcmdWorkshopDownloadInContainerUnlocked(input),
    { onQueued: input.onAwaitingSteamcmdLock },
  )
}

async function runSteamcmdWorkshopDownloadInContainerUnlocked(input: {
  hostInstallPath: string
  workshopIds: string[]
  cancelKey?: string
  onLogLine?: (line: string) => void
  onDownloadStart?: () => void | Promise<void>
  timeoutMs?: number
}): Promise<{ ok: boolean, output: string, cancelled?: boolean }> {
  const { steamcmdImage, instancesRoot } = getServerContainerConfig()
  const docker = resolveDocker()
  const bindPlan = await resolveSteamcmdInstallBind(docker, input.hostInstallPath, instancesRoot)
  const logLines: string[] = []
  const pushLine = (line: string) => {
    logLines.push(line)
    input.onLogLine?.(line)
  }

  const workshopIds = [...new Set(input.workshopIds.map(id => id.trim()).filter(Boolean))]
  if (workshopIds.length === 0) {
    return { ok: true, output: '' }
  }

  pushLine(`准备启动 SteamCMD 容器下载 Mod（镜像 ${steamcmdImage}）`)
  pushLine(`安装目录（面板侧）: ${input.hostInstallPath}`)
  pushLine(`Workshop AppID: ${DST_WORKSHOP_APP_ID}`)
  pushLine(`待下载 Mod 数量: ${workshopIds.length}`)
  pushLine(`SteamCMD bind 模式: ${bindPlan.mode}`)
  if (bindPlan.error) {
    pushLine(bindPlan.error)
    return {
      ok: false,
      output: logLines.slice(-20).join('\n') || bindPlan.error,
    }
  }

  const steamcmdConfig = loadSteamcmdRuntimeConfig()
  const steamcmdArgs = buildSteamcmdWorkshopDownloadArgs(
    bindPlan.containerInstallPath,
    DST_WORKSHOP_APP_ID,
    workshopIds,
    ['+login', 'anonymous'],
    { downloadRegion: steamcmdConfig.downloadRegion || undefined },
  )

  const memoryLimits = resolveSteamcmdContainerMemoryLimits('app-update')
  pushLine(`SteamCMD 容器内存上限: ${formatSteamcmdMemoryLimitForLog(memoryLimits)}`)

  await input.onDownloadStart?.()

  const result = await runSteamcmdJob({
    image: steamcmdImage,
    cmd: [
      '/home/steam/steamcmd/steamcmd.sh',
      ...steamcmdArgs,
    ],
    hostBinds: bindPlan.hostBinds.map(appendSteamcmdBindMountOptions),
    user: resolveSteamcmdContainerUser(),
    jobId: input.cancelKey,
    kind: 'app-update',
    timeoutMs: input.timeoutMs ?? DEFAULT_STEAMCMD_WORKSHOP_DOWNLOAD_TIMEOUT_MS,
    onLogLine: input.onLogLine,
  })

  if (result.ok) {
    pushLine('SteamCMD workshop_download_item 已完成')
  }

  return {
    ok: result.ok,
    output: result.output || logLines.slice(-20).join('\n'),
    cancelled: result.cancelled,
  }
}

export async function runSteamcmdAppInfoInContainer(appId: string): Promise<{ ok: boolean, output: string }> {
  if (getServerContainerConfig().runtimeMode === 'native') {
    return runSteamcmdAppInfoNative(appId)
  }
  const { steamcmdImage } = getServerContainerConfig()
  const result = await runSteamcmdJob({
    image: steamcmdImage,
    cmd: [
      '/home/steam/steamcmd/steamcmd.sh',
      ...buildSteamcmdAppInfoArgs(appId.trim()),
    ],
    kind: 'app-info',
    timeoutMs: STEAMCMD_APP_INFO_TIMEOUT_MS,
  })

  const output = result.output
  return {
    ok: result.ok,
    output: output || (result.timedOut ? 'SteamCMD app_info 查询超时' : 'SteamCMD app_info 执行失败'),
  }
}

export type SteamcmdImagePullResult = { ok: true } | { ok: false, error: string }

let steamcmdImagePullInFlight: Promise<SteamcmdImagePullResult> | null = null


function resolveSteamcmdMirrorsRaw(): string {
  const { imageMirrors } = getServerContainerConfig()
  if (imageMirrors.length > 0) {
    return imageMirrors.join(',')
  }
  // 旧变量保留兼容
  return (process.env.GSH_STEAMCMD_IMAGE_MIRRORS || '').trim()
}

/** 面板拉取目标（完整保留 panel.env 中的 GSH_STEAMCMD_IMAGE） */
export function resolvePanelSteamcmdPullRef(configuredImage?: string): string {
  const configured = (configuredImage ?? getServerContainerConfig().steamcmdImage).trim()
  return configured || `${OFFICIAL_UNIFIED_IMAGE_REPOSITORY}:latest`
}

/**
 * SteamCMD 拉取候选：
 * 1) 若配置 GSH_IMAGE_MIRRORS（旧 GSH_STEAMCMD_IMAGE_MIRRORS 保留兼容），按顺序优先尝试候选 registry；
 * 2) 最后尝试完整的已配置镜像引用。
 */
export function buildSteamcmdImageCandidates(configuredImage?: string): string[] {
  return buildImageCandidates(resolvePanelSteamcmdPullRef(configuredImage), resolveSteamcmdMirrorsRaw())
}

export async function isSteamcmdImagePresent(): Promise<boolean> {
  const config = getServerContainerConfig()
  if (config.runtimeMode === 'native') {
    try {
      fs.accessSync(config.nativeSteamcmdPath, fs.constants.X_OK)
      return true
    }
    catch {
      return false
    }
  }
  try {
    const { steamcmdImage } = config
    if (await isImagePresentByRef(resolveDocker(), steamcmdImage)) {
      return true
    }
    return false
  }
  catch {
    return false
  }
}

const STEAMCMD_PULL_MAX_ATTEMPTS = 3
const STEAMCMD_PULL_RETRY_BASE_MS = 2_000

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 仅由用户显式触发（POST .../steamcmd/install），禁止在页面加载/列表轮询中调用 */
export async function pullSteamcmdImage(): Promise<SteamcmdImagePullResult> {
  const config = getServerContainerConfig()
  if (config.runtimeMode === 'native') {
    if (await isSteamcmdImagePresent()) {
      return { ok: true }
    }
    return {
      ok: false,
      error: `Native SteamCMD 未安装：${config.nativeSteamcmdPath}。请重新运行 --mode native 安装器。`,
    }
  }
  const { steamcmdImage } = config
  if (await isImagePresentByRef(resolveDocker(), steamcmdImage)) {
    return { ok: true }
  }
  if (steamcmdImagePullInFlight) {
    return steamcmdImagePullInFlight
  }
  const candidates = buildSteamcmdImageCandidates(steamcmdImage)
  steamcmdImagePullInFlight = (async (): Promise<SteamcmdImagePullResult> => {
    const result = await pullImageWithCandidates(resolveDocker(), candidates, steamcmdImage, {
      maxAttempts: STEAMCMD_PULL_MAX_ATTEMPTS,
      retryBaseMs: STEAMCMD_PULL_RETRY_BASE_MS,
      sleep,
    })
    if (result.ok) {
      return { ok: true }
    }
    return {
      ok: false,
      error: formatPullError(result.error, candidates[candidates.length - 1] || steamcmdImage, result.tried),
    }
  })().finally(() => {
    steamcmdImagePullInFlight = null
  })
  return steamcmdImagePullInFlight
}
