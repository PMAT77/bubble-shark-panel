import { beginInstanceContentActivity } from '../../shared/instance-content/operation'
import type { FastifyInstance } from 'fastify'
import process from 'node:process'
import type { DbInstallLogStatus } from '../../shared/db/index'
import {
  listGameInstances,
  getGameInstanceById,
  updateGameInstanceRuntime,
} from '../../shared/db/index'
import { loadServerConfig, resolveInstallLogsDir } from '../../shared/config'
import { shouldDeferDstImagePullOnInstall } from '../../shared/config/install'
import {
  InstanceInstallLogWriter,
} from '../../shared/instance-install/log-store'
import { loadSteamcmdRuntimeConfig } from '../../shared/config/steamcmd'
import { resolveSteamcmdLoginMode } from '../../shared/instance-install/steamcmd-login-mode'
import {
  assessHostMemoryForHeavyOperation,
  cancelSteamcmdInstallContainer,
  cleanupAllRunningSteamcmdInstallContainers,
  cleanupOrphanedSteamcmdInstallContainers,
  clearNativeSteamcmdCancelFlag,
  clearSteamcmdJobCancelFlag,
  isSteamcmdJobRunning,
  runSteamcmdAppUpdateInContainer,
} from '../../infra/container'
import { isSteamcmdAppUpdateBusy } from '../../infra/container/steamcmd-app-update-queue'
import { createDockerClient } from '../../infra/docker-connect'
import { getServerContainerConfig } from '../../shared/config/container'
import { appendInstallResourceSnapshot } from '../../infra/container/install-resource-monitor'
import {
  formatSteamcmdAppUpdateFailureMessage,
} from '../../infra/container/steamcmd-errors'
import { DST_APP_ID } from '../../infra/game-adapter/dst/constants'
import { diagnoseDstInstallReadiness } from '../../infra/game-adapter/dst/install-readiness'
import { ensureDstLayout } from '../../infra/game-adapter/dst/cluster-config'
import { prepareInstallPathForSteamcmd } from './install-path'
import { retrySteamcmdInstall } from './steamcmd-install-retry'
import { ensureGameRuntimeImageReady } from '../../infra/game-adapter/runtime-image'
import { refreshInstanceUpdateStatusAfterInstall, resolveSteamcmdCommandForUpdateCheck } from './update-check'
import { checkGameUpdateAvailable, readLocalBuildId } from '../../shared/steam-update/build-id'
import { tryInstallGameDepotFromSeed } from './install-seed'

export interface InstanceInstallJobInput {
  instanceId: string
  appId: string
  instanceName: string
  gamePort?: number | null
  installPath: string
  steamcmdCommand: string
  steamcmdCredentials?: { username: string, password: string }
  /** 已受理的更新必须实际校验文件，不能按清单跳过或改用供体复制。 */
  forceSteamcmd?: boolean
}

const LOCAL_NODE_ID = 'local-node'

export const INSTALL_INTERRUPTED_MESSAGE = '安装已中断。请点击「更新服务端」重试，或删除实例后重建。'
export const INSTALL_RESTART_INTERRUPTED_MESSAGE = '服务重启导致安装中断，请点击「更新服务端」重新拉取。'
export const INSTALL_STEAMCMD_QUEUE_MESSAGE = '排队等待其他实例的 SteamCMD 安装完成...'

const installingInstanceIds = new Set<string>()
const activeInstallLogWriters = new Map<string, InstanceInstallLogWriter>()
const cancelledInstallInstanceIds = new Set<string>()

export function isInstallJobActive(instanceId: string): boolean {
  return installingInstanceIds.has(instanceId)
}

export function isAnyInstallJobActive(): boolean {
  return installingInstanceIds.size > 0
}

export function getInstallHostMemoryPressure() {
  const pressure = assessHostMemoryForHeavyOperation('steamcmd-install')
  return pressure.ok ? undefined : pressure
}

export function assertHostMemoryForInstall(): string | undefined {
  const pressure = getInstallHostMemoryPressure()
  return pressure ? `${pressure.summary}\n\n${pressure.detail}` : undefined
}

function hasOtherActiveInstallJobs(instanceId: string): boolean {
  for (const id of installingInstanceIds) {
    if (id !== instanceId) {
      return true
    }
  }
  return isSteamcmdAppUpdateBusy()
}

async function markInstallSteamcmdQueueWaiting(
  instanceId: string,
  logWriter: InstanceInstallLogWriter,
) {
  logWriter.appendLine(INSTALL_STEAMCMD_QUEUE_MESSAGE)
  await updateGameInstanceRuntime(instanceId, {
    status: 'installing',
    lastCommand: INSTALL_STEAMCMD_QUEUE_MESSAGE,
    lastError: null,
  })
}

export function getInstallLogsDirPath() {
  return resolveInstallLogsDir(loadServerConfig().dbPath)
}

export function getSteamcmdLoginCredentials(): {
  username: string
  password: string
} | undefined {
  const username = process.env.STEAMCMD_USERNAME?.trim() ?? ''
  const password = process.env.STEAMCMD_PASSWORD?.trim() ?? ''
  if (!username || !password) {
    return undefined
  }
  return { username, password }
}

function isInstallCancelled(instanceId: string): boolean {
  return cancelledInstallInstanceIds.has(instanceId)
}

async function writeInstallLogMeta(
  instanceId: string,
  status: DbInstallLogStatus,
  installPercent?: number | null,
) {
  const updatedAt = new Date().toISOString()
  await updateGameInstanceRuntime(instanceId, {
    installLogStatus: status,
    installLogUpdatedAt: updatedAt,
    ...(typeof installPercent !== 'undefined' ? { installPercent } : {}),
  })
}

export async function markInstallInterrupted(
  instanceId: string,
  logWriter: InstanceInstallLogWriter,
  detail?: string,
) {
  logWriter.appendLine(detail ?? '安装已由用户中断')
  await cancelSteamcmdInstallContainer(instanceId)
  void cleanupOrphanedSteamcmdInstallContainers(instanceId)
  const interrupted = await updateGameInstanceRuntime(instanceId, {
    status: 'error',
    lastCommand: null,
    lastError: detail ?? INSTALL_INTERRUPTED_MESSAGE,
    lastErrorPhase: 'install',
    installPercent: null,
    installLogStatus: 'failed',
    installLogUpdatedAt: new Date().toISOString(),
    // 状态机守卫：管线已落终态（成功/失败）时取消不得回头覆盖
    whereStatus: ['pending_install', 'installing'],
  })
  if (interrupted?.status === 'error') logWriter.finish('failed', detail ?? INSTALL_INTERRUPTED_MESSAGE)
}

export function shouldAllowInstallDespiteUpToDate(input: {
  status: string
  gameCode: string
  updateAvailable?: boolean | null
  lastErrorPhase?: string | null
}, installPath: string, force?: boolean): boolean {
  if (force) {
    return true
  }
  if (input.status === 'error' && input.lastErrorPhase !== 'runtime') {
    return true
  }
  if (input.gameCode.trim() === DST_APP_ID) {
    const readiness = diagnoseDstInstallReadiness(installPath)
    if (!readiness.ready) {
      return true
    }
  }
  return false
}

/** 游戏文件已在磁盘就绪时，是否可跳过 SteamCMD 下载/更新 */
export function shouldSkipSteamcmdForReadyInstall(input: {
  updateAvailable?: boolean | null
  remoteBuildId?: string | null
  localBuildId?: string | null
  forceSteamcmd?: boolean
}): boolean {
  return Boolean(!input.forceSteamcmd && !input.updateAvailable
    && input.localBuildId && input.remoteBuildId
    && input.localBuildId === input.remoteBuildId)
}

async function logInstallResourcePhase(
  logWriter: InstanceInstallLogWriter,
  instanceId: string,
  phase: string,
  extra?: Record<string, unknown>,
) {
  try {
    const { runtimeMode } = getServerContainerConfig()
    const docker = runtimeMode === 'docker' ? createDockerClient() : null
    const lines = await appendInstallResourceSnapshot(getInstallLogsDirPath(), docker, {
      instanceId,
      phase,
      extra,
    })
    for (const line of lines) {
      logWriter.appendLine(line)
    }
  }
  catch {
    logWriter.appendLine(`[资源快照 ${phase}] 记录失败`)
  }
}

export function mapDbInstallLogStatusToResponse(
  installLogStatus: DbInstallLogStatus | null,
  instanceStatus: string,
): 'success' | 'failed' | 'running' | 'unknown' {
  if (installLogStatus === 'running' || installLogStatus === 'success' || installLogStatus === 'failed') {
    return installLogStatus
  }
  if (instanceStatus === 'installing' || instanceStatus === 'pending_install') {
    return 'running'
  }
  if (instanceStatus === 'error') {
    return 'failed'
  }
  return 'unknown'
}

async function finalizeSuccessfulInstall(
  input: InstanceInstallJobInput,
  logWriter: InstanceInstallLogWriter,
  mode: 'anonymous' | 'account' | 'seed',
) {
  logWriter.appendLine('正在准备启动文件')
  await updateGameInstanceRuntime(input.instanceId, { lastCommand: '准备启动文件', whereStatus: 'installing' })
  const startScriptResult = input.appId.trim() === DST_APP_ID
    ? ensureDstLayout(input.installPath, {
        instanceName: input.instanceName,
        gamePort: input.gamePort,
      })
    : { ok: false, message: '当前仅支持饥荒（343050）' }
  if (startScriptResult.ok) {
    logWriter.appendLine('启动脚本已生成')
    logWriter.event('启动文件已准备完成。')
  }
  else {
    logWriter.appendLine(`启动脚本生成失败: ${startScriptResult.message ?? '未知错误'}`)
  }
  let runtimeImageResult: Awaited<ReturnType<typeof ensureGameRuntimeImageReady>> | undefined
  if (startScriptResult.ok) {
    if (shouldDeferDstImagePullOnInstall()) {
      logWriter.appendLine('DST 运行镜像将在首次启动实例时拉取（BSP_INSTALL_DEFER_DST_IMAGE_PULL 默认开启）')
      logWriter.event('运行环境镜像将在首次启动实例时准备。')
    }
    else {
      logWriter.appendLine('正在准备游戏运行环境镜像（首次可能需数分钟）…')
      runtimeImageResult = await ensureGameRuntimeImageReady(input.appId)
      if (runtimeImageResult.ok) {
        logWriter.appendLine('游戏运行环境镜像已就绪')
      }
      else {
        logWriter.appendLine(`游戏运行环境镜像准备失败（不影响已下载的游戏文件）：${runtimeImageResult.error}`)
        logWriter.event('运行环境镜像尚未就绪，启动实例时将自动重试准备。', 'warning')
      }
    }
  }
  const runtimeImageFailed = startScriptResult.ok
    && !shouldDeferDstImagePullOnInstall()
    && runtimeImageResult !== undefined
    && !runtimeImageResult.ok
  const runtimeHint = runtimeImageFailed
    ? '；运行环境镜像未就绪，启动时将自动重试拉取'
    : ''
  const completed = await updateGameInstanceRuntime(input.instanceId, {
    status: startScriptResult.ok ? 'stopped' : 'error',
    lastCommand: startScriptResult.ok
      ? `安装完成（${mode === 'seed' ? '本地复制' : mode}），启动脚本已生成${runtimeHint}`
      : `安装完成（${mode === 'seed' ? '本地复制' : mode}），启动脚本生成失败: ${startScriptResult.message ?? '未知错误'}`,
    lastError: startScriptResult.ok
      ? (runtimeImageFailed ? '运行环境镜像未就绪，启动实例时将自动重试拉取' : null)
      : startScriptResult.message ?? null,
    lastErrorPhase: startScriptResult.ok ? (runtimeImageFailed ? 'runtime' : null) : 'install',
    installPercent: startScriptResult.ok ? 100 : null,
    installLogStatus: startScriptResult.ok ? 'success' : 'failed',
    installLogUpdatedAt: new Date().toISOString(),
    localBuildId: readLocalBuildId(input.installPath, input.appId),
    remoteBuildId: null,
    updateCheckedAt: null,
    updateCheckError: null,
    updateAvailable: false,
    // 状态机守卫：仅当仍在安装中时落终态，避免与取消并发时覆盖取消结果
    whereStatus: 'installing',
  })
  if (startScriptResult.ok && completed?.status === 'stopped') {
    logWriter.appendLine(`安装完成（${mode === 'seed' ? '本地复制' : mode}）`)
    logWriter.finish('success', '安装完成')
    // 安装终态已经落库；网络查询失败只影响版本状态，不影响安装结果。
    void refreshInstanceUpdateStatusAfterInstall(input.instanceId, input.installPath, input.appId, input.steamcmdCommand)
      .catch(() => {})
  }
}

async function runInstallPipeline(
  input: InstanceInstallJobInput,
  logWriter: InstanceInstallLogWriter,
) {
  let progressWrites = Promise.resolve()
  let lastProgressWriteAt = 0
  let lastProgressPhase = ''
  const updateProgress = (line: string) => {
    logWriter.appendLine(line)
    const { phase, percent, status } = logWriter.progress
    if (status !== 'running' || isInstallCancelled(input.instanceId)) return
    const now = Date.now()
    if (phase === lastProgressPhase && now - lastProgressWriteAt < 1000) return
    lastProgressWriteAt = now
    lastProgressPhase = phase
    const updatedAt = new Date().toISOString()
    progressWrites = progressWrites.then(async () => {
      await updateGameInstanceRuntime(input.instanceId, {
        lastCommand: phase,
        installPercent: percent,
        installLogUpdatedAt: updatedAt,
        whereStatus: 'installing',
      })
    })
    // runner 的回调不等待数据库；在每次尝试结束时统一排空，再写终态。
    void progressWrites.catch(() => {})
  }

  if (isInstallCancelled(input.instanceId)) {
    await markInstallInterrupted(input.instanceId, logWriter)
    return
  }

  const memoryError = assertHostMemoryForInstall()
  if (memoryError) {
    logWriter.appendLine(memoryError)
    await writeInstallLogMeta(input.instanceId, 'failed', null)
    await updateGameInstanceRuntime(input.instanceId, {
      status: 'error',
      lastCommand: null,
      lastError: memoryError,
      lastErrorPhase: 'install',
      installPercent: null,
    })
    return
  }

  const pathError = prepareInstallPathForSteamcmd(input.installPath)
  if (pathError) {
    logWriter.appendLine(pathError)
    await writeInstallLogMeta(input.instanceId, 'failed', null)
    await updateGameInstanceRuntime(input.instanceId, {
      status: 'error',
      lastCommand: null,
      lastError: pathError,
      lastErrorPhase: 'install',
      installPercent: null,
    })
    return
  }

  logWriter.appendLine(
    getServerContainerConfig().runtimeMode === 'native'
      ? '安装任务启动（SteamCMD 将以 bsp 用户直接运行）'
      : '安装任务启动（已调整安装目录为 SteamCMD 容器用户可写）',
  )
  await logInstallResourcePhase(logWriter, input.instanceId, 'install_pipeline_start')
  await writeInstallLogMeta(input.instanceId, 'running', null)
  const queueHint = hasOtherActiveInstallJobs(input.instanceId)
    ? INSTALL_STEAMCMD_QUEUE_MESSAGE
    : '正在启动 SteamCMD 安装任务...'
  if (queueHint === INSTALL_STEAMCMD_QUEUE_MESSAGE) {
    logWriter.appendLine(INSTALL_STEAMCMD_QUEUE_MESSAGE)
  }
  await updateGameInstanceRuntime(input.instanceId, {
    status: 'installing',
    lastCommand: queueHint,
    lastError: null,
    installPercent: null,
  })

  const recipientReadiness = diagnoseDstInstallReadiness(input.installPath)
  const recipientAlreadyReady = recipientReadiness.ready
  if (recipientAlreadyReady && input.appId.trim() === DST_APP_ID && !input.forceSteamcmd) {
    const check = await checkGameUpdateAvailable({
      installPath: input.installPath, appId: input.appId, steamcmdCommand: input.steamcmdCommand, forceRemote: true,
    })
    const skipSteam = !check.updateAvailable && !check.message && shouldSkipSteamcmdForReadyInstall(check)
    if (skipSteam) {
      logWriter.appendLine('检测到游戏文件已完整且版本一致，跳过 Steam 下载')
      logWriter.event('游戏文件已完整且版本一致，跳过下载。')
      await finalizeSuccessfulInstall(input, logWriter, 'anonymous')
      return
    }
    logWriter.appendLine('游戏文件已存在，将通过 SteamCMD 更新至最新版本...')
  }
  if (!recipientAlreadyReady && input.appId.trim() === DST_APP_ID && !input.forceSteamcmd) {
    const seedMemory = assessHostMemoryForHeavyOperation('install-seed-copy')
    if (!seedMemory.ok) {
      logWriter.appendLine(`${seedMemory.summary}\n\n${seedMemory.detail}`)
    }
    if (seedMemory.ok) logWriter.setPhase('copy')
    const seedResult = !seedMemory.ok
      ? { ok: false as const, reason: `${seedMemory.summary}\n\n${seedMemory.detail}` }
      : await tryInstallGameDepotFromSeed({
          recipientId: input.instanceId,
          recipientPath: input.installPath,
          appId: input.appId,
        })
    if (seedResult.ok) {
      logWriter.event('本地游戏文件复制完成，跳过 Steam 下载。')
      logWriter.appendLine(
        `已从实例「${seedResult.donor.instanceName}」(${seedResult.donor.instanceId.slice(0, 8)}…) 复制游戏文件，跳过 Steam 下载`,
      )
      logWriter.appendLine(`供体 Build ID: ${seedResult.donor.localBuildId ?? '未知'}`)
      await logInstallResourcePhase(logWriter, input.instanceId, 'install_pipeline_seed_success', {
        donorId: seedResult.donor.instanceId,
      })
      await finalizeSuccessfulInstall(input, logWriter, 'seed')
      return
    }
    if (seedResult.reason) {
      logWriter.appendLine(`本地复制不可用，将使用 SteamCMD 安装：${seedResult.reason}`)
      logWriter.event('本地复制不可用，改用 SteamCMD 下载。')
    }
  }

  const loginMode = resolveSteamcmdLoginMode(input.appId)
  const useAccount = loginMode === 'account'
    || (loginMode === 'account-fallback' && Boolean(input.steamcmdCredentials))

  const withRetries = (run: () => Promise<{ ok: boolean, output: string, cancelled?: boolean }>, account = false) => {
    let attempt = 1
    const { installMaxAttempts } = loadSteamcmdRuntimeConfig()
    return retrySteamcmdInstall({
      run: async () => {
        logWriter.beginAttempt(attempt, installMaxAttempts, account)
        const result = await run()
        await progressWrites
        return result
      },
      isCancelled: () => isInstallCancelled(input.instanceId),
      onRetry: async (nextAttempt, maxAttempts, delayMs) => {
        attempt = nextAttempt
        logWriter.waitForRetry(attempt, maxAttempts, delayMs)
        logWriter.appendLine(`Steam 更新未完成或发生临时错误，${Math.round(delayMs / 1000)} 秒后进行第 ${attempt}/${maxAttempts} 次尝试（保留下载缓存）...`)
        await updateGameInstanceRuntime(input.instanceId, {
          lastCommand: `等待重试（${attempt}/${maxAttempts}）`, installPercent: null, lastError: null, whereStatus: 'installing',
        })
      },
    })
  }

  const runAnonymousInstall = async () => {
    if (isInstallCancelled(input.instanceId)) {
      return { cancelled: true as const, ok: false, output: '' }
    }
    logWriter.appendLine('正在使用 anonymous 登录安装...')
    return withRetries(() => runSteamcmdAppUpdateInContainer({
      hostInstallPath: input.installPath,
      appId: input.appId,
      loginArgs: ['+login', 'anonymous'],
      cancelKey: input.instanceId,
      onLogLine: line => void updateProgress(line),
      onAwaitingSteamcmdLock: () => markInstallSteamcmdQueueWaiting(input.instanceId, logWriter),
    }))
  }

  const runAccountInstall = async () => {
    const credentials = input.steamcmdCredentials
    if (!credentials) {
      return undefined
    }
    if (isInstallCancelled(input.instanceId)) {
      return { cancelled: true as const, ok: false, output: '' }
    }
    await updateGameInstanceRuntime(input.instanceId, {
      status: 'installing',
      lastCommand: '正在使用 Steam 账号登录安装...',
      lastError: null,
    })
    logWriter.appendLine(`正在使用 Steam 账号登录安装（${input.appId}）...`)
    return withRetries(() => runSteamcmdAppUpdateInContainer({
      hostInstallPath: input.installPath,
      appId: input.appId,
      loginArgs: ['+login', credentials.username, credentials.password],
      cancelKey: input.instanceId,
      onLogLine: line => void updateProgress(line),
      onAwaitingSteamcmdLock: () => markInstallSteamcmdQueueWaiting(input.instanceId, logWriter),
    }), true)
  }

  if (useAccount && loginMode === 'account') {
    const accountResult = await runAccountInstall()
    if (accountResult?.cancelled || isInstallCancelled(input.instanceId)) {
      await markInstallInterrupted(input.instanceId, logWriter)
      return
    }
    if (accountResult?.ok) {
      await finalizeSuccessfulInstall(input, logWriter, 'account')
      return
    }
    const failureMessage = formatSteamcmdAppUpdateFailureMessage({
      appId: input.appId,
      output: accountResult?.output ?? '',
      mode: 'account',
      hasAccountCredentials: true,
    })
    logWriter.appendLine(failureMessage)
    await writeInstallLogMeta(input.instanceId, 'failed', null)
    await updateGameInstanceRuntime(input.instanceId, {
      status: 'error',
      lastCommand: null,
      lastError: failureMessage,
      lastErrorPhase: 'install',
      installPercent: null,
      whereStatus: 'installing',
    })
    return
  }

  const anonymousResult = await runAnonymousInstall()
  if (anonymousResult.cancelled || isInstallCancelled(input.instanceId)) {
    await markInstallInterrupted(input.instanceId, logWriter)
    return
  }
  if (anonymousResult.ok) {
    await logInstallResourcePhase(logWriter, input.instanceId, 'install_pipeline_success')
    await finalizeSuccessfulInstall(input, logWriter, 'anonymous')
    return
  }

  if (loginMode === 'account-fallback' && input.steamcmdCredentials) {
    logWriter.appendLine('anonymous 失败，正在尝试账号登录重试...')
    logWriter.event('匿名连接未完成，改用 Steam 账号重试。', 'warning')
    const accountResult = await runAccountInstall()
    if (accountResult?.cancelled || isInstallCancelled(input.instanceId)) {
      await markInstallInterrupted(input.instanceId, logWriter)
      return
    }
    if (accountResult?.ok) {
      await finalizeSuccessfulInstall(input, logWriter, 'account')
      return
    }
    const anonymousDetail = formatSteamcmdAppUpdateFailureMessage({
      appId: input.appId,
      output: anonymousResult.output,
      mode: 'anonymous',
      hasAccountCredentials: true,
    })
    const accountDetail = formatSteamcmdAppUpdateFailureMessage({
      appId: input.appId,
      output: accountResult?.output ?? '',
      mode: 'account',
      hasAccountCredentials: true,
    })
    const combined = `安装失败。\n--- anonymous ---\n${anonymousDetail}\n--- account ---\n${accountDetail}`
    logWriter.appendLine(combined)
    await writeInstallLogMeta(input.instanceId, 'failed', null)
    await updateGameInstanceRuntime(input.instanceId, {
      status: 'error',
      lastCommand: null,
      lastError: combined,
      lastErrorPhase: 'install',
      installPercent: null,
    })
    return
  }

  await logInstallResourcePhase(logWriter, input.instanceId, 'install_pipeline_failed')
  const failureMessage = formatSteamcmdAppUpdateFailureMessage({
    appId: input.appId,
    output: anonymousResult.output,
    mode: 'anonymous',
    hasAccountCredentials: Boolean(input.steamcmdCredentials),
  })
  logWriter.appendLine(failureMessage)
  await writeInstallLogMeta(input.instanceId, 'failed', null)
  await updateGameInstanceRuntime(input.instanceId, {
    status: 'error',
    lastCommand: null,
    lastError: failureMessage,
    lastErrorPhase: 'install',
    installPercent: null,
    whereStatus: 'installing',
  })
}

async function runInstallJobInBackground(
  app: FastifyInstance,
  input: InstanceInstallJobInput,
  logWriter: InstanceInstallLogWriter,
) {
  try {
    await runInstallPipeline(input, logWriter)
  }
  catch (error) {
    const message = error instanceof Error ? error.message : '安装任务异常中断'
    logWriter.appendLine(message)
    await writeInstallLogMeta(input.instanceId, 'failed', null)
    app.log.error({
      instanceId: input.instanceId,
      installPath: input.installPath,
      message,
    }, '实例后台安装失败')
    await updateGameInstanceRuntime(input.instanceId, {
      status: 'error',
      lastCommand: null,
      lastError: message,
      lastErrorPhase: 'install',
      installPercent: null,
      whereStatus: 'installing',
    })
  }
  finally {
    const current = await getGameInstanceById(input.instanceId)
    if (current?.installLogStatus === 'success' || current?.installLogStatus === 'failed') {
      logWriter.finish(current.installLogStatus, current.lastError ?? '安装完成')
    }
    logWriter.flush()
  }
}

/** 启动安装/更新任务；重试时会清除取消标记 */
export function startInstallJob(
  app: FastifyInstance,
  input: InstanceInstallJobInput,
): 'started' | 'busy' | 'blocked' {
  if (installingInstanceIds.has(input.instanceId)) {
    return 'busy'
  }
  const memoryError = assertHostMemoryForInstall()
  if (memoryError) {
    app.log.warn({ instanceId: input.instanceId, memoryError }, '宿主机内存不足，拒绝启动安装任务')
    return 'blocked'
  }
  let release: () => void
  try { release = beginInstanceContentActivity(input.instanceId) } catch { return 'busy' }
  cancelledInstallInstanceIds.delete(input.instanceId)
  // 新任务从零开始：清掉上一次取消遗留的 runner 级取消标记，保证重试不受历史取消影响。
  clearSteamcmdJobCancelFlag(input.instanceId)
  clearNativeSteamcmdCancelFlag(input.instanceId)
  installingInstanceIds.add(input.instanceId)
  const logWriter = new InstanceInstallLogWriter(getInstallLogsDirPath(), input.instanceId)
  logWriter.clear(loadSteamcmdRuntimeConfig().installMaxAttempts)
  activeInstallLogWriters.set(input.instanceId, logWriter)
  void runInstallJobInBackground(app, input, logWriter)
    .finally(() => {
      release()
      installingInstanceIds.delete(input.instanceId)
      activeInstallLogWriters.delete(input.instanceId)
      logWriter.dispose()
    })
  return 'started'
}

export async function cancelInstallJob(instanceId: string): Promise<void> {
  cancelledInstallInstanceIds.add(instanceId)
  await cancelSteamcmdInstallContainer(instanceId)
  // 注意：这里不能删除 installingInstanceIds 标记——后台任务可能仍在运行，
  // 过早放行会让 startInstallJob 立即启动第二个并发安装管线（取消-重启竞态）。
  // 标记由 runInstallJobInBackground 的 finally 统一删除。
  const logWriter = activeInstallLogWriters.get(instanceId) ?? new InstanceInstallLogWriter(getInstallLogsDirPath(), instanceId)
  await markInstallInterrupted(instanceId, logWriter)
}

export function clearInstallJobTracking(instanceId: string): void {
  activeInstallLogWriters.get(instanceId)?.dispose()
  activeInstallLogWriters.delete(instanceId)
  cancelledInstallInstanceIds.delete(instanceId)
  installingInstanceIds.delete(instanceId)
}

/**
 * 面板重启后 DB 可能仍为 installing，但内存任务已丢失。
 */
export async function reconcileStaleInstallingInstances(app: FastifyInstance): Promise<number> {
  const instances = await listGameInstances({ status: 'installing' })
  let reconciled = 0
  for (const instance of instances) {
    if (instance.nodeId !== LOCAL_NODE_ID) {
      continue
    }
    if (installingInstanceIds.has(instance.id)) {
      continue
    }
    if (await isSteamcmdJobRunning(instance.id)) {
      await cancelSteamcmdInstallContainer(instance.id)
    }
    const installPath = instance.installPath?.trim() ?? ''
    const installCompletedOnDisk = Boolean(
      installPath && diagnoseDstInstallReadiness(installPath).ready,
    )
    if (installCompletedOnDisk) {
      const steamcmdCommand = await resolveSteamcmdCommandForUpdateCheck()
      await refreshInstanceUpdateStatusAfterInstall(
        instance.id,
        installPath,
        instance.gameCode,
        steamcmdCommand,
      )
      await updateGameInstanceRuntime(instance.id, {
        status: 'stopped',
        installLogStatus: 'success',
        lastCommand: '安装已完成（面板重启后已恢复状态）',
        lastError: null,
        installPercent: 100,
      })
      new InstanceInstallLogWriter(getInstallLogsDirPath(), instance.id).finish('success', '安装已完成（面板重启后已恢复状态）')
      reconciled++
      app.log.info({ instanceId: instance.id }, '安装任务已在磁盘完成，面板重启后恢复为已停止')
      continue
    }
    await updateGameInstanceRuntime(instance.id, {
      status: 'error',
      installLogStatus: 'failed',
      lastCommand: null,
      lastError: INSTALL_RESTART_INTERRUPTED_MESSAGE,
      lastErrorPhase: 'install',
      installPercent: null,
    })
    new InstanceInstallLogWriter(getInstallLogsDirPath(), instance.id).finish('failed', INSTALL_RESTART_INTERRUPTED_MESSAGE)
    reconciled++
    app.log.info({ instanceId: instance.id }, '安装任务已中断（服务重启或任务丢失），已同步为异常')
  }
  return reconciled
}

/** 面板 onReady：清理重启后遗留的 SteamCMD 安装任务 */
export async function reconcileOrphanedSteamcmdOnPanelReady(app: FastifyInstance): Promise<void> {
  const removed = await cleanupAllRunningSteamcmdInstallContainers()
  if (removed > 0) {
    app.log.warn({ removed }, '已终止面板重启后遗留的 SteamCMD 安装任务')
  }
}
