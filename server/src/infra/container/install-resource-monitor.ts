import fs from 'node:fs'
import path from 'node:path'
import type Docker from 'dockerode'
import { ensureInstallLogsDir } from '../../shared/instance-install/log-store'
import {
  formatSteamcmdMemoryLimitForLog,
  resolveSteamcmdContainerMemoryLimits,
} from './steamcmd-container-resources'

export interface ResourceSnapshot {
  runtimeMode: 'docker' | 'native'
  timestamp: string
  phase: string
  instanceId: string
  panelMemTotalMb: number | null
  panelMemAvailableMb: number | null
  panelSwapFreeMb: number | null
  dockerMemTotalMb: number | null
  dockerContainersRunning: number | null
  steamcmdJobsRunning: number
  steamcmdMemoryLimit: string
  containers: Array<{
    id: string
    name: string
    memoryUsageMb: number | null
    memoryLimitMb: number | null
    cpuPercent: number | null
  }>
  extra?: Record<string, unknown>
}

function readProcMeminfoKb(field: string): number | null {
  try {
    const content = fs.readFileSync('/proc/meminfo', 'utf8')
    const line = content.split('\n').find(item => item.startsWith(`${field}:`))
    if (!line) {
      return null
    }
    const match = line.match(/(\d+)/)
    return match ? Number(match[1]) : null
  }
  catch {
    return null
  }
}

function kbToMb(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) {
    return null
  }
  return Math.round(value / 1024)
}

async function collectManagedSteamcmdStats(docker: Docker): Promise<ResourceSnapshot['containers']> {
  try {
    const listed = await docker.listContainers({
      all: false,
      filters: { label: ['bsp.managed=steamcmd-install'] },
    })
    const rows: ResourceSnapshot['containers'] = []
    for (const item of listed) {
      const id = item.Id
      const name = item.Names?.[0]?.replace(/^\//, '') ?? id.slice(0, 12)
      try {
        const stats = await docker.getContainer(id).stats({ stream: false }) as {
          memory_stats?: { usage?: number, limit?: number }
          cpu_stats?: { cpu_usage?: { total_usage?: number } }
          precpu_stats?: { cpu_usage?: { total_usage?: number } }
        }
        const usage = stats.memory_stats?.usage
        const limit = stats.memory_stats?.limit
        rows.push({
          id: id.slice(0, 12),
          name,
          memoryUsageMb: typeof usage === 'number' ? Math.round(usage / 1024 / 1024) : null,
          memoryLimitMb: typeof limit === 'number' ? Math.round(limit / 1024 / 1024) : null,
          cpuPercent: null,
        })
      }
      catch {
        rows.push({ id: id.slice(0, 12), name, memoryUsageMb: null, memoryLimitMb: null, cpuPercent: null })
      }
    }
    return rows
  }
  catch {
    return []
  }
}

export async function buildInstallResourceSnapshot(
  docker: Docker | null,
  input: { instanceId: string, phase: string, extra?: Record<string, unknown> },
): Promise<ResourceSnapshot> {
  let dockerMemTotalMb: number | null = null
  let dockerContainersRunning: number | null = null
  if (docker) {
    try {
    const info = await docker.info()
    if (typeof info.MemTotal === 'number') {
      dockerMemTotalMb = Math.round(info.MemTotal / 1024 / 1024)
    }
    if (typeof info.ContainersRunning === 'number') {
      dockerContainersRunning = info.ContainersRunning
    }
    }
    catch {
      // ignore
    }
  }

  const containers = docker ? await collectManagedSteamcmdStats(docker) : []
  const limits = docker ? resolveSteamcmdContainerMemoryLimits('app-update') : undefined

  return {
    runtimeMode: docker ? 'docker' : 'native',
    timestamp: new Date().toISOString(),
    phase: input.phase,
    instanceId: input.instanceId,
    panelMemTotalMb: kbToMb(readProcMeminfoKb('MemTotal')),
    panelMemAvailableMb: kbToMb(readProcMeminfoKb('MemAvailable')),
    panelSwapFreeMb: kbToMb(readProcMeminfoKb('SwapFree')),
    dockerMemTotalMb,
    dockerContainersRunning,
    steamcmdJobsRunning: containers.length,
    steamcmdMemoryLimit: docker ? formatSteamcmdMemoryLimitForLog(limits) : '宿主机/systemd 策略',
    containers,
    extra: input.extra,
  }
}

export function formatResourceSnapshotLines(snapshot: ResourceSnapshot): string[] {
  const lines = [
    `[资源快照 ${snapshot.phase}] ${snapshot.timestamp}`,
    `宿主机 MemAvailable: ${snapshot.panelMemAvailableMb ?? '?'} / ${snapshot.panelMemTotalMb ?? '?'} MiB，SwapFree: ${snapshot.panelSwapFreeMb ?? '?'} MiB`,
  ]
  if (snapshot.runtimeMode === 'docker') {
    lines.push(
      `Docker 可见 MemTotal: ${snapshot.dockerMemTotalMb ?? '?'} MiB，运行中容器: ${snapshot.dockerContainersRunning ?? '?'}`,
      `SteamCMD 子容器内存上限: ${snapshot.steamcmdMemoryLimit}，当前运行中 SteamCMD 任务: ${snapshot.steamcmdJobsRunning}`,
    )
  }
  else {
    lines.push('SteamCMD 直接运行在宿主机，由面板任务队列管理')
  }
  for (const row of snapshot.containers) {
    lines.push(
      `  - ${row.name}: ${row.memoryUsageMb ?? '?'} / ${row.memoryLimitMb ?? '?'} MiB`,
    )
  }
  if (snapshot.extra && Object.keys(snapshot.extra).length > 0) {
    lines.push(`  附加: ${JSON.stringify(snapshot.extra)}`)
  }
  return lines
}

export async function appendInstallResourceSnapshot(
  installLogsDir: string,
  docker: Docker | null,
  input: { instanceId: string, phase: string, extra?: Record<string, unknown> },
): Promise<string[]> {
  ensureInstallLogsDir(installLogsDir)
  const snapshot = await buildInstallResourceSnapshot(docker, input)
  const instanceLogPath = path.join(installLogsDir, `${input.instanceId}.resource.ndjson`)
  const hostLogPath = path.join(installLogsDir, '_host.resource.ndjson')
  const line = `${JSON.stringify(snapshot)}\n`
  fs.appendFileSync(instanceLogPath, line, 'utf8')
  fs.appendFileSync(hostLogPath, line, 'utf8')
  return formatResourceSnapshotLines(snapshot)
}
