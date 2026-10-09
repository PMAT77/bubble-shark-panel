import { withInstanceContentActivity, markInstanceContentCleanupPending } from '../../shared/instance-content/operation'
import type { FastifyInstance } from 'fastify'
import process from 'node:process'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { UpdateGameInstanceRuntimeInput, DbGameInstance } from '../../shared/db'
import { instanceInstallTaskSchema, type InstanceInstallProgress } from '../../../../shared/contracts/instance'
import { createPullProgressAggregator } from '../../infra/container/image-candidates'
import type { DbInstallLogStatus } from '../../shared/db/index'
import {
  listGameInstances,
  getGameInstanceById,
  updateGameInstanceRuntime as persistGameInstanceRuntime,
} from '../../shared/db/index'
import { loadServerConfig, resolveInstallLogsDir } from '../../shared/config'
import { abortable } from '../../shared/abort'
import { ensureContainerRuntimeReady } from './container-lifecycle'
import { createInstanceBackup } from '../backup/backup-service'
import { summarizeInstallFailure } from '../../shared/instance-install/log-format'
import {
  InstanceInstallLogWriter,
  readInstallProgress,
} from '../../shared/instance-install/log-store'
import { loadSteamcmdRuntimeConfig, resolveSteamcmdAppUpdateTimeoutMs } from '../../shared/config/steamcmd'
import { resolveSteamcmdLoginMode } from '../../shared/instance-install/steamcmd-login-mode'
import {
  assessHostMemoryForHeavyOperation,
  cancelSteamcmdInstallContainer,
  cleanupAllRunningSteamcmdInstallContainers,
  cleanupOrphanedSteamcmdInstallContainers,
  clearNativeSteamcmdCancelFlag,
  clearSteamcmdJobCancelFlag,
  hasUnconfirmedSteamcmdJob,
  runSteamcmdAppUpdateInContainer,
} from '../../infra/container'
import { isSteamcmdAppUpdateBusy } from '../../infra/container/steamcmd-app-update-queue'
import { createDockerClient } from '../../infra/docker-connect'
import { getServerContainerConfig } from '../../shared/config/container'
import { appendInstallResourceSnapshot } from '../../infra/container/install-resource-monitor'
import {
  formatSteamcmdAppUpdateFailureMessage,
} from '../../infra/container/steamcmd-errors'
import { DST_APP_ID, DST_STORAGE_DIR, DST_CONF_DIR, DST_CLUSTER_NAME } from '../../infra/game-adapter/dst/constants'
import { validateSteamcmdAppUpdateResult } from '../../infra/container/steamcmd-app-update-result'
import { isGameDstImagePresent } from '../../infra/container/game-dst-image'
import { diagnoseDstInstallReadiness } from '../../infra/game-adapter/dst/install-readiness'
import { ensureDstLayout } from '../../infra/game-adapter/dst/cluster-config'
import { prepareInstallPathForSteamcmdAsync } from './install-path'
import { retrySteamcmdInstall } from './steamcmd-install-retry'
import { ensureGameRuntimeImageReady } from '../../infra/game-adapter/runtime-image'
import { refreshInstanceUpdateStatusAfterInstall, resolveSteamcmdCommandForUpdateCheck } from './update-check'
import { checkGameUpdateAvailable, readLocalBuildId } from '../../shared/steam-update/build-id'
import { tryInstallGameDepotFromSeed } from './install-seed'

export interface InstanceInstallJobInput {
  taskId?: string
  kind?: 'install' | 'update'
  backupBeforeUpdate?: boolean
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
const cleanupPendingInstanceIds = new Set<string>()
const installJobs = new Map<string, { taskId: string, controller: AbortController, completion: Promise<void> }>()
const installContext = new AsyncLocalStorage<{ instanceId: string, taskId: string }>()

/** 安装调用链的每次写入都带任务身份；晚到的旧回调不能更新新的安装。 */
async function updateGameInstanceRuntime(id: string, patch: UpdateGameInstanceRuntimeInput) {
  if (patch.installLogStatus === 'success') assertNotCancelled(id)
  const context = installContext.getStore()
  const taskId = context?.instanceId === id ? context.taskId : installJobs.get(id)?.taskId
  return persistGameInstanceRuntime(id, { ...patch,
    whereInstallTaskId: patch.whereInstallTaskId !== undefined ? patch.whereInstallTaskId : taskId,
  })
}

export function getInstallTaskId(id: string) { return installJobs.get(id)?.taskId }

function hasCleanupFailure(instance: DbGameInstance) {
  return instance.lastErrorPhase === 'install' && /无法确认.*停止|清理未完成/.test(instance.lastError ?? '')
}

export function getInstanceInstallProgress(instance: DbGameInstance) {
  let progress = activeInstallLogWriters.get(instance.id)?.progress
  if (!progress) {
    try { progress = readInstallProgress(getInstallLogsDirPath(), instance.id) ?? undefined } catch { /* 用数据库摘要兜底。 */ }
  }
  if (progress && (progress.taskId ?? null) !== (instance.installTaskId ?? null)) progress = undefined
  if (!progress && !instance.installTaskId && !hasCleanupFailure(instance)) return null
  const result: InstanceInstallProgress = progress ? structuredClone(progress) : {
    taskId: instance.installTaskId!, phaseCode: 'prepare' as const, phase: instance.lastCommand ?? '准备安装环境',
    percent: null, overallPercent: instance.installPercent, updatedAt: instance.installLogUpdatedAt,
    attempt: 1, maxAttempts: 1, retryAt: null, status: 'running' as const, failure: null, events: [],
  }
  const status = instance.installLogStatus
  if (status) {
    result.status = status
    if (status !== 'running') { result.percent = null; result.retryAt = null }
    if (status === 'success') { result.phaseCode = 'complete'; result.phase = '安装完成'; if (result.taskId) result.overallPercent = 100 }
    if (status === 'failed') result.failure = { ...summarizeInstallFailure(instance.lastError ?? '安装未完成'), phase: result.phaseCode }
    if (status === 'cancelled') { result.phase = '安装已取消'; result.failure = null }
  }
  result.cleanupPending = hasCleanupFailure(instance) || cleanupPendingInstanceIds.has(instance.id) || (!installJobs.has(instance.id) && hasUnconfirmedSteamcmdJob(instance.id))
  return result
}

export function projectInstanceInstallTask(instance: DbGameInstance) {
  const progress = getInstanceInstallProgress(instance)
  return { ...instance, installTask: progress ? instanceInstallTaskSchema.parse(progress) : null }
}

function imageProgress(writer: InstanceInstallLogWriter) {
  const bytes = createPullProgressAggregator()
  return (event: unknown) => {
    const status = (event as { status?: string } | null)?.status
    if (status === 'Extracting') { writer.setMeasuredPercent(null); return }
    bytes.handle(event)
    const total = bytes.snapshot()
    writer.recordBytes(total.downloadedBytes, total.totalBytes)
    writer.setMeasuredPercent(total.totalBytes > 0 ? total.downloadedBytes / total.totalBytes * 100 : null)
  }
}

function displayInstallFailure(message: string) {
  const failure = summarizeInstallFailure(message)
  return failure.message + '\n' + failure.advice
}

function installSignal(id: string): AbortSignal | undefined { return installJobs.get(id)?.controller.signal }
function assertNotCancelled(id: string) { installSignal(id)?.throwIfAborted() }

export function isInstallJobActive(instanceId: string): boolean {
  return installingInstanceIds.has(instanceId) || cleanupPendingInstanceIds.has(instanceId)
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
  logWriter: InstanceInstallLogWriter | undefined,
  detail?: string,
) {
  try { logWriter?.appendLine(detail ?? '安装已由用户取消') } catch { /* 取消不依赖日志可写。 */ }
  await cancelSteamcmdInstallContainer(instanceId)
  void cleanupOrphanedSteamcmdInstallContainers(instanceId)
  const interrupted = await updateGameInstanceRuntime(instanceId, {
    status: 'stopped',
    lastCommand: '安装已取消',
    lastError: null,
    installPercent: null,
    installLogStatus: 'cancelled',
    installLogUpdatedAt: new Date().toISOString(),
    // 状态机守卫：管线已落终态（成功/失败）时取消不得回头覆盖
    whereStatus: ['pending_install', 'installing', 'error'],
  })
  if (interrupted?.installLogStatus === 'cancelled') {
    try { logWriter?.finish('cancelled', '安装已取消') } catch { /* 数据库保存取消结果。 */ }
  }
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
      signal: installSignal(instanceId),
    })
    for (const line of lines) {
      logWriter.appendLine(line)
    }
  }
  catch {
    assertNotCancelled(instanceId)
    logWriter.appendLine(`[资源快照 ${phase}] 记录失败`)
  }
}

export function mapDbInstallLogStatusToResponse(
  installLogStatus: DbInstallLogStatus | null,
  instanceStatus: string,
): 'success' | 'failed' | 'cancelled' | 'running' | 'unknown' {
  if (installLogStatus === 'running' || installLogStatus === 'success' || installLogStatus === 'failed' || installLogStatus === 'cancelled') {
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
  assertNotCancelled(input.instanceId)
  logWriter.completeWork('connect')
  logWriter.completeWork('files')
  logWriter.setPhase('finalize')
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
  if (!startScriptResult.ok) throw new Error('准备启动文件失败：' + startScriptResult.message)
  logWriter.completeWork('layout')
  assertNotCancelled(input.instanceId)
  logWriter.appendLine('正在准备游戏运行环境镜像（首次可能需数分钟）…')
  const runtimeImageResult = await ensureGameRuntimeImageReady(input.appId, { signal: installSignal(input.instanceId), onProgress: imageProgress(logWriter), timeoutMs: resolveSteamcmdAppUpdateTimeoutMs() })
  if (!runtimeImageResult.ok) throw new Error('游戏运行环境镜像准备失败：' + runtimeImageResult.error)
  if (getServerContainerConfig().runtimeMode === 'native') {
    const ready = await abortable(ensureContainerRuntimeReady(), installSignal(input.instanceId))
    if (!ready.ok) throw new Error(ready.message)
  }
  assertNotCancelled(input.instanceId)
  logWriter.completeWork('runtime')
  logWriter.appendLine('运行环境已就绪')
  logWriter.progress.readyToCommit = true
  logWriter.flush()
  const completed = await updateGameInstanceRuntime(input.instanceId, {
    status: 'stopped',
    lastCommand: '安装完成，可以启动实例',
    lastError: null,
    installPercent: 100,
    installLogStatus: 'success',
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
    // 已落库的成功不能被随后的日志异常改成失败。
    try {
      logWriter.appendLine(`安装完成（${mode === 'seed' ? '本地复制' : mode}）`)
      logWriter.finish('success', '安装完成')
    }
    catch { /* 数据库终态优先。 */ }
    // 安装终态已经落库；网络查询失败只影响版本状态，不影响安装结果。
    void refreshInstanceUpdateStatusAfterInstall(input.instanceId, input.installPath, input.appId, input.steamcmdCommand)
      .catch(() => {})
  }
}

async function runInstallPipeline(
  input: InstanceInstallJobInput,
  logWriter: InstanceInstallLogWriter,
) {
  const updateProgress = (line: string) => {
    assertNotCancelled(input.instanceId)
    logWriter.appendLine(line)
  }

  if (isInstallCancelled(input.instanceId)) {
    await markInstallInterrupted(input.instanceId, logWriter)
    return
  }

  const memoryError = assertHostMemoryForInstall()
  if (memoryError) {
    throw new Error(memoryError)
  }

  const pathError = await prepareInstallPathForSteamcmdAsync(input.installPath, installSignal(input.instanceId))
  if (pathError) {
    throw new Error(pathError)
  }
  const runtimeMode = getServerContainerConfig().runtimeMode
  if (runtimeMode === 'docker') { logWriter.completeWork('prepare'); logWriter.setPhase('steamcmd_image') }
  const ready = await abortable(ensureContainerRuntimeReady({ signal: installSignal(input.instanceId), onProgress: imageProgress(logWriter), timeoutMs: resolveSteamcmdAppUpdateTimeoutMs() }), installSignal(input.instanceId))
  if (!ready.ok) throw new Error(ready.message ?? '安装运行环境不可用')
  assertNotCancelled(input.instanceId)
  logWriter.completeWork(runtimeMode === 'docker' ? 'steamcmd_image' : 'prepare')

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

  if (input.backupBeforeUpdate) {
    logWriter.setPhase('backup')
    logWriter.event('正在创建更新前备份。')
    const signal = AbortSignal.any([installSignal(input.instanceId)!, AbortSignal.timeout(resolveSteamcmdAppUpdateTimeoutMs())])
    const backup = await createInstanceBackup({ instanceId: input.instanceId, kind: 'pre_update', saveBeforeArchive: false, signal })
    assertNotCancelled(input.instanceId)
    if (!backup.ok) throw new Error('更新前备份失败，已停止更新：' + backup.message)
    logWriter.event('更新前备份已完成。')
    logWriter.completeWork('backup')
  }

  logWriter.setPhase('source')

  const recipientReadiness = diagnoseDstInstallReadiness(input.installPath)
  const recipientAlreadyReady = recipientReadiness.ready
  if (recipientAlreadyReady && input.appId.trim() === DST_APP_ID && !input.forceSteamcmd) {
    const check = await abortable(checkGameUpdateAvailable({
      installPath: input.installPath, appId: input.appId, steamcmdCommand: input.steamcmdCommand, forceRemote: true,
    }), installSignal(input.instanceId))
    const skipSteam = !check.updateAvailable && !check.message && shouldSkipSteamcmdForReadyInstall(check)
    if (skipSteam) {
      logWriter.completeWork('source')
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
    const seedResult = !seedMemory.ok
      ? { ok: false as const, reason: `${seedMemory.summary}\n\n${seedMemory.detail}` }
      : await tryInstallGameDepotFromSeed({
          signal: AbortSignal.any([installSignal(input.instanceId)!, AbortSignal.timeout(resolveSteamcmdAppUpdateTimeoutMs())]),
          recipientId: input.instanceId,
          recipientPath: input.installPath,
          appId: input.appId,
          onProgress: (copied, total) => {
            logWriter.completeWork('source')
            logWriter.completeWork('connect')
            logWriter.setPhase('copy')
            logWriter.setMeasuredPercent(total > 0 ? copied / total * 100 : null)
            logWriter.recordBytes(copied, total)
          },
        })
    assertNotCancelled(input.instanceId)
    if ('failed' in seedResult && seedResult.failed) throw new Error(seedResult.reason)
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

  logWriter.completeWork('source')

  const loginMode = resolveSteamcmdLoginMode(input.appId)
  const useAccount = loginMode === 'account'
    || (loginMode === 'account-fallback' && Boolean(input.steamcmdCredentials))

  const withRetries = (run: () => Promise<{ ok: boolean, output: string, cancelled?: boolean }>, account = false) => {
    let attempt = 1
    const { installMaxAttempts } = loadSteamcmdRuntimeConfig()
    return retrySteamcmdInstall({
      signal: installSignal(input.instanceId),
      run: async () => {
        logWriter.beginAttempt(attempt, installMaxAttempts, account)
        const result = await run()
        return result
      },
      isCancelled: () => isInstallCancelled(input.instanceId),
      onRetry: async (nextAttempt, maxAttempts, delayMs) => {
        attempt = nextAttempt
        logWriter.waitForRetry(attempt, maxAttempts, delayMs)
        logWriter.appendLine(`Steam 更新未完成或发生临时错误，${Math.round(delayMs / 1000)} 秒后进行第 ${attempt}/${maxAttempts} 次尝试（保留下载缓存）...`)
        await updateGameInstanceRuntime(input.instanceId, {
          lastCommand: `等待重试（${attempt}/${maxAttempts}）`, lastError: null, whereStatus: 'installing',
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
      signal: installSignal(input.instanceId),
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
      signal: installSignal(input.instanceId),
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
      lastError: displayInstallFailure(failureMessage),
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
      lastError: displayInstallFailure(combined),
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
    lastError: displayInstallFailure(failureMessage),
    lastErrorPhase: 'install',
    installPercent: null,
    whereStatus: 'installing',
  })
}

async function runInstallJobInBackground(
  app: FastifyInstance,
  input: InstanceInstallJobInput,
) {
  let logWriter: InstanceInstallLogWriter | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let progressWrites = Promise.resolve()
  let lastPercent: number | null = null
  let lastPhase = ''
  try {
    logWriter = new InstanceInstallLogWriter(getInstallLogsDirPath(), input.instanceId)
    logWriter.clear(loadSteamcmdRuntimeConfig().installMaxAttempts, {
      taskId: input.taskId!, kind: input.kind ?? 'install', runtimeMode: getServerContainerConfig().runtimeMode,
      backup: Boolean(input.backupBeforeUpdate),
    })
    activeInstallLogWriters.set(input.instanceId, logWriter)
    const writer = logWriter
    heartbeat = setInterval(() => {
      if (writer.progress.status !== 'running' || isInstallCancelled(input.instanceId)) return
      writer.tick()
      const { overallPercent, phase, updatedAt } = writer.progress
      if (overallPercent === lastPercent && phase === lastPhase) return
      lastPercent = overallPercent ?? null
      lastPhase = phase
      progressWrites = progressWrites.then(async () => {
        await updateGameInstanceRuntime(input.instanceId, {
          installPercent: overallPercent, lastCommand: phase, installLogUpdatedAt: updatedAt,
          whereStatus: ['pending_install', 'installing'],
        })
      })
      void progressWrites.catch(error => installJobs.get(input.instanceId)?.controller.abort(error))
    }, 1000)
    heartbeat.unref()
    await runInstallPipeline(input, logWriter)
    await progressWrites
  }
  catch (error) {
    const message = error instanceof Error ? error.message : '安装任务异常中断'
    app.log.error({
      instanceId: input.instanceId,
      installPath: input.installPath,
      message,
    }, '实例后台安装失败')
    if (isInstallCancelled(input.instanceId) && logWriter) {
      await markInstallInterrupted(input.instanceId, logWriter)
      return
    }
    const failure = summarizeInstallFailure(message)
    await updateGameInstanceRuntime(input.instanceId, {
      status: 'error',
      lastCommand: null,
      lastError: failure.message + '\n' + failure.advice,
      lastErrorPhase: 'install',
      installPercent: null,
      installLogStatus: 'failed',
      installLogUpdatedAt: new Date().toISOString(),
      whereStatus: ['pending_install', 'installing'],
    })
    try { logWriter?.appendLine(message) } catch { /* 失败落库不能依赖日志写入。 */ }
  }
  finally {
    if (heartbeat) clearInterval(heartbeat)
    await progressWrites.catch(() => {})
    try {
      const current = await getGameInstanceById(input.instanceId)
      if (current?.installLogStatus && current.installLogStatus !== 'running') {
        logWriter?.finish(current.installLogStatus, current.lastError ?? current.lastCommand ?? '安装完成')
      }
      logWriter?.flush()
    }
    catch (error) { app.log.warn({ instanceId: input.instanceId, error }, '保存安装日志终态失败，数据库结果仍有效') }
    logWriter?.dispose()
  }
}

/** 启动安装/更新任务；重试时会清除取消标记 */
export function startInstallJob(
  app: FastifyInstance,
  input: InstanceInstallJobInput,
): 'started' | 'busy' | 'blocked' {
  if (isInstallJobActive(input.instanceId)) {
    return 'busy'
  }
  cancelledInstallInstanceIds.delete(input.instanceId)
  // 新任务从零开始：清掉上一次取消遗留的 runner 级取消标记，保证重试不受历史取消影响。
  clearSteamcmdJobCancelFlag(input.instanceId)
  clearNativeSteamcmdCancelFlag(input.instanceId)
  installingInstanceIds.add(input.instanceId)
  const controller = new AbortController()
  input = { ...input, taskId: input.taskId ?? randomUUID() }
  const entry = { taskId: input.taskId!, controller, completion: Promise.resolve() }
  installJobs.set(input.instanceId, entry)
  entry.completion = Promise.resolve().then(() => installContext.run({ instanceId: input.instanceId, taskId: entry.taskId }, () => withInstanceContentActivity(input.instanceId, async () => {
    await persistGameInstanceRuntime(input.instanceId, {
      installTaskId: entry.taskId, installPercent: 1, installLogStatus: 'running',
      installLogUpdatedAt: new Date().toISOString(), whereStatus: ['pending_install', 'installing'],
    })
    await runInstallJobInBackground(app, input)
  })))
    .catch(async error => {
      app.log.error({ instanceId: input.instanceId, error }, '安装任务结束处理失败')
      await updateGameInstanceRuntime(input.instanceId, {
        status: 'error', installLogStatus: 'failed', lastErrorPhase: 'install',
        lastError: error instanceof Error ? error.message : '安装任务无法完成，请检查数据库、安装目录和运行环境后重试。',
        whereStatus: ['pending_install', 'installing'],
      }).catch(() => {})
    })
    .finally(() => {
      if (hasUnconfirmedSteamcmdJob(input.instanceId)) {
        cleanupPendingInstanceIds.add(input.instanceId)
        markInstanceContentCleanupPending(input.instanceId, true)
        const writer = activeInstallLogWriters.get(input.instanceId)
        if (writer) {
          writer.progress.cleanupPending = true
          try { writer.flush() } catch { /* 数据库失败状态仍保留。 */ }
        }
      }
      installingInstanceIds.delete(input.instanceId)
      activeInstallLogWriters.delete(input.instanceId)
      if (installJobs.get(input.instanceId) === entry) installJobs.delete(input.instanceId)
    })
  return 'started'
}

export async function cancelInstallJob(instanceId: string): Promise<void> {
  cancelledInstallInstanceIds.add(instanceId)
  const task = installJobs.get(instanceId)
  try { activeInstallLogWriters.get(instanceId)?.setPhase('cancelling') } catch { /* 取消不依赖日志。 */ }
  task?.controller.abort(new Error('安装已取消'))
  try { await cancelSteamcmdInstallContainer(instanceId, !task) }
  catch (error) {
    cleanupPendingInstanceIds.add(instanceId)
    markInstanceContentCleanupPending(instanceId, true)
    const message = '无法确认安装任务已停止，请恢复运行环境后再次停止实例'
    await updateGameInstanceRuntime(instanceId, { status: 'error', installLogStatus: 'failed', lastErrorPhase: 'install', lastError: message })
    const writer = activeInstallLogWriters.get(instanceId)
    if (writer) { writer.progress.cleanupPending = true; try { writer.flush() } catch { /* 保留内存占用保护。 */ } }
    throw new Error(message, { cause: error })
  }
  cleanupPendingInstanceIds.delete(instanceId)
  markInstanceContentCleanupPending(instanceId, false)
  // 注意：这里不能删除 installingInstanceIds 标记——后台任务可能仍在运行，
  // 过早放行会让 startInstallJob 立即启动第二个并发安装管线（取消-重启竞态）。
  // 标记由 runInstallJobInBackground 的 finally 统一删除。
  if (task) {
    await task.completion
    if (cleanupPendingInstanceIds.has(instanceId)) throw new Error('无法确认安装任务已停止，请恢复运行环境后再次停止')
  }
  else {
    let logWriter: InstanceInstallLogWriter | undefined
    try { logWriter = new InstanceInstallLogWriter(getInstallLogsDirPath(), instanceId) } catch { /* 数据库仍可保存取消。 */ }
    try { await markInstallInterrupted(instanceId, logWriter) } finally { logWriter?.dispose() }
  }
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
  const all = await listGameInstances()
  for (const instance of all) {
    if (instance.nodeId !== LOCAL_NODE_ID || installingInstanceIds.has(instance.id)) continue
    let pending = hasCleanupFailure(instance)
    try { pending ||= readInstallProgress(getInstallLogsDirPath(), instance.id)?.cleanupPending ?? false } catch { /* 其它终态按数据库保留。 */ }
    if (pending) {
      cleanupPendingInstanceIds.add(instance.id)
      markInstanceContentCleanupPending(instance.id, true)
    }
  }
  const instances = all.filter(instance => instance.status === 'installing' || instance.status === 'pending_install')
  let reconciled = 0
  for (const instance of instances) {
    if (instance.nodeId !== LOCAL_NODE_ID) {
      continue
    }
    if (installingInstanceIds.has(instance.id)) {
      continue
    }
    try { await cancelSteamcmdInstallContainer(instance.id, true) }
    catch {
      cleanupPendingInstanceIds.add(instance.id)
      markInstanceContentCleanupPending(instance.id, true)
      await persistGameInstanceRuntime(instance.id, { status: 'error', installLogStatus: 'failed', lastErrorPhase: 'install',
        lastError: '安装中断且无法确认外部任务已停止，请恢复运行环境后再次停止实例', whereInstallTaskId: instance.installTaskId ?? null })
      reconciled++
      continue
    }
    const installPath = instance.installPath?.trim() ?? ''
    const cluster = path.join(installPath, DST_STORAGE_DIR, DST_CONF_DIR, DST_CLUSTER_NAME)
    const filesComplete = installPath && validateSteamcmdAppUpdateResult({ ok: true, output: '' }, installPath, instance.gameCode).ok
      && ['cluster.ini', 'Master/server.ini', 'Master/worldgenoverride.lua'].every(file => fs.existsSync(path.join(cluster, file)))
    const runtimeReady = getServerContainerConfig().runtimeMode === 'native'
      ? (await ensureContainerRuntimeReady()).ok : await isGameDstImagePresent()
    const checkpoint = getInstanceInstallProgress(instance)
    const installCompletedOnDisk = Boolean(filesComplete && runtimeReady && (!instance.installTaskId || checkpoint?.readyToCommit))
    if (installCompletedOnDisk) {
      await updateGameInstanceRuntime(instance.id, {
        status: 'stopped',
        installLogStatus: 'success',
        lastCommand: '安装已完成（面板重启后已恢复状态）',
        lastError: null,
        installPercent: 100,
        whereInstallTaskId: instance.installTaskId ?? null,
      })
      try { new InstanceInstallLogWriter(getInstallLogsDirPath(), instance.id).finish('success', '安装已完成（面板重启后已恢复状态）') } catch { /* 数据库终态有效。 */ }
      void resolveSteamcmdCommandForUpdateCheck().then(command => refreshInstanceUpdateStatusAfterInstall(instance.id, installPath, instance.gameCode, command)).catch(() => {})
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
      whereInstallTaskId: instance.installTaskId ?? null,
    })
    try { new InstanceInstallLogWriter(getInstallLogsDirPath(), instance.id).finish('failed', INSTALL_RESTART_INTERRUPTED_MESSAGE) } catch { /* 数据库终态有效。 */ }
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
