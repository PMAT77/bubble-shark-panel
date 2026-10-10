import type { FastifyInstance } from 'fastify'
import type { DbGameInstance, DbInstanceRuntimeFailureKind } from '../../shared/db/types'
import type { ContainerInspect } from '../../infra/container/types'
import { listGameInstances, updateGameInstanceRuntime, getInstanceRuntimeRevision } from '../../shared/db/index'
import { describeSystemdExitReason, readHostMemorySnapshot, readRuntimeMemoryCapMb } from '../../infra/container/exit-reason'
import { getContainerRuntime } from '../../infra/container'
import { resolveInstanceResourceSettings } from '../../infra/container/dst-container-resources'
import { ensureInstanceContainerLogFollow, findShardLuaFailure, hasMasterReadyMarker, inspectInstanceShardRuntime, isHealthyRuntimeForResurrect, resolveInstanceContainerRef, stopInstanceContainer, recoverInstanceStartup } from './container-lifecycle'
import { currentStartupTask, getStartupSnapshot, isCurrentStartupTask, startupIsActive } from './startup-state'
import { reconcileStaleInstallingInstances } from './install-service'
import { buildRestartLoopWarning, shouldClearRuntimeWarning } from './runtime-warning'
import { resolveRuntimeReadiness, type InstanceRuntimeReadiness } from './runtime-readiness'
import { buildRuntimeFailureWarning, classifyRuntimeFailure } from './runtime-failure'
import { createReconciliationCache } from './reconciliation-cache'
const LOCAL_NODE_ID = 'local-node'
/** 运行期告警要落库的实例字段：文案 + 归因（归因供前端决定是否给出扩容引导） */
type RuntimeWarningTarget = Pick<DbGameInstance, 'id' | 'runtimeWarning' | 'runtimeFailureKind' | 'resourceConfig' | 'lastStartupReport'>

function resolveRunningResourceSettings(instance: RuntimeWarningTarget) {
  return instance.lastStartupReport?.settings ?? resolveInstanceResourceSettings(instance.resourceConfig)
}

/**
 * 写运行期告警；文案与归因都没变就不写库。
 *
 * 对账跑在每个列表/详情请求上，而这个告警的文案会随重启次数、加载时长变化，
 * 无脑写库等于把每次轮询都变成一次 UPDATE。
 */
async function applyRuntimeWarning(
  app: FastifyInstance,
  instance: RuntimeWarningTarget,
  message: string | null,
  failureKind: DbInstanceRuntimeFailureKind | null,
): Promise<void> {
  if (instance.runtimeWarning === message && instance.runtimeFailureKind === failureKind) {
    return
  }
  await updateGameInstanceRuntime(instance.id, { runtimeWarning: message, runtimeFailureKind: failureKind })
  if (message) {
    app.log.warn({ instanceId: instance.id, failureKind }, '实例运行期告警已更新')
  }
}

/**
 * 崩溃循环告警。
 *
 * 进程能被运行时反复拉起时，实例状态一直显示「运行中」，服主会以为一切正常；
 * 实际上服务器可能从未加载完成，玩家连不上（大厅搜不到、直连报失去联系）。
 *
 * 写 runtimeWarning 而不是 lastError：lastError 会被「启动失败」「停止实例」
 * 与状态对账反复覆盖，实测出现过写入一秒后就被清空、服主永远看不到的情况。
 *
 * 措辞与判据都在 `runtime-warning.ts`：`restarts` 是累计值，只看它会把
 * 「启动时崩过一次、之后一直稳跑」也报成正在崩溃循环。
 */
async function warnInstanceRestartLoop(
  app: FastifyInstance,
  instance: RuntimeWarningTarget,
  snapshot: ContainerInspect,
): Promise<void> {
  const actualCap = snapshot.exitResult === 'oom-kill' ? await readRuntimeMemoryCapMb(getContainerRuntime(), await resolveInstanceContainerRef(instance.id).catch(() => undefined)) : undefined
  const reason = describeSystemdExitReason(snapshot.exitResult, resolveRunningResourceSettings(instance).masterMemoryMb ?? undefined, readHostMemorySnapshot(), actualCap)
  const message = buildRestartLoopWarning({
    restarts: snapshot.restarts ?? 0,
    restarting: snapshot.restarting === true,
    ...(snapshot.uptimeSeconds !== undefined ? { uptimeSeconds: snapshot.uptimeSeconds } : {}),
    exitReason: reason,
  })
  await applyRuntimeWarning(app, instance, message, null)
}

/** 宿主机可用缓冲（可用内存 + 缓存区余量，MiB）；读不到任一项时为 null */
function readHostBufferMb(): number | null {
  const memory = readHostMemorySnapshot()
  if (memory.availableMb === null) {
    return null
  }
  return memory.availableMb + (memory.swapFreeMb ?? 0)
}

/**
 * 实例在跑但**世界还没就绪**时的结论。
 *
 * 先问「是不是内存问题」：这决定界面要不要给出「增加缓存区」的引导。不是内存问题就退回
 * 重启告警那套措辞——把 Mod 报错误判成缺内存，会让人白折腾一轮缓存区。
 */
async function reportRuntimeIssue(
  app: FastifyInstance,
  instance: RuntimeWarningTarget,
  snapshot: ContainerInspect,
  readiness: InstanceRuntimeReadiness,
): Promise<void> {
  const settings = resolveRunningResourceSettings(instance)
  const shardCapMb = settings.masterMemoryMb ?? undefined
  const criteria = {
    readySeen: readiness.state === 'ready',
    restarts: snapshot.restarts ?? 0,
    restarting: snapshot.restarting === true,
    ...(snapshot.exitResult !== undefined ? { exitResult: snapshot.exitResult } : {}),
    ...(snapshot.memOomKillCount !== undefined ? { memOomKillCount: snapshot.memOomKillCount } : {}),
    ...(snapshot.memPeakMb !== undefined ? { memPeakMb: snapshot.memPeakMb } : {}),
    ...(shardCapMb !== undefined ? { shardCapMb } : {}),
    bufferMb: readHostBufferMb(),
    loadingSeconds: readiness.loadingSeconds,
    notReadyAfterSec: settings.shardReadyWaitSec,
  }
  let failure = classifyRuntimeFailure(criteria)
  if (failure?.kind === 'memory' && (snapshot.exitResult === 'oom-kill' || (snapshot.memOomKillCount ?? 0) > 0)) {
    const actualShardCapMb = await readRuntimeMemoryCapMb(getContainerRuntime(), await resolveInstanceContainerRef(instance.id).catch(() => undefined))
    failure = classifyRuntimeFailure({ ...criteria, actualShardCapMb })
  }
  if (failure) {
    await applyRuntimeWarning(app, instance, buildRuntimeFailureWarning(failure), failure.kind)
    return
  }
  await warnInstanceRestartLoop(app, instance, snapshot)
}

/** 主世界已停、洞穴还在跑：只写运行期警告，不占用 lastError（它留给真正的启动失败） */
async function warnCavesLeftRunning(
  app: FastifyInstance,
  instance: RuntimeWarningTarget,
): Promise<void> {
  const message = '主世界分片已停止，但洞穴分片仍在运行。请在实例控制里重新启动或停止实例，避免洞穴单独占着内存。'
  await applyRuntimeWarning(app, instance, message, null)
}

/**
 * 服务重启后 DB 可能仍保留 running；与运行时实际状态对齐。
 *
 * 四种情况必须分开处理，压成一个布尔值正是实例状态在「运行中 / 已停止」之间来回跳的根源：
 * 运行中、崩溃后等待运行时拉起（同样算运行中）、运行时单元已不存在（真停了）、问不到运行时（保持现状）。
 */
async function reconcileStaleRunningInstances(app: FastifyInstance, health: { complete: boolean }): Promise<number> {
  const instances = await listGameInstances({ status: 'running' })
  let reconciled = 0
  for (const instance of instances) {
    if (instance.runtimeFailureKind === 'memory_protection') continue
    const task = currentStartupTask(instance.id)
    if ((task && isCurrentStartupTask(task)) || startupIsActive(getStartupSnapshot(instance.id, instance.lastStartupReport))) {
      await recoverInstanceStartup(app, instance)
      continue
    }
    if (instance.nodeId !== LOCAL_NODE_ID) {
      continue
    }
    const probe = await inspectInstanceShardRuntime(instance.id)
    if (probe.unitExists && !probe.snapshot) health.complete = false
    // 问不到运行时（systemd user bus 不可达等）：保持现状，不能把运行中的实例判成已停止
    if (probe.unitExists && !probe.snapshot) {
      app.log.debug({ instanceId: instance.id }, '实例运行时探测失败，保持当前状态')
      continue
    }
    const snapshot = probe.snapshot
    const luaFailure = findShardLuaFailure(instance.id, instance.installPath ?? undefined, instance.runtimeStartedAt)
    if (luaFailure) {
      const message = instance.runtimeReadyAt ? luaFailure : `启动失败：${luaFailure}`
      await stopInstanceContainer(instance.id)
      await updateGameInstanceRuntime(instance.id, {
        status: 'error',
        lastError: message,
        lastErrorPhase: 'runtime',
        runtimeReadyAt: null,
        runtimeWarning: message,
        runtimeFailureKind: null,
        whereStatus: 'stopped',
      })
      reconciled++
      continue
    }
    if (snapshot?.running) {
      if (!instance.runtimeStartedAt) {
        await updateGameInstanceRuntime(instance.id, {
          runtimeStartedAt: new Date().toISOString(),
        })
      }
      // 本轮的就绪标记只在尚未就绪时查一次：一旦就绪就不再读分片日志，列表轮询没有额外开销。
      // 「进程在跑」与「服务器能接客」是两件事，只报前者会让服主以为房间已经能被搜到。
      let runtimeReadyAt = instance.runtimeReadyAt
      if (!runtimeReadyAt && instance.installPath && hasMasterReadyMarker(instance.id, instance.installPath, instance.runtimeStartedAt)) {
        runtimeReadyAt = new Date().toISOString()
        await updateGameInstanceRuntime(instance.id, { runtimeReadyAt, runtimeFailureKind: null })
      }
      const readiness = resolveRuntimeReadiness({
        status: instance.status,
        runtimeReadyAt,
        runtimeStartedAt: instance.runtimeStartedAt,
        notReadyAfterSec: resolveRunningResourceSettings(instance).shardReadyWaitSec,
      })
      // 崩溃循环后自己站稳、且已连续干净运行足够久的实例：旧警告自己消失，也不再写新的
      if (shouldClearRuntimeWarning(snapshot.uptimeSeconds)) {
        await applyRuntimeWarning(app, instance, null, null)
      }
      else {
        await reportRuntimeIssue(app, instance, snapshot, readiness)
      }
      await ensureInstanceContainerLogFollow(instance.id)
      continue
    }
    // master 不在运行：确认洞穴分片是否还在跑。两个分片生命周期本应一致，
    // 只剩洞穴在跑时既白占内存，又让服主以为「已经停了」，必须如实说出来。
    const cavesProbe = await inspectInstanceShardRuntime(instance.id, 'caves')
    if (cavesProbe.unitExists && !cavesProbe.snapshot) health.complete = false
    const cavesStillRunning = cavesProbe.snapshot?.running === true
    await updateGameInstanceRuntime(instance.id, {
      status: 'stopped',
      containerId: null,
      runtimePid: null,
      runtimeStartedAt: null,
    })
    reconciled++
    if (cavesStillRunning) {
      await warnCavesLeftRunning(app, instance)
    }
    app.log.info({ instanceId: instance.id }, '实例运行时不存在，已同步状态为已停止')
  }
  return reconciled
}

/**
 * DB 为 stopped/error 但容器仍在运行时的对齐（如异常退出后面板重启）。
 *
 * 关键：正在被运行时自动拉起（systemd 的 auto-restart 窗口）或已经重启过的实例，
 * 属于崩溃循环而不是「容器还在跑」。此处若把状态翻回运行中，就会抹掉上一趟对账
 * 刚写入的崩溃告警——线上实测同一个请求里两趟对账互相覆盖，服主永远看不到原因。
 */
async function reconcileStoppedButContainerRunning(app: FastifyInstance, health: { complete: boolean }): Promise<number> {
  const instances = await listGameInstances()
  let reconciled = 0
  for (const instance of instances) {
    if (instance.runtimeFailureKind === 'memory_protection') continue
    const task = currentStartupTask(instance.id)
    if ((task && isCurrentStartupTask(task)) || startupIsActive(getStartupSnapshot(instance.id, instance.lastStartupReport))) {
      await recoverInstanceStartup(app, instance)
      continue
    }
    if (instance.nodeId !== LOCAL_NODE_ID) {
      continue
    }
    if (instance.status !== 'stopped' && instance.status !== 'error') {
      continue
    }
    if (instance.lastStartupReport?.status === 'failed' || instance.lastStartupReport?.status === 'cancelled') continue
    const probe = await inspectInstanceShardRuntime(instance.id)
    if (probe.unitExists && !probe.snapshot) health.complete = false
    const snapshot = probe.snapshot
    if (!snapshot?.running) {
      continue
    }
    // Lua 崩溃后进程可能仍存活，不能把上一轮的失败结论抹成「运行中」。
    if (findShardLuaFailure(instance.id, instance.installPath ?? undefined, instance.runtimeStartedAt)) {
      continue
    }
    if (!isHealthyRuntimeForResurrect(snapshot)) {
      await warnInstanceRestartLoop(app, instance, snapshot)
      continue
    }
    const ref = await resolveInstanceContainerRef(instance.id)
    await updateGameInstanceRuntime(instance.id, {
      status: 'running',
      containerId: ref?.id ?? instance.containerId,
      runtimeStartedAt: instance.runtimeStartedAt ?? new Date().toISOString(),
      runtimeWarning: null,
      // 这一轮到底就绪没有无法确认：清空让下一趟对账重新判定，而不是沿用上一次的结论
      runtimeReadyAt: null,
      runtimeFailureKind: null,
    })
    await ensureInstanceContainerLogFollow(instance.id)
    reconciled++
    app.log.info({ instanceId: instance.id }, '实例运行时仍在运行，已同步状态为运行中')
  }
  return reconciled
}

const services = new WeakMap<FastifyInstance, () => Promise<void>>()
export function reconcileInstanceRuntimeState(app: FastifyInstance): Promise<void> {
  let reconcile = services.get(app)
  if (!reconcile) {
    reconcile = createReconciliationCache(async () => {
      const health = { complete: true }
      await reconcileStaleRunningInstances(app, health)
      await reconcileStoppedButContainerRunning(app, health)
      await reconcileStaleInstallingInstances(app)
      return health.complete
    }, getInstanceRuntimeRevision)
    services.set(app, reconcile)
  }
  return reconcile()
}
