import type { FastifyInstance } from 'fastify'
import type { DbGameInstance } from '../../shared/db'
import type { ContainerRef } from '../../infra/container/types'
import type { MemoryProtectionStop, ResourceSnapshot } from '../../../../shared/contracts/instance-resources'
import { listGameInstances } from '../../shared/db'
import { getContainerRuntime, buildMasterContainerName, buildCavesContainerName } from '../../infra/container'
import { DST_MEMORY_SLICE, sampleHostResources, sampleRuntimeResources } from '../../infra/container/memory-budget'
import { readBrandEnv } from '../../../../shared/brand-env'
import { LOCAL_NODE_ID } from '../../shared/dst/local-dst-instance'
import { currentStartupTask, getStartupSnapshot, refreshStartupProgress, startupIsActive } from './startup-state'
import { protectInstanceMemory, runtimeMemoryEpoch } from './container-lifecycle'
import { MemoryPressureWindow, confirmedOom, shardPressure } from './memory-pressure'

const windows = new Map<string, { epoch: string, master: MemoryPressureWindow, caves: MemoryPressureWindow, masterBaseline: ResourceSnapshot | null, cavesBaseline: ResourceSnapshot | null }>()
const poolWindow = new MemoryPressureWindow()
const hostWindow = new MemoryPressureWindow()
let timer: NodeJS.Timeout | undefined
let inFlight = false
type Sample = { instance: DbGameInstance, refs: ContainerRef[], master: ResourceSnapshot | null, caves: ResourceSnapshot | null, loading: boolean, progress?: number }

export async function inspectMemoryProtection(app: FastifyInstance): Promise<void> {
  const runtime = getContainerRuntime()
  const host = await sampleHostResources(runtime)
  const instances = (await listGameInstances()).filter(instance => instance.nodeId === LOCAL_NODE_ID && instance.runtimeFailureKind !== 'memory_protection' && instance.status === 'running')
  for (const key of windows.keys()) if (!instances.some(i => i.id === key)) windows.delete(key)
  const samples: Sample[] = []
  for (const instance of instances) {
    const task = currentStartupTask(instance.id)
    if (task) refreshStartupProgress(task)
    const snapshot = getStartupSnapshot(instance.id, instance.lastStartupReport)
    const refs: Array<ContainerRef | undefined> = await Promise.all([runtime.findByName(buildMasterContainerName(instance.id)), runtime.findByName(buildCavesContainerName(instance.id))]).catch(() => [undefined, undefined])
    const [master, caves] = await Promise.all(refs.map(ref => ref ? sampleRuntimeResources(runtime, ref) : Promise.resolve(null)))
    const loading = startupIsActive(snapshot)
    samples.push({ instance, refs: refs.filter((r): r is ContainerRef => !!r), master, caves, loading,
      progress: loading ? Date.parse(snapshot?.lastProgressAt ?? snapshot?.phaseStartedAt ?? '') : undefined })
  }
  const at = Date.now()
  const stop = async (sample: Sample, code: MemoryProtectionStop['code'], message: string) => protectInstanceMemory(app, sample.instance,
    { code, message, master: sample.master, caves: sample.caves, host }, sample.refs)
  for (const sample of samples) {
    const epoch = `${runtimeMemoryEpoch(sample.instance)}|${sample.master?.runtimeIdentity ?? ''}|${sample.caves?.runtimeIdentity ?? ''}`
    let state = windows.get(sample.instance.id)
    if (!state || state.epoch !== epoch) {
      state = { epoch, master: new MemoryPressureWindow(), caves: new MemoryPressureWindow(),
        masterBaseline: matchingBaseline(sample.master, sample.instance.lastStartupReport?.master.resourceBaseline),
        cavesBaseline: matchingBaseline(sample.caves, sample.instance.lastStartupReport?.caves.resourceBaseline) }
      windows.set(sample.instance.id, state)
    }
    if (confirmedOom(sample.master, state.masterBaseline) || confirmedOom(sample.caves, state.cavesBaseline)) {
      await stop(sample, 'oom', '确认本轮分片 OOM，已保护停止整个实例'); return
    }
    for (const role of ['master', 'caves'] as const) {
      const pressure = shardPressure(sample[role])
      if (state[role].observe({ at, ...pressure, requireReclaim: true, lastProgressAt: sample.progress })) {
        await stop(sample, 'shard_memory_pressure', `${role === 'master' ? '主世界' : '洞穴'}持续触及实际限额、回收内存并严重停顿至少 15 秒`); return
      }
    }
  }
  const eligible = samples.filter(sample => sample.refs.length && sample.master?.memoryCurrentMb != null)
  const select = (candidates: Sample[]) => [...candidates].sort((a, b) => Number(b.loading) - Number(a.loading)
    || ((b.master?.memoryCurrentMb ?? 0) + (b.caves?.memoryCurrentMb ?? 0)) - ((a.master?.memoryCurrentMb ?? 0) + (a.caves?.memoryCurrentMb ?? 0)))[0]
  const shared = host?.budget
  const pooled = eligible.filter(sample => sample.master?.memoryParent === DST_MEMORY_SLICE && (!sample.caves || sample.caves.memoryParent === DST_MEMORY_SLICE))
  const poolVictim = select(pooled)
  const poolPressure = shared?.state === 'protected' ? shardPressure({ ...sampleEmpty(), memoryCurrentMb: shared.currentMb, memoryMaxMb: shared.maxMb,
    memoryHighMb: shared.highMb, maxEvents: shared.maxEvents, highEvents: shared.highEvents, memoryPressureFullAvg10: shared.memoryPressureFullAvg10 }) : { severe: null, events: null }
  if (poolWindow.observe({ at, ...poolPressure, requireReclaim: true, lastProgressAt: poolVictim?.progress }) && poolVictim) {
    await stop(poolVictim, 'shared_memory_pressure', '游戏共享物理预算持续耗尽并严重停顿至少 15 秒'); poolWindow.reset(); hostWindow.reset(); return
  }
  const headroom = Number(readBrandEnv('BSP_HOST_MEMORY_HEADROOM_MB')) || 512
  const severe = !host || host.source === 'unknown' || host.availableMb == null || host.memoryPressureFullAvg10 == null ? null
    : host.availableMb < Math.max(256, headroom / 2) && host.memoryPressureFullAvg10 >= 20
  if (hostWindow.observe({ at, severe })) {
    const victim = select(eligible)
    if (victim) await stop(victim, 'host_memory_pressure', '宿主机可用内存持续不足且内存严重停顿至少 15 秒')
    hostWindow.reset(); poolWindow.reset()
  }
}
function matchingBaseline(current: ResourceSnapshot | null, recorded?: ResourceSnapshot): ResourceSnapshot | null {
  return current?.runtimeIdentity && current.runtimeIdentity === recorded?.runtimeIdentity ? recorded : current
}
function sampleEmpty(): ResourceSnapshot {
  return { memoryCurrentMb: null, memoryPeakMb: null, memoryMaxMb: null, memoryHighMb: null, swapCurrentMb: null, swapMaxMb: null,
    highEvents: null, maxEvents: null, oomKillCount: null, memoryPressureFullAvg10: null, throttledUsec: null, exitCode: null, restarts: null, oomKilled: null, measuredAt: '' }
}
export function startMemoryProtectionWatch(app: FastifyInstance): void {
  if (timer || process.env.BSP_UNIT_TEST === '1') return
  timer = setInterval(() => {
    if (inFlight) return
    inFlight = true
    void inspectMemoryProtection(app).catch(error => { hostWindow.reset(); poolWindow.reset(); windows.clear(); app.log.warn({ err: error }, '内存保护采样失败，连续压力窗口已重置') }).finally(() => { inFlight = false })
  }, 5000)
  timer.unref()
}
export function stopMemoryProtectionWatch(): void { clearInterval(timer); timer = undefined; windows.clear(); hostWindow.reset(); poolWindow.reset() }
