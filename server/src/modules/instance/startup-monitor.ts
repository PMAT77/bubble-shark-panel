import { setTimeout as sleep } from 'node:timers/promises'
import type { FastifyInstance } from 'fastify'
import type { ContainerInspect, ContainerRef, ContainerRuntime, RuntimeResourceSnapshot } from '../../infra/container/types'
import type { DstStartupProbe } from '../../infra/game-adapter/dst/startup-probe'
import { readHostMemoryReading } from '../../infra/container/host-resource-guard'
import { emptyResourceSnapshot } from '../../infra/container/dst-container-resources'
import { sampleRuntimeResources } from '../../infra/container/memory-budget'
import { formatMemoryCapHint } from '../../infra/container/exit-reason'
import { instanceConsoleLogStore } from '../../shared/instance-runtime/console-log-store'
import { updateGameInstanceRuntime } from '../../shared/db'
import { changeStartupPhase, isCurrentStartupTask, persistStartupTask, refreshStartupProgress, type StartupTask } from './startup-state'
import { confirmedOom } from './memory-pressure'

type Shard = 'master' | 'caves'
const label = (shard: Shard) => shard === 'master' ? '主世界' : '洞穴'
const oomMessage = (shard: Shard, resources: RuntimeResourceSnapshot | null) => `${label(shard)}被内存不足终止${formatMemoryCapHint(resources?.memoryMaxMb)}，请检查分片额度与宿主机余量`

export async function runStartupMonitor(app: FastifyInstance, input: {
  task: StartupTask
  runtime: ContainerRuntime
  masterRef: ContainerRef
  cavesRef?: ContainerRef
  baselineRestarts: number | null
  startedAt: string
  waitSec: number
  isCancelled: () => boolean
  luaFailure: () => string | null
  probe: (ref: ContainerRef, shard: Shard, remoteShardId?: string) => Promise<DstStartupProbe | null>
  startCaves?: () => Promise<{ ok: true, ref: ContainerRef, baselineRestarts?: number | null } | { ok: false, message: string }>
  cleanup: (refs: ContainerRef[]) => Promise<void>
  protectOom?: () => Promise<void>
  pollIntervalMs?: number
}): Promise<void> {
  const { task, runtime } = input
  const signal = task.controller.signal
  const cancelled = () => !isCurrentStartupTask(task) || input.isCancelled()
  let cavesRef = input.cavesRef
  let lastCheckpoint = Date.now()
  const restoredPhase = task.snapshot.phase
  const restoredDeadline = task.snapshot.phaseDeadlineAt
  const restoredPhaseStartedAt = task.snapshot.phaseStartedAt
  let masterBaselineRestarts = task.snapshot.master.restartBaseline ?? input.baselineRestarts
  let cavesBaselineRestarts = task.snapshot.caves.restartBaseline ?? task.snapshot.caves.resources?.restarts ?? null
  const pollInterval = input.pollIntervalMs ?? 5000

  // 只读查询不能让超时/取消卡在不可达的 user bus 或 Docker API 上。
  const bounded = async <T>(read: Promise<T>, deadline: number): Promise<T | null> => {
    let timer: NodeJS.Timeout | undefined
    let abort: () => void = () => {}
    try {
      return await Promise.race([read.catch(() => null), new Promise<null>((resolve) => {
        abort = () => resolve(null)
        signal.addEventListener('abort', abort, { once: true })
        timer = setTimeout(abort, Math.max(0, Math.min(deadline - Date.now(), pollInterval)))
        if (signal.aborted) abort()
      })])
    }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
  }

  const fail = async (code: string, message: string, raw = message, inspect?: ContainerInspect | null, sampledExitCode?: number | null) => {
    if (cancelled()) return
    if (code === 'oom' && input.protectOom) { await input.protectOom(); return }
    const exitCode = sampledExitCode ?? inspect?.exitCode
    task.snapshot.diagnosis = { code, message }
    await changeStartupPhase(task, 'failed')
    if (cancelled()) return
    const exitDetails = [inspect?.exitResult ? `运行时结果：${inspect.exitResult}` : '', exitCode != null ? `退出码：${exitCode}` : ''].filter(Boolean).join('，')
    instanceConsoleLogStore.appendSystem(task.instanceId, `启动失败：${raw}${exitDetails ? `（${exitDetails}）` : ''}`)
    // 现场先持久化，再结束日志和清理本轮运行时。
    let cleaned = true
    try { await input.cleanup([...(cavesRef ? [cavesRef] : []), input.masterRef]) }
    catch (error) { cleaned = false; app.log.warn({ instanceId: task.instanceId, err: error }, '启动失败清理未完成') }
    if (cancelled()) return
    await updateGameInstanceRuntime(task.instanceId, {
      status: 'error', ...(cleaned ? { containerId: null, runtimePid: null, runtimeStartedAt: null } : {}),
      runtimeReadyAt: null, lastError: `启动失败：${message}`, lastErrorPhase: 'runtime',
      runtimeWarning: message, runtimeFailureKind: code === 'oom' ? 'memory' : 'not_ready',
      ...(exitCode != null ? { lastExitCode: exitCode } : {}),
      whereStartupTaskId: task.snapshot.taskId,
    })
    app.log.warn({ instanceId: task.instanceId, code, exitResult: inspect?.exitResult, exitCode }, message)
  }

  const captureResources = (shard: Shard, resources: RuntimeResourceSnapshot | null, inspect: ContainerInspect | null, baseline: RuntimeResourceSnapshot | null) => {
    const known = resources && Object.entries(resources).some(([key, value]) => key !== 'measuredAt' && value != null)
    const inspected = inspect && !inspect.probeFailed ? inspect : null
    const exitEvidence = inspected?.exitCode != null && (inspected.exitCode !== 0 || !inspected.running || inspected.restarting)
    if (!known && !exitEvidence && inspected?.memPeakMb == null && inspected?.memOomKillCount == null && inspected?.oomKilled !== true && inspected?.exitResult !== 'oom-kill') return null
    const current = { ...(known ? resources! : emptyResourceSnapshot()) }
    if (inspected?.exitCode != null && (current.exitCode == null || inspected.exitCode !== 0)) current.exitCode = inspected.exitCode
    if (inspected?.memPeakMb != null) current.memoryPeakMb = Math.max(current.memoryPeakMb ?? 0, inspected.memPeakMb)
    if (inspected?.memOomKillCount != null) current.oomKillCount = Math.max(current.oomKillCount ?? 0, inspected.memOomKillCount)
    if (inspected?.oomKilled === true || inspected?.exitResult === 'oom-kill') current.oomKilled = true
    task.snapshot[shard].resources = current
    task.snapshot[shard].memoryPeakMb = Math.max(task.snapshot[shard].memoryPeakMb ?? 0, current.memoryPeakMb ?? 0, current.memoryCurrentMb ?? 0) || null
    task.snapshot[shard].memoryAndSwapPeakMb = Math.max(task.snapshot[shard].memoryAndSwapPeakMb ?? 0, current.memoryAndSwapPeakMb ?? 0) || null
    task.snapshot[shard].peakLimited ||= current.peakLimited === true
    // 先保存现场增量，再判失败；失败报告不能沿用上一轮的 0 次 OOM。
    const reference = baseline ?? current
    task.snapshot[shard].resourceBaseline = reference
    const delta = (key: 'highEvents' | 'maxEvents' | 'oomKillCount' | 'throttledUsec' | 'restarts') =>
      current[key] == null || reference[key] == null ? null : Math.max(0, current[key]! - reference[key]!)
    task.snapshot[shard].resourceDeltas = { highEvents: delta('highEvents'), maxEvents: delta('maxEvents'),
      oomKillCount: baseline?.oomKillCount != null ? delta('oomKillCount') : current.oomKillCount,
      throttledUsec: delta('throttledUsec'), restarts: delta('restarts') }
    return current
  }
  const wasOomKilled = (resources: RuntimeResourceSnapshot | null, inspect: ContainerInspect | null, baseline: RuntimeResourceSnapshot | null) => {
    const changedIdentity = resources?.runtimeIdentity && baseline?.runtimeIdentity && resources.runtimeIdentity !== baseline.runtimeIdentity
    if (!changedIdentity && confirmedOom(resources, baseline)) return true
    return !!inspect && !inspect.probeFailed && (!inspect.running || inspect.restarting === true)
      && (inspect.oomKilled === true || inspect.exitResult === 'oom-kill' || resources?.oomKilled === true)
  }

  const progress = () => {
    refreshStartupProgress(task)
  }

  const diagnose = (resources: RuntimeResourceSnapshot | null, baseline: RuntimeResourceSnapshot | null) => {
    const idle = (Date.now() - Date.parse(task.snapshot.lastProgressAt ?? task.snapshot.phaseStartedAt)) / 1000
    if (idle < 60) { task.snapshot.diagnosis = null; return }
    let diagnosis = { code: 'no_recent_progress', message: '暂未看到新的加载进展，仍在等待；可打开控制台查看' }
    if (idle >= 120) {
      const host = readHostMemoryReading()
      if ((resources?.memoryPressureFullAvg10 ?? 0) >= 20
        || (resources?.highEvents != null && baseline?.highEvents != null && resources.highEvents > baseline.highEvents)) {
        diagnosis = { code: 'memory_reclaim', message: '内存回收正在拖慢加载，请检查实际软限、硬限及 swap 余量' }
      }
      else if (resources?.maxEvents != null && baseline?.maxEvents != null && resources.maxEvents > baseline.maxEvents) {
        diagnosis = { code: 'memory_limit_pressure', message: '分片正在触及内存硬限并回收，可在资源设置中调整下次启动上限' }
      }
      else if ((host.availableMb ?? Infinity) + (host.swapFreeMb ?? 0) < 512) {
        diagnosis = { code: 'host_memory_pressure', message: '宿主机内存与 swap 余量偏低，可停止其他实例或按资源设置中的命令增加 swap' }
      }
      else if (resources?.throttledUsec != null && baseline?.throttledUsec != null && resources.throttledUsec > baseline.throttledUsec) {
        diagnosis = { code: 'cpu_throttled', message: '分片 CPU 配额发生节流，请结合控制台进展检查 CPU 配额' }
      }
    }
    task.snapshot.diagnosis = diagnosis
  }

  const waitShard = async (ref: ContainerRef, shard: Shard, baselineRestarts: number | null): Promise<boolean> => {
    const phase = shard === 'master' ? 'master_loading' : 'caves_loading'
    const resuming = restoredPhase === phase || (shard === 'caves' && restoredPhase === 'connecting')
    const phaseDeadline = (task.snapshot.phase === phase || (shard === 'caves' && task.snapshot.phase === 'connecting')) ? task.snapshot.phaseDeadlineAt : null
    const deadline = resuming && restoredDeadline ? Date.parse(restoredDeadline) : phaseDeadline ? Date.parse(phaseDeadline) : Date.now() + input.waitSec * 1000
    if (!resuming) task.snapshot.lastProgressAt = new Date().toISOString()
    task.snapshot[shard].state = 'loading'
    await changeStartupPhase(task, resuming && restoredPhase === 'connecting' ? 'connecting' : phase, new Date(deadline).toISOString())
    if (resuming) task.snapshot.phaseStartedAt = restoredPhaseStartedAt
    let baseline = task.snapshot[shard].resourceBaseline ?? task.snapshot[shard].resources ?? null
    let responded = resuming && restoredPhase === 'connecting'
    let worldSeen = responded
    while (Date.now() < deadline && !cancelled()) {
      const tick = Date.now()
      const luaFailure = input.luaFailure()
      if (luaFailure) { task.snapshot[shard].state = 'failed'; await fail('lua_error', `${label(shard)}出现 Lua 致命错误，请查看控制台`, luaFailure); return false }
      let inspect: ContainerInspect | null = null
      let resources: RuntimeResourceSnapshot | null = null
      const results = await Promise.allSettled([
        bounded(runtime.inspect(ref), deadline), bounded(sampleRuntimeResources(runtime, ref, Math.min(4500, pollInterval * .9)), deadline),
        shard === 'caves' ? bounded(runtime.inspect(input.masterRef), deadline) : Promise.resolve(null),
        shard === 'caves' ? bounded(sampleRuntimeResources(runtime, input.masterRef, Math.min(4500, pollInterval * .9)), deadline) : Promise.resolve(null),
      ])
      if (cancelled()) return false
      if (results[0].status === 'fulfilled') inspect = results[0].value
      if (results[1].status === 'fulfilled') resources = results[1].value
      const master = results[2].status === 'fulfilled' ? results[2].value : null
      const masterBaseline = task.snapshot.master.resourceBaseline ?? task.snapshot.master.resources ?? null
      const masterResources = shard === 'caves' ? captureResources('master', results[3].status === 'fulfilled' ? results[3].value : null, master, masterBaseline) : null
      if (inspect && !inspect.probeFailed) {
        baselineRestarts ??= inspect.restarts ?? 0
        if (shard === 'master') masterBaselineRestarts = baselineRestarts
        if (task.snapshot[shard].restartBaseline !== baselineRestarts) {
          task.snapshot[shard].restartBaseline = baselineRestarts
          await persistStartupTask(task)
        }
      }
      if (master && !master.probeFailed) {
        masterBaselineRestarts ??= master.restarts ?? 0
        if (task.snapshot.master.restartBaseline !== masterBaselineRestarts) {
          task.snapshot.master.restartBaseline = masterBaselineRestarts
          await persistStartupTask(task)
        }
      }
      if (cancelled()) return false
      resources = captureResources(shard, resources, inspect, baseline)
      if (wasOomKilled(resources, inspect, baseline)) { task.snapshot[shard].state = 'failed'; await fail('oom', oomMessage(shard, resources), undefined, inspect, resources?.exitCode); return false }
      if (inspect && !inspect.probeFailed && (!inspect.running || inspect.restarting || (inspect.restarts ?? 0) > (baselineRestarts ?? 0))) {
        task.snapshot[shard].state = 'failed'; await fail('shard_exited', `${label(shard)}在加载期间退出或重启，请查看控制台`, undefined, inspect, resources?.exitCode); return false
      }
      if (wasOomKilled(masterResources, master, masterBaseline)) {
        task.snapshot.master.state = 'failed'; await fail('oom', oomMessage('master', masterResources), undefined, master, masterResources?.exitCode); return false
      }
      if (master && !master.probeFailed && (!master.running || master.restarting || (master.restarts ?? 0) > (masterBaselineRestarts ?? 0))) {
        task.snapshot.master.state = 'failed'; await fail('master_exited', '主世界在洞穴加载期间退出或重启', undefined, master, masterResources?.exitCode); return false
      }
      // baseline 必须保留本轮首次计数，当前值覆盖它会漏掉累计回收/OOM。
      baseline ??= resources
      progress()
      diagnose(resources, baseline)
      if (inspect?.running && !inspect.probeFailed) {
        const probeDeadline = Math.min(deadline, tick + pollInterval)
        const probe = await bounded(input.probe(ref, shard), probeDeadline)
        if (cancelled()) return false
        responded ||= probe !== null
        worldSeen ||= probe?.worldReady === true
        let connected = shard === 'master'
        if (shard === 'caves' && probe?.worldReady && probe.shardId) {
          const masterProbe = await bounded(input.probe(input.masterRef, 'master', probe.shardId), probeDeadline)
          if (cancelled()) return false
          connected = masterProbe?.worldReady === true && masterProbe.remoteConnected === true
        }
        if (Date.now() < deadline && probe?.worldReady && connected) {
          task.snapshot[shard].state = 'ready'
          task.snapshot.diagnosis = null
          await persistStartupTask(task)
          return true
        }
        if (shard === 'caves' && probe?.worldReady && task.snapshot.phase !== 'connecting') {
          await changeStartupPhase(task, 'connecting', new Date(deadline).toISOString())
        }
      }
      task.snapshot.updatedAt = new Date().toISOString()
      if (Date.now() - lastCheckpoint >= 30_000) { lastCheckpoint = Date.now(); await persistStartupTask(task) }
      try { await sleep(Math.max(1, Math.min(tick + pollInterval, deadline) - Date.now()), undefined, { signal }) }
      catch { if (signal.aborted) return false; throw new Error('启动等待中断') }
    }
    if (cancelled()) return false
    task.snapshot[shard].state = 'failed'
    const code = !responded ? 'probe_unavailable' : shard === 'caves' && worldSeen ? 'shard_connect_timeout' : `${shard}_loading_timeout`
    await fail(code, !responded ? `${label(shard)}等待就绪超时（${input.waitSec} 秒），未收到有效游戏查询响应，请查看控制台`
      : worldSeen && shard === 'caves' ? `洞穴未能在 ${input.waitSec} 秒内连接主世界，请检查分片配置`
        : `等待${label(shard)}就绪超时（${input.waitSec} 秒），请检查控制台和资源设置`)
    return false
  }

  try {
    // 恢复时即使主世界曾就绪，也必须再次确认活着且可查询；原洞穴 deadline 不重置。
    if (task.snapshot.master.state === 'ready') {
      const deadline = restoredDeadline ? Date.parse(restoredDeadline) : Date.now() + input.waitSec * 1000
      while (!cancelled()) {
        const [inspect, sampled] = await Promise.all([
          bounded(runtime.inspect(input.masterRef), deadline), bounded(runtime.resourceSnapshot?.(input.masterRef) ?? Promise.resolve(null), deadline),
        ])
        if (cancelled()) return
        const baseline = task.snapshot.master.resourceBaseline ?? task.snapshot.master.resources ?? null
        const resources = captureResources('master', sampled, inspect, baseline)
        if (inspect && !inspect.probeFailed) masterBaselineRestarts ??= inspect.restarts ?? 0
        if (inspect && !inspect.probeFailed && task.snapshot.master.restartBaseline !== masterBaselineRestarts) {
          task.snapshot.master.restartBaseline = masterBaselineRestarts
          await persistStartupTask(task)
        }
        if (cancelled()) return
        if (wasOomKilled(resources, inspect, baseline)) {
          task.snapshot.master.state = 'failed'; await fail('oom', oomMessage('master', resources), undefined, inspect, resources?.exitCode); return
        }
        if (inspect && !inspect.probeFailed && (!inspect.running || inspect.restarting || (inspect.restarts ?? 0) > (masterBaselineRestarts ?? 0))) {
          task.snapshot.master.state = 'failed'; await fail('master_exited', '恢复启动时主世界已退出或重启', undefined, inspect, resources?.exitCode); return
        }
        const probe = inspect?.running && !inspect.probeFailed ? await bounded(input.probe(input.masterRef, 'master'), deadline) : null
        if (cancelled()) return
        if (Date.now() < deadline && probe?.worldReady) break
        if (Date.now() >= deadline) { await fail(restoredPhase === 'connecting' ? 'shard_connect_timeout' : 'probe_unavailable', '恢复启动超过原等待期限，请检查分片与查询通道'); return }
        await sleep(Math.min(pollInterval, deadline - Date.now()), undefined, { signal }).catch(() => {})
      }
    }
    if (task.snapshot.master.state !== 'ready') {
      if (!await waitShard(input.masterRef, 'master', masterBaselineRestarts)) return
      if (cancelled()) return
      await updateGameInstanceRuntime(task.instanceId, { runtimeReadyAt: new Date().toISOString(), runtimeFailureKind: null, whereStartupTaskId: task.snapshot.taskId })
    }
    if (input.startCaves || cavesRef) {
      if (!cavesRef) {
        if (cancelled()) return
        const deadline = restoredPhase === 'caves_loading' || restoredPhase === 'connecting' ? restoredDeadline : new Date(Date.now() + input.waitSec * 1000).toISOString()
        await changeStartupPhase(task, 'caves_loading', deadline)
        const result = await input.startCaves!()
        if (result.ok) {
          cavesRef = result.ref
          cavesBaselineRestarts = result.baselineRestarts ?? null
          task.snapshot.caves.restartBaseline = cavesBaselineRestarts
          await persistStartupTask(task)
        }
        if (cancelled()) return
        if (!result.ok) { await fail('caves_start_failed', '洞穴启动失败，请检查资源与控制台', result.message); return }
      }
      if (!cavesRef || !await waitShard(cavesRef, 'caves', cavesBaselineRestarts)) return
    }
    else task.snapshot.caves.state = 'disabled'
    if (cancelled()) return
    task.snapshot.diagnosis = null
    await changeStartupPhase(task, 'ready')
    if (!cancelled()) instanceConsoleLogStore.appendSystem(task.instanceId, '实例已就绪，所有启用的分片已完成加载和连接')
  }
  catch (error) {
    if (!cancelled()) await fail('startup_internal_error', '启动监控发生异常，请查看控制台', String(error))
  }
}
