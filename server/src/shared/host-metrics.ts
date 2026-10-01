import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { kbToGb, readProcMeminfoKb } from './proc-meminfo'

export interface HostResourceSnapshot {
  cpu: {
    cores: number
    usageRate: number
    availableRate: number
  }
  memory: {
    totalGb: number
    usedGb: number
    freeGb: number
    usageRate: number
  }
  disk: {
    totalGb: number
    usedGb: number
    freeGb: number
    usageRate: number
  }
}

/** CPU 采样周期：节点卡片、监控台、阈值告警读的必须是同一个窗口 */
const CPU_SAMPLE_INTERVAL_MS = 3000
/** 同步兜底采样的最小窗口，避免同一时刻的并发调用把窗口切成毫秒级噪声 */
const CPU_MIN_SAMPLE_WINDOW_MS = 1000

export interface CpuTimes {
  /** user + nice + sys + idle + irq 的累计时间（毫秒） */
  total: number
  /** idle 累计时间（毫秒） */
  idle: number
}

let cpuSamplerTimer: ReturnType<typeof setInterval> | null = null
let previousCpuTimes: CpuTimes | null = null
let previousCpuSampleAt = 0
let cachedCpuUsageRate: number | null = null

export function toGb(value: number) {
  return Number((value / 1024 / 1024 / 1024).toFixed(2))
}

export function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))
}

/** 汇总一次 `/proc/stat` 读数（经 `os.cpus()`）；容器内读到的同样是宿主机 CPU */
export function readCpuTimes(): CpuTimes {
  const cpuInfo = os.cpus()
  const total = cpuInfo.reduce((sum, core) => {
    return sum + core.times.user + core.times.nice + core.times.sys + core.times.idle + core.times.irq
  }, 0)
  const idle = cpuInfo.reduce((sum, core) => sum + core.times.idle, 0)
  return { total, idle }
}

/**
 * 两次读数之间的 CPU 使用率（全核 100%）。
 *
 * 无有效增量（首次采样、时钟回绕）时返回 null，由调用方决定回退值：旧实现在首次
 * 调用时退化成「开机以来平均使用率」，面板重启后的第一个数字因此明显偏低，与
 * 同一台机器上其它位置显示的瞬时值对不上。
 */
export function computeCpuUsageRate(previous: CpuTimes | null, current: CpuTimes): number | null {
  if (!previous) {
    return null
  }
  const totalDelta = current.total - previous.total
  const idleDelta = current.idle - previous.idle
  if (totalDelta <= 0 || idleDelta < 0) {
    return null
  }
  return Number(clampPercent(((totalDelta - idleDelta) / totalDelta) * 100).toFixed(2))
}

function sampleCpuUsageRate(force: boolean) {
  const now = Date.now()
  // 最小窗口对「还没有算出过值」同样生效：否则同一时刻的并发请求会互相把窗口切碎
  if (!force && now - previousCpuSampleAt < CPU_MIN_SAMPLE_WINDOW_MS) {
    return cachedCpuUsageRate
  }
  const current = readCpuTimes()
  const usageRate = computeCpuUsageRate(previousCpuTimes, current)
  previousCpuTimes = current
  previousCpuSampleAt = now
  if (usageRate !== null) {
    cachedCpuUsageRate = usageRate
  }
  return cachedCpuUsageRate
}

/**
 * 启动 CPU 采样器：固定周期采样一次，所有展示位共用同一窗口。
 *
 * 旧实现把「上一次 /proc/stat 读数」放在模块级状态里、并在每次请求时推进，于是
 * 节点卡片（10 秒轮询）、监控台（10 秒轮询）、通知阈值检查（60 秒）与自检互相
 * 偷窗口：两处同时刷新时，后到的调用可能只覆盖几十毫秒，读出来的数字纯属噪声。
 */
export function ensureCpuSamplerStarted() {
  if (cpuSamplerTimer) {
    return
  }
  // 先落一次基线，第一个真实窗口在 CPU_SAMPLE_INTERVAL_MS 之后产生
  sampleCpuUsageRate(true)
  cpuSamplerTimer = setInterval(() => {
    sampleCpuUsageRate(true)
  }, CPU_SAMPLE_INTERVAL_MS)
  if (typeof cpuSamplerTimer === 'object' && 'unref' in cpuSamplerTimer && typeof cpuSamplerTimer.unref === 'function') {
    cpuSamplerTimer.unref()
  }
}

export function getCpuUsageRate() {
  return sampleCpuUsageRate(false) ?? 0
}

export function getDiskUsage() {
  const rootPath = path.parse(process.cwd()).root || process.cwd()
  const stats = fs.statfsSync(rootPath)
  const total = stats.blocks * stats.bsize
  const available = stats.bavail * stats.bsize
  const used = total - available
  return {
    totalGb: toGb(total),
    usedGb: toGb(used),
    freeGb: toGb(available),
  }
}

export interface MemoryUsageReading {
  totalGb: number
  usedGb: number
  freeGb: number
  usageRate: number
}

/**
 * 内存使用率：已用 = 总量 − **可用**（Linux 取 MemAvailable，含可回收的 page cache）。
 *
 * 不用 MemFree：它把 page cache 也算成已用。4 GiB 机器跑 DST 时，读过几 GB 游戏文件
 * 就会显示 95% 内存占用，而同一台机器上的启动守卫按 MemAvailable 判断「还能再起一个
 * 分片」——同机两套口径打架，用户只能自己登服务器 `free -h` 才知道该信谁。
 * 拿不到 `/proc` 的环境（Windows 开发机）回退 `os.freemem()`，保持既有行为。
 */
export function resolveMemoryUsage(totalBytes: number, availableKb: number | null): MemoryUsageReading {
  const totalKb = totalBytes / 1024
  const usableKb = availableKb !== null && availableKb > 0
    ? Math.min(availableKb, totalKb)
    : null
  const availableBytes = usableKb !== null ? usableKb * 1024 : os.freemem()
  const usedBytes = Math.max(0, totalBytes - availableBytes)
  return {
    totalGb: toGb(totalBytes),
    usedGb: toGb(usedBytes),
    freeGb: toGb(availableBytes),
    usageRate: totalBytes > 0
      ? Number(clampPercent((usedBytes / totalBytes) * 100).toFixed(2))
      : 0,
  }
}

export interface SwapUsageReading {
  totalGb: number
  usedGb: number
  freeGb: number
  usageRate: number
}

/**
 * 缓存区使用情况。
 *
 * 没有配置缓存区（`SwapTotal` 为 0 或读不到 `/proc`）时返回 null：「未配置」与
 * 「配置了但用满」是两种完全不同的处境，都显示成 0% 会让前者看起来比后者安全。
 * 小内存机真正致命的往往不是内存占用百分比，而是「可用内存 + 缓存区余量」还剩多少 ——
 * 启动守卫判的就是这个和，面板得能把它摆出来。
 */
export function resolveSwapUsage(totalKb: number | null, freeKb: number | null): SwapUsageReading | null {
  if (totalKb === null || freeKb === null || totalKb <= 0) {
    return null
  }
  const free = Math.max(0, Math.min(freeKb, totalKb))
  const usedKb = totalKb - free
  return {
    totalGb: kbToGb(totalKb) ?? 0,
    usedGb: kbToGb(usedKb) ?? 0,
    freeGb: kbToGb(free) ?? 0,
    usageRate: Number(clampPercent((usedKb / totalKb) * 100).toFixed(2)),
  }
}

/** 采集当前宿主机 CPU / 内存 / 磁盘快照（node 与 system 模块共用） */
export function collectHostResourceSnapshot(): HostResourceSnapshot {
  const cpuUsageRate = getCpuUsageRate()
  const memory = resolveMemoryUsage(os.totalmem(), readProcMeminfoKb('MemAvailable'))
  const disk = getDiskUsage()
  const diskUsageRate = disk.totalGb > 0
    ? Number(clampPercent((disk.usedGb / disk.totalGb) * 100).toFixed(2))
    : 0

  return {
    cpu: {
      cores: Math.max(1, os.cpus().length),
      usageRate: cpuUsageRate,
      availableRate: Number((100 - cpuUsageRate).toFixed(2)),
    },
    memory,
    disk: {
      totalGb: disk.totalGb,
      usedGb: disk.usedGb,
      freeGb: disk.freeGb,
      usageRate: diskUsageRate,
    },
  }
}
