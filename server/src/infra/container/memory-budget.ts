import fs from 'node:fs'
import path from 'node:path'
import type { HostResourceSnapshot, ResourceSnapshot } from '../../../../shared/contracts/instance-resources'
import { readBrandEnv } from '../../../../shared/brand-env'
import { emptyResourceSnapshot } from './dst-container-resources'
import type { ContainerRef, ContainerRuntime } from './types'

export const DST_MEMORY_SLICE = 'bspdst.slice'
const MIB = 1024 * 1024

export function readText(file: string): string | undefined {
  try { return fs.readFileSync(file, 'utf8').trim() }
  catch { return undefined }
}
export function parseCounter(raw: string | undefined): number | null {
  if (raw == null || !/^\d+(?:\.\d+)?$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(Math.floor(value)) ? value : null
}
export function parseMemoryPsi(raw: string | undefined): number | null {
  return parseCounter(/^full\s+avg10=([\d.]+)/m.exec(raw ?? '')?.[1])
}
export function cgroupPath(root: string, group: string | undefined): string | null {
  if (!group?.startsWith('/') || group.split('/').includes('..') || group.includes('\0')) return null
  const resolved = path.resolve(root, `.${group}`)
  return resolved.startsWith(`${path.resolve(root)}${path.sep}`) ? resolved : null
}
export function readCgroupMemory(root: string, group: string | undefined): ResourceSnapshot {
  const result = emptyResourceSnapshot()
  const directory = cgroupPath(root, group)
  const read = (name: string) => directory ? readText(path.join(directory, name)) : undefined
  const mb = (raw: string | undefined) => { const n = parseCounter(raw); return n == null ? null : n / MIB }
  const state = (raw: string | undefined) => raw === 'max' || raw === 'infinity' ? 'unlimited' as const : parseCounter(raw) == null ? 'unknown' as const : 'finite' as const
  result.memoryCurrentMb = mb(read('memory.current'))
  result.memoryPeakMb = mb(read('memory.peak'))
  result.memoryMaxMb = mb(read('memory.max'))
  result.memoryHighMb = mb(read('memory.high'))
  result.memoryMaxState = state(read('memory.max'))
  result.memoryHighState = state(read('memory.high'))
  result.swapCurrentMb = mb(read('memory.swap.current'))
  result.swapMaxMb = mb(read('memory.swap.max'))
  const events = read('memory.events.local') ?? read('memory.events')
  const counter = (key: string) => parseCounter(new RegExp(`^${key}\\s+(\\d+)\\s*$`, 'm').exec(events ?? '')?.[1])
  result.highEvents = counter('high')
  result.maxEvents = counter('max')
  result.oomKillCount = counter('oom_kill')
  result.memoryPressureFullAvg10 = parseMemoryPsi(read('memory.pressure'))
  result.memoryAndSwapPeakMb = result.memoryCurrentMb != null && result.swapCurrentMb != null ? result.memoryCurrentMb + result.swapCurrentMb : null
  result.peakLimited = result.memoryMaxMb != null && ((result.memoryPeakMb ?? result.memoryCurrentMb ?? 0) >= result.memoryMaxMb * .95 || (result.maxEvents ?? 0) > 0)
  return result
}

export function calculateMemoryReserveMb(panelPeakMb: number | null, headroomMb = Number(readBrandEnv('BSP_HOST_MEMORY_HEADROOM_MB')) || 0): number {
  return Math.ceil(Math.max(1024, (panelPeakMb ?? 512) * 1.5 + 512, headroomMb) / 256) * 256
}
export function buildHostResourceSnapshot(input: {
  meminfo?: string, psi?: string, source: HostResourceSnapshot['source'], panel?: ResourceSnapshot,
  pool?: ResourceSnapshot, verified?: boolean, reason?: string,
}): HostResourceSnapshot {
  const mb = (key: string) => { const n = parseCounter(new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, 'm').exec(input.meminfo ?? '')?.[1]); return n == null ? null : n / 1024 }
  const pool = input.pool ?? emptyResourceSnapshot()
  const totalMb = mb('MemTotal')
  const protectedPool = input.verified === true && totalMb != null && pool.memoryMaxMb != null && pool.memoryMaxMb > 0 && pool.memoryMaxMb <= totalMb - 1024
  return {
    availableMb: mb('MemAvailable'), totalMb, swapFreeMb: mb('SwapFree'), swapTotalMb: mb('SwapTotal'), source: input.source,
    memoryPressureFullAvg10: parseMemoryPsi(input.psi), panelCurrentMb: input.panel?.memoryCurrentMb ?? null, panelPeakMb: input.panel?.memoryPeakMb ?? null,
    reserveMb: calculateMemoryReserveMb(input.panel?.memoryPeakMb ?? null), reserveEstimated: input.panel?.memoryPeakMb == null,
    budget: {
      state: protectedPool ? 'protected' : input.source === 'unknown' ? 'unavailable' : 'legacy',
      message: protectedPool ? '共享物理内存预算已核验；swap 由两片和同机实例共享' : input.reason ?? '共享内存保护尚未生效，按现有配置启动；可在宿主机执行 sudo bsp setup-memory-budget',
      currentMb: pool.memoryCurrentMb, maxMb: pool.memoryMaxMb, swapCurrentMb: pool.swapCurrentMb,
      highMb: pool.memoryHighMb, highEvents: pool.highEvents, maxEvents: pool.maxEvents, oomKillCount: pool.oomKillCount,
      memoryPressureFullAvg10: pool.memoryPressureFullAvg10,
    },
  }
}

/** 同一轮启动、巡检与资源页面共享快照；超时结果不继续占着缓存。 */
const snapshots = new WeakMap<ContainerRuntime, Map<string, { at: number, value: Promise<ResourceSnapshot | null> }>>()
const hosts = new WeakMap<ContainerRuntime, { at: number, value: Promise<HostResourceSnapshot | null> }>()
async function bounded<T>(read: Promise<T>): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined
  try { return await Promise.race([read.catch(() => null), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 4000) })]) }
  finally { clearTimeout(timer) }
}
export function sampleRuntimeResources(runtime: ContainerRuntime, ref: ContainerRef, maxAgeMs = 4500): Promise<ResourceSnapshot | null> {
  let cache = snapshots.get(runtime)
  if (!cache) { cache = new Map(); snapshots.set(runtime, cache) }
  const prior = cache.get(ref.id)
  const now = Date.now()
  if (prior && now >= prior.at && now - prior.at < maxAgeMs) return prior.value
  const value = bounded(runtime.resourceSnapshot?.(ref) ?? Promise.resolve(null))
  cache.set(ref.id, { at: now, value })
  if (cache.size > 500) for (const [id, item] of cache) if (now - item.at > 30_000) cache.delete(id)
  return value
}
export function sampleHostResources(runtime: ContainerRuntime): Promise<HostResourceSnapshot | null> {
  const prior = hosts.get(runtime)
  const now = Date.now()
  if (prior && now >= prior.at && now - prior.at < 4500) return prior.value
  const value = bounded(runtime.hostResources?.() ?? Promise.resolve(null))
  hosts.set(runtime, { at: now, value })
  return value
}
