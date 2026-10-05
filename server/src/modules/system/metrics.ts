import { readBrandEnv } from '../../../../shared/brand-env'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { getCachedDockerStatus, startDockerStatusRefreshLoop } from '../../infra/docker'
import { getRuntimeMode, startRuntimeStatusRefreshLoop } from '../../infra/runtime'
import { execPowerShellAsync } from '../../infra/powershell'
import {
  clampPercent,
  collectHostResourceSnapshot,
  ensureCpuSamplerStarted,
  getCpuUsageRate,
  getDiskUsage,
  resolveMemoryUsage,
  resolveSwapUsage,
  toGb,
} from '../../shared/host-metrics'

export {
  clampPercent,
  collectHostResourceSnapshot,
  ensureCpuSamplerStarted,
  getCpuUsageRate,
  getDiskUsage,
  resolveMemoryUsage,
  resolveSwapUsage,
  toGb,
}
export type { HostResourceSnapshot } from '../../shared/host-metrics'

const WINDOWS_QUEUE_CACHE_MS = 8_000
const NETWORK_SAMPLER_INTERVAL_MS = process.platform === 'win32' ? 4_000 : 2_000

interface TtlCacheEntry<T> {
  value: T
  expiresAt: number
}

interface WindowsQueueMetrics {
  cpuQueueLength: number | null
  diskQueueLength: number | null
}

interface RawNetworkSnapshot {
  name: string
  sentBytes: number
  receivedBytes: number
}

export interface NetworkRealtimeItem {
  name: string
  upBps: number
  downBps: number
  totalSentBytes: number
  totalReceivedBytes: number
}

const EMPTY_WINDOWS_QUEUE: WindowsQueueMetrics = {
  cpuQueueLength: null,
  diskQueueLength: null,
}

const windowsQueueCache: { entry: TtlCacheEntry<WindowsQueueMetrics> | null } = { entry: null }
let windowsQueueRefreshInFlight = false
let networkRefreshInFlight = false
let slowMetricsRefreshLoopsStarted = false

let cachedPanelVersion: string | null = null
let previousNetworkSnapshotAt = 0
const previousNetworkSnapshot = new Map<string, {
  sentBytes: number
  receivedBytes: number
}>()

let cachedNetworkRealtime: {
  timestamp: number
  interfaces: NetworkRealtimeItem[]
} = {
  timestamp: Date.now(),
  interfaces: [],
}

let networkSamplerStarted = false

const WINDOWS_NETWORK_STATS_COMMAND = `
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Get-NetAdapterStatistics | Select-Object Name,ReceivedBytes,SentBytes | ConvertTo-Json -Compress
`.trim()

function getPanelVersion() {
  const envVersion = readBrandEnv('BSP_RELEASE_VERSION')?.trim()
  if (envVersion) {
    return envVersion
  }
  try {
    const packageJsonPath = path.resolve(process.cwd(), 'package.json')
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      version?: string
    }
    return packageJson.version ?? 'unknown'
  }
  catch {
    return 'unknown'
  }
}

export function getCachedPanelVersion() {
  if (cachedPanelVersion === null) {
    cachedPanelVersion = getPanelVersion()
  }
  return cachedPanelVersion
}

function normalizeCounterValue(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  return Number(Math.max(0, value).toFixed(2))
}

function parseWindowsQueueMetricsFromStdout(stdout: string): WindowsQueueMetrics {
  try {
    const parsed = JSON.parse(stdout.trim()) as Array<{ Path?: unknown, CookedValue?: unknown }> | { Path?: unknown, CookedValue?: unknown }
    const samples = Array.isArray(parsed) ? parsed : [parsed]
    const cpuSample = samples.find(item => typeof item.Path === 'string' && item.Path.includes('Processor Queue Length'))
    const diskSample = samples.find(item => typeof item.Path === 'string' && item.Path.includes('Current Disk Queue Length'))
    return {
      cpuQueueLength: normalizeCounterValue(cpuSample?.CookedValue),
      diskQueueLength: normalizeCounterValue(diskSample?.CookedValue),
    }
  }
  catch {
    return EMPTY_WINDOWS_QUEUE
  }
}

async function fetchWindowsQueueMetricsAsync(): Promise<WindowsQueueMetrics> {
  const command = `$samples = Get-Counter '\\System\\Processor Queue Length','\\PhysicalDisk(_Total)\\Current Disk Queue Length' | Select-Object -ExpandProperty CounterSamples | Select-Object Path,CookedValue; $samples | ConvertTo-Json -Compress`
  const stdout = await execPowerShellAsync(command)
  if (!stdout) {
    return EMPTY_WINDOWS_QUEUE
  }
  return parseWindowsQueueMetricsFromStdout(stdout)
}

function scheduleWindowsQueueRefresh(force = false) {
  const now = Date.now()
  if (windowsQueueRefreshInFlight) {
    return
  }
  if (!force && windowsQueueCache.entry && windowsQueueCache.entry.expiresAt > now) {
    return
  }
  windowsQueueRefreshInFlight = true
  void fetchWindowsQueueMetricsAsync()
    .then((value) => {
      windowsQueueCache.entry = {
        value,
        expiresAt: Date.now() + WINDOWS_QUEUE_CACHE_MS,
      }
    })
    .finally(() => {
      windowsQueueRefreshInFlight = false
    })
}

export function getCachedWindowsQueueMetrics() {
  scheduleWindowsQueueRefresh()
  return windowsQueueCache.entry?.value ?? EMPTY_WINDOWS_QUEUE
}

export function getCachedDockerStatusForSystem() {
  return getCachedDockerStatus()
}

function parseWindowsNetworkSnapshotsFromStdout(stdout: string): RawNetworkSnapshot[] {
  try {
    const parsed = JSON.parse(stdout.trim()) as Array<{
      Name?: unknown
      ReceivedBytes?: unknown
      SentBytes?: unknown
    }> | {
      Name?: unknown
      ReceivedBytes?: unknown
      SentBytes?: unknown
    }
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    return rows
      .map((row) => {
        if (typeof row.Name !== 'string') {
          return null
        }
        const receivedBytes = Number(row.ReceivedBytes)
        const sentBytes = Number(row.SentBytes)
        if (!Number.isFinite(receivedBytes) || !Number.isFinite(sentBytes)) {
          return null
        }
        return {
          name: row.Name,
          sentBytes: Math.max(0, sentBytes),
          receivedBytes: Math.max(0, receivedBytes),
        }
      })
      .filter((item): item is RawNetworkSnapshot => item !== null)
  }
  catch {
    return []
  }
}

async function fetchWindowsNetworkSnapshotsAsync(): Promise<RawNetworkSnapshot[]> {
  const stdout = await execPowerShellAsync(WINDOWS_NETWORK_STATS_COMMAND)
  if (!stdout) {
    return []
  }
  return parseWindowsNetworkSnapshotsFromStdout(stdout)
}

function parseLinuxNetworkSnapshots(): RawNetworkSnapshot[] {
  const filePath = '/proc/net/dev'
  if (!fs.existsSync(filePath)) {
    return []
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8')
    const lines = content
      .split('\n')
      .slice(2)
      .map(line => line.trim())
      .filter(Boolean)

    return lines
      .map((line) => {
        const [ifacePart, statsPart] = line.split(':')
        if (!ifacePart || !statsPart) {
          return null
        }
        const numbers = statsPart
          .trim()
          .split(/\s+/)
          .map(value => Number(value))
        if (numbers.length < 9 || numbers.some(value => !Number.isFinite(value))) {
          return null
        }
        return {
          name: ifacePart.trim(),
          receivedBytes: Math.max(0, numbers[0] ?? 0),
          sentBytes: Math.max(0, numbers[8] ?? 0),
        }
      })
      .filter((item): item is RawNetworkSnapshot => item !== null)
  }
  catch {
    return []
  }
}

async function fetchRawNetworkSnapshotsAsync(): Promise<RawNetworkSnapshot[]> {
  if (process.platform === 'win32') {
    return fetchWindowsNetworkSnapshotsAsync()
  }
  if (process.platform === 'linux') {
    return parseLinuxNetworkSnapshots()
  }
  return []
}

function buildRealtimeNetworkStats(currentSnapshots: RawNetworkSnapshot[]): {
  timestamp: number
  interfaces: NetworkRealtimeItem[]
} {
  const timestamp = Date.now()
  const elapsedSeconds = previousNetworkSnapshotAt > 0
    ? Math.max(0.5, (timestamp - previousNetworkSnapshotAt) / 1000)
    : 1
  const interfaces: NetworkRealtimeItem[] = currentSnapshots.map((snapshot) => {
    const previous = previousNetworkSnapshot.get(snapshot.name)
    const sentDelta = previous ? Math.max(0, snapshot.sentBytes - previous.sentBytes) : 0
    const receivedDelta = previous ? Math.max(0, snapshot.receivedBytes - previous.receivedBytes) : 0
    return {
      name: snapshot.name,
      upBps: Number((sentDelta / elapsedSeconds).toFixed(2)),
      downBps: Number((receivedDelta / elapsedSeconds).toFixed(2)),
      totalSentBytes: snapshot.sentBytes,
      totalReceivedBytes: snapshot.receivedBytes,
    }
  })

  previousNetworkSnapshot.clear()
  currentSnapshots.forEach((snapshot) => {
    previousNetworkSnapshot.set(snapshot.name, {
      sentBytes: snapshot.sentBytes,
      receivedBytes: snapshot.receivedBytes,
    })
  })
  previousNetworkSnapshotAt = timestamp

  return {
    timestamp,
    interfaces: interfaces.sort((a, b) => a.name.localeCompare(b.name)),
  }
}

async function refreshNetworkRealtimeCacheAsync() {
  if (networkRefreshInFlight) {
    return
  }
  networkRefreshInFlight = true
  try {
    const snapshots = await fetchRawNetworkSnapshotsAsync()
    cachedNetworkRealtime = buildRealtimeNetworkStats(snapshots)
  }
  catch {
    // 保留上一轮结果，避免采样失败时清空图表。
  }
  finally {
    networkRefreshInFlight = false
  }
}

function startNetworkRealtimeSampler() {
  if (networkSamplerStarted) {
    return
  }
  networkSamplerStarted = true
  void refreshNetworkRealtimeCacheAsync()
  const timer = setInterval(() => {
    void refreshNetworkRealtimeCacheAsync()
  }, NETWORK_SAMPLER_INTERVAL_MS)
  if (typeof timer === 'object' && 'unref' in timer && typeof timer.unref === 'function') {
    timer.unref()
  }
}

function startSlowMetricsRefreshLoops() {
  if (slowMetricsRefreshLoopsStarted) {
    return
  }
  slowMetricsRefreshLoopsStarted = true
  if (getRuntimeMode() === 'docker') {
    startDockerStatusRefreshLoop()
  }
  else {
    startRuntimeStatusRefreshLoop()
  }
  if (process.platform === 'win32') {
    scheduleWindowsQueueRefresh(true)
    const queueTimer = setInterval(scheduleWindowsQueueRefresh, WINDOWS_QUEUE_CACHE_MS, true)
    if (typeof queueTimer === 'object' && 'unref' in queueTimer && typeof queueTimer.unref === 'function') {
      queueTimer.unref()
    }
  }
}

export function warmSystemMetricsCaches() {
  if (readBrandEnv('BSP_UNIT_TEST') === '1') {
    return
  }
  getCachedPanelVersion()
  // CPU 采样固定在后台跑：节点卡片、监控台与阈值告警读同一个窗口，不再互相偷窗口
  ensureCpuSamplerStarted()
  startSlowMetricsRefreshLoops()
  startNetworkRealtimeSampler()
}

export function getCachedNetworkRealtime() {
  if (!networkSamplerStarted) {
    startNetworkRealtimeSampler()
  }
  return cachedNetworkRealtime
}

export function ensureNetworkSamplerStarted() {
  if (!networkSamplerStarted) {
    startNetworkRealtimeSampler()
  }
}
