import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { readBrandEnv } from '../../../../shared/brand-env'
import { abortableDelay } from '../../shared/abort'
import { getGameInstanceById, getSystemBackupSettings, updateGameInstanceRuntime } from '../../shared/db'
import { InstanceContentBusyError, withInstanceContentOperation } from '../../shared/instance-content/operation'
import { loadSteamcmdRuntimeConfig } from '../../shared/config/steamcmd'
import { cancelStartupTask, getStartupSnapshot, startupIsActive, waitForStartupTask } from './startup-state'
import { inspectInstanceShardRuntime, stopInstanceContainer } from './container-lifecycle'
import { cancelInstallJob, getInstanceInstallProgress, getSteamcmdLoginCredentials, isInstallJobActive, startInstallJob, waitForInstallJob } from './install-service'
import { resolveSteamcmdCommandForUpdateCheck } from './update-check'
import { validateInstallPath } from './install-path-validation'

export interface ScheduledUpdateResult {
  status: 'ok' | 'failed' | 'skipped'
  message: string
  disableTask?: boolean
}

export type ScheduledUpdateStart = (instanceId: string) => Promise<{ ok: boolean, taskId?: string, message?: string }>
const activeUpdates = new Map<string, { controller: AbortController, completion: Promise<ScheduledUpdateResult> }>()

/** 运行时与安装边界集中在此，流程测试可替换边界而保留真实调度、互斥与落库。 */
export const scheduledUpdateOperations = {
  async stop(instanceId: string) {
    cancelStartupTask(instanceId)
    if (!await stopInstanceContainer(instanceId)) throw new Error('停止请求已被替换，无法确认实例停止')
    for (const shard of ['master', 'caves'] as const) {
      const probe = await inspectInstanceShardRuntime(instanceId, shard)
      if (probe.unitExists && (!probe.snapshot || probe.snapshot.running || probe.snapshot.restarting)) {
        throw new Error(`无法确认${shard === 'master' ? '主世界' : '洞穴'}已停止`)
      }
    }
  },
  async cancelInstall(instanceId: string) {
    const current = await getGameInstanceById(instanceId)
    if (isInstallJobActive(instanceId) || current?.installLogStatus === 'running'
      || (current && getInstanceInstallProgress(current)?.cleanupPending)) await cancelInstallJob(instanceId)
  },
  async install(app: FastifyInstance, instanceId: string, signal: AbortSignal) {
    const current = await getGameInstanceById(instanceId)
    if (!current) throw new Error('实例已删除')
    const installPath = current.installPath?.trim() ?? ''
    const invalidPath = validateInstallPath(installPath)
    if (invalidPath) throw new Error(invalidPath)
    const settings = await getSystemBackupSettings()
    const steamcmdCommand = await resolveSteamcmdCommandForUpdateCheck()
    signal.throwIfAborted()
    const taskId = randomUUID()
    await updateGameInstanceRuntime(instanceId, {
      status: 'installing', lastCommand: '正在准备定时更新...', lastError: null,
      installPercent: null, installLogStatus: 'running',
    })
    signal.throwIfAborted()
    const started = startInstallJob(app, {
      instanceId, taskId, kind: 'update', appId: current.gameCode, instanceName: current.name,
      gamePort: current.gamePort, installPath, steamcmdCommand, steamcmdCredentials: getSteamcmdLoginCredentials(),
      backupBeforeUpdate: settings.autoBackupBeforeUpdate && fs.existsSync(path.join(installPath, 'klei-storage')),
      forceSteamcmd: true, maxAttempts: 1,
    })
    if (started !== 'started') {
      await updateGameInstanceRuntime(instanceId, { status: current.status, installLogStatus: current.installLogStatus })
      throw new Error(started === 'busy' ? '已有安装任务进行中' : '宿主机资源不足，无法更新')
    }
    let cancellation: Promise<void> | undefined
    const cancel = () => {
      cancellation ??= cancelInstallJob(instanceId)
      void cancellation.catch(() => {})
    }
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    try {
      const result = await waitForInstallJob(instanceId, taskId)
      await cancellation
      return result
    }
    finally { signal.removeEventListener('abort', cancel) }
  },
  waitForStartup: waitForStartupTask,
  retryDelay: abortableDelay,
}

export function isScheduledUpdateActive(instanceId: string): boolean { return activeUpdates.has(instanceId) }

/** 用户停止也能取消重试等待阶段；等待清理完成后停止路由再确认停机。 */
export async function cancelScheduledUpdate(instanceId: string): Promise<void> {
  const active = activeUpdates.get(instanceId)
  if (!active) return
  active.controller.abort(new Error('用户手动停止，已取消定时更新'))
  await active.completion
}

export function runScheduledUpdate(
  app: FastifyInstance, instanceId: string, start: ScheduledUpdateStart,
  progress: (message: string) => Promise<void>,
): Promise<ScheduledUpdateResult> {
  if (activeUpdates.has(instanceId)) return Promise.resolve({ status: 'skipped', message: '实例正在执行定时更新，已跳过本次执行' })
  const controller = new AbortController()
  const completion = Promise.resolve().then(async (): Promise<ScheduledUpdateResult> => {
    try {
      return await withInstanceContentOperation(instanceId, async (): Promise<ScheduledUpdateResult> => {
        const current = await getGameInstanceById(instanceId)
        if (!current || current.nodeId !== 'local-node' || current.gameCode !== '343050') return { status: 'skipped', message: '实例不存在或不是本地 DST 实例' }
        if (isInstallJobActive(instanceId) || ['pending_install', 'installing', 'updating'].includes(current.status)
          || startupIsActive(getStartupSnapshot(instanceId, current.lastStartupReport))) {
          return { status: 'skipped', message: '实例正在安装、更新或启动，已跳过本次执行' }
        }
        if (current.runtimeFailureKind === 'memory_protection' || current.lastStartupReport?.caves.protectionStop) {
          return { status: 'skipped', message: '实例已内存保护停止，需要用户手动处理' }
        }
        let stage = '停止实例'
        let attempt = 0
        let stopped = false
        try {
          controller.signal.throwIfAborted()
          await progress('正在停止实例（更新尝试 0/3）')
          await scheduledUpdateOperations.stop(instanceId)
          stopped = true
          const delays = readBrandEnv('BSP_STEAMCMD_INSTALL_RETRY_DELAYS_MS')?.trim()
            ? loadSteamcmdRuntimeConfig().installRetryDelaysMs : [5000, 10000]
          let updateSucceeded = false
          for (attempt = 1; attempt <= 3; attempt++) {
            controller.signal.throwIfAborted()
            stage = '更新服务端'
            await progress(`正在更新服务端（第 ${attempt}/3 次尝试）`)
            let failure = ''
            try {
              const installed = await scheduledUpdateOperations.install(app, instanceId, controller.signal)
              if (installed.cleanupPending) throw new Error(`更新任务清理未完成：${installed.message}`)
              if (installed.cancelled) {
                controller.abort(new Error('更新已取消'))
                controller.signal.throwIfAborted()
              }
              if (installed.ok) { updateSucceeded = true; break }
              failure = installed.message
            }
            catch (error) {
              if (controller.signal.aborted || /清理未完成|无法确认.*停止/.test(errorMessage(error))) throw error
              failure = errorMessage(error)
            }
            if (attempt === 3) throw new Error(failure)
            const delayMs = delays[attempt - 1] ?? delays.at(-1) ?? 10000
            await progress(`第 ${attempt}/3 次更新失败：${failure}；${Math.ceil(delayMs / 1000)} 秒后重试`)
            await scheduledUpdateOperations.retryDelay(delayMs, controller.signal)
          }
          if (!updateSucceeded) throw new Error('更新未完成')
          controller.signal.throwIfAborted()
          stage = '更新完成，启动失败'
          await progress(`更新完成（第 ${attempt}/3 次），正在启动实例`)
          const accepted = await start(instanceId)
          if (!accepted.ok || !accepted.taskId) throw new Error(accepted.message ?? '未取得启动任务')
          const startup = await scheduledUpdateOperations.waitForStartup(instanceId, accepted.taskId, controller.signal)
          if (startup.status !== 'success' || startup.phase !== 'ready') throw new Error(startup.diagnosis?.message ?? '启动未就绪')
          controller.signal.throwIfAborted()
          return { status: 'ok', message: `服务端更新完成，实例已就绪（第 ${attempt}/3 次尝试）` }
        }
        catch (error) {
          let cleanupError = ''
          try {
            await scheduledUpdateOperations.cancelInstall(instanceId)
            await scheduledUpdateOperations.stop(instanceId)
            stopped = true
          }
          catch (cleanup) { stopped = false; cleanupError = `；清理失败：${errorMessage(cleanup)}` }
          const reason = controller.signal.aborted ? errorMessage(controller.signal.reason) : errorMessage(error)
          if (stopped) await updateGameInstanceRuntime(instanceId, {
            status: 'stopped', lastError: reason, lastErrorPhase: stage === '更新服务端' ? 'install' : 'runtime',
          })
          return {
            status: controller.signal.aborted && stopped ? 'skipped' : 'failed', disableTask: true,
            message: `${stage}：${reason}（更新尝试 ${attempt}/3）；${stopped ? '实例已停止' : '未能确认实例停止'}，任务已停用${cleanupError}`,
          }
        }
      })
    }
    catch (error) {
      if (error instanceof InstanceContentBusyError) return { status: 'skipped', message: error.message }
      return { status: 'failed', disableTask: true, message: `定时更新未执行：${errorMessage(error)}；任务已停用` }
    }
  }).finally(() => { activeUpdates.delete(instanceId) })
  activeUpdates.set(instanceId, { controller, completion })
  return completion
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

/** 启动恢复先撤销启动任务，再清理遗留 SteamCMD 与分片，不恢复自动更新。 */
export async function cleanupInterruptedScheduledUpdate(instanceId: string): Promise<string> {
  try {
    const current = await getGameInstanceById(instanceId)
    const snapshot = getStartupSnapshot(instanceId, current?.lastStartupReport)
    cancelStartupTask(instanceId)
    // 即使后面的运行时清理失败，也不能让启动恢复器续跑旧的排队检查点。
    if (snapshot && startupIsActive(snapshot)) await updateGameInstanceRuntime(instanceId, {
      lastStartupReport: { ...snapshot, status: 'cancelled', phase: 'cancelled', phaseDeadlineAt: null, updatedAt: new Date().toISOString() },
    })
    await scheduledUpdateOperations.cancelInstall(instanceId)
    await scheduledUpdateOperations.stop(instanceId)
    return '实例已停止'
  }
  catch (error) { return `未能确认实例停止：${errorMessage(error)}` }
}
