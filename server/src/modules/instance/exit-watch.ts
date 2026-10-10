import { readBrandEnv } from '../../../../shared/brand-env'
import type { FastifyInstance } from 'fastify'
import { LOCAL_NODE_ID } from '../../shared/dst/local-dst-instance'
import { getGameInstanceById, listGameInstances, updateGameInstanceRuntime } from '../../shared/db/index'
import { emitPanelEvent } from '../notify/events'
import { isInstallJobActive } from './install-service'
import { isInstanceContainerRunning } from './container-lifecycle'
import { getStartupSnapshot, startupIsActive } from './startup-state'

const WATCH_INTERVAL_MS = 60_000
/** 刚启动的实例不参与异常退出判定（容器注册/DB 同步存在短暂窗口） */
const START_GRACE_MS = 90_000

let watchTimer: NodeJS.Timeout | null = null
let watchStarted = false
let watchInFlight = false

function isUnitTest(): boolean {
  return readBrandEnv('BSP_UNIT_TEST') === '1'
}

/**
 * 崩溃感知对账：DB 记录 running 但运行时已无该实例进程。
 * Docker on-failure 重试耗尽 / systemd Restart 放弃后实例“静默死亡”，
 * 面板若不主动对账，服主可能数天后才发现房间无人。
 * 误判保护：inspect 失败跳过、启动宽限期内跳过、安装中跳过。
 */
export async function reconcileUnexpectedExits(app: FastifyInstance): Promise<number> {
  const running = await listGameInstances({ status: 'running' })
  const now = new Date()
  let detected = 0
  for (const instance of running) {
    if (instance.runtimeFailureKind === 'memory_protection') continue
    if (startupIsActive(getStartupSnapshot(instance.id, instance.lastStartupReport))) continue
    if (instance.nodeId !== LOCAL_NODE_ID) {
      continue
    }
    if (isInstallJobActive(instance.id)) {
      continue
    }
    const startedAt = instance.runtimeStartedAt ? Date.parse(instance.runtimeStartedAt) : Number.NaN
    if (Number.isFinite(startedAt) && now.getTime() - startedAt < START_GRACE_MS) {
      continue
    }
    let actuallyRunning: boolean
    try {
      actuallyRunning = await isInstanceContainerRunning(instance.id)
    }
    catch (error) {
      app.log.debug({ instanceId: instance.id, err: error }, '异常退出对账：运行时探测失败，本轮跳过')
      continue
    }
    if (actuallyRunning) {
      continue
    }

    const exitAt = now.toISOString()
    await updateGameInstanceRuntime(instance.id, {
      status: 'stopped',
      containerId: null,
      runtimePid: null,
      runtimeStartedAt: null,
      lastError: `检测到实例进程异常退出（${exitAt.replace('T', ' ').slice(0, 19)}）。Docker 模式 on-failure 重试耗尽后需手动启动；Native 模式 systemd 会自动拉起。`,
      lastErrorPhase: 'runtime',
      unexpectedExitAt: exitAt,
      whereStatus: 'running',
    })
    detected++

    const refreshed = await getGameInstanceById(instance.id)
    emitPanelEvent({
      type: 'instance_exited_unexpectedly',
      subjectId: instance.id,
      subjectName: refreshed?.name ?? instance.name,
      message: `实例「${refreshed?.name ?? instance.name}」进程异常退出`,
      severity: 'critical',
      at: exitAt,
    })
    app.log.warn({ instanceId: instance.id }, '实例进程异常退出，已标记并发布事件')
  }
  return detected
}

/** 启动崩溃感知轮询（幂等；单元测试环境不自动启动） */
export function startInstanceExitWatch(app: FastifyInstance): void {
  if (watchStarted || isUnitTest()) {
    return
  }
  watchStarted = true
  watchTimer = setInterval(() => {
    if (watchInFlight) {
      return
    }
    watchInFlight = true
    void reconcileUnexpectedExits(app)
      .catch(error => app.log.error({ err: error }, '异常退出对账失败'))
      .finally(() => {
        watchInFlight = false
      })
  }, WATCH_INTERVAL_MS)
  if (typeof watchTimer === 'object' && 'unref' in watchTimer && typeof watchTimer.unref === 'function') {
    watchTimer.unref()
  }
  app.log.info({ watchIntervalMs: WATCH_INTERVAL_MS }, '实例崩溃感知已启动')
}

export function stopInstanceExitWatch(): void {
  if (watchTimer) {
    clearInterval(watchTimer)
    watchTimer = null
  }
  watchStarted = false
}
