import { readBrandEnv } from '../../../../shared/brand-env'
/** DST 运行容器 HostConfig.Memory / NanoCpus（字节 / 纳核） */

export interface DstContainerResourceLimits {
  memory?: number
  nanoCpus?: number
}

const MIB = 1024 * 1024

function parsePositiveNumber(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim()
  if (!trimmed || trimmed === '0') {
    return undefined
  }
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined
  }
  return parsed
}

/**
 * 解析 BSP_DST_CONTAINER_MEMORY_MB / BSP_DST_CONTAINER_CPU_QUOTA。
 * CPU 配额按「逻辑核数」解释（如 1.5 表示 1.5 核）；设 0 或未设置表示不限制。
 */
export function resolveDstContainerResourceLimits(): DstContainerResourceLimits | undefined {
  const memoryMb = parsePositiveNumber(readBrandEnv('BSP_DST_CONTAINER_MEMORY_MB'))
  const cpuCores = parsePositiveNumber(readBrandEnv('BSP_DST_CONTAINER_CPU_QUOTA'))

  const limits: DstContainerResourceLimits = {}
  if (memoryMb !== undefined) {
    limits.memory = Math.floor(memoryMb) * MIB
  }
  if (cpuCores !== undefined) {
    limits.nanoCpus = Math.floor(cpuCores * 1e9)
  }

  if (!limits.memory && !limits.nanoCpus) {
    return undefined
  }
  return limits
}

export function formatDstResourceLimitsForLog(limits: DstContainerResourceLimits | undefined): string {
  if (!limits) {
    return '未设置（使用 Docker 默认）'
  }
  const parts: string[] = []
  if (limits.memory) {
    parts.push(`内存 ${(limits.memory / MIB).toFixed(0)} MiB`)
  }
  if (limits.nanoCpus) {
    parts.push(`CPU ${(limits.nanoCpus / 1e9).toFixed(2)} 核`)
  }
  return parts.join('，')
}
