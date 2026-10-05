import { readBrandEnv } from '../../../../shared/brand-env'
/** Docker HostConfig.Memory / MemorySwap（字节）。MemorySwap === Memory 表示禁用 swap */

export interface SteamcmdContainerMemoryLimits {
  Memory: number
  MemorySwap: number
}

const MIB = 1024 * 1024

function parseExplicitMb(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim()
  if (!trimmed || trimmed === '0') {
    return undefined
  }
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined
  }
  return Math.floor(parsed)
}

/**
 * SteamCMD 子容器内存硬上限（非预留）。未设置或设为 0 时不限制，便于高配机跑满；
 * 小内存/WSL2 宿主机可在 panel.env 显式设置，例如 BSP_STEAMCMD_CONTAINER_MEMORY_MB=2048。
 */
export function resolveSteamcmdContainerMemoryLimits(
  kind: 'app-update' | 'app-info',
): SteamcmdContainerMemoryLimits | undefined {
  const envKey = kind === 'app-update'
    ? 'BSP_STEAMCMD_CONTAINER_MEMORY_MB'
    : 'BSP_STEAMCMD_APP_INFO_MEMORY_MB'
  const memoryMb = parseExplicitMb(readBrandEnv(envKey))
  if (memoryMb === undefined) {
    return undefined
  }
  const swapRaw = readBrandEnv('BSP_STEAMCMD_CONTAINER_MEMORY_SWAP_MB')?.trim()
  let swapMb: number
  if (kind === 'app-info' || swapRaw === '0') {
    swapMb = memoryMb
  }
  else if (swapRaw) {
    swapMb = parseExplicitMb(swapRaw) ?? memoryMb
  }
  else {
    swapMb = memoryMb
  }
  return {
    Memory: memoryMb * MIB,
    MemorySwap: swapMb * MIB,
  }
}

export function resolveSteamcmdContainerMemoryCapMb(kind: 'app-update' | 'app-info' = 'app-update'): number | undefined {
  const limits = resolveSteamcmdContainerMemoryLimits(kind)
  if (!limits) {
    return undefined
  }
  return Math.round(limits.Memory / MIB)
}

export function formatSteamcmdMemoryLimitForLog(limits: SteamcmdContainerMemoryLimits | undefined): string {
  if (!limits) {
    return '未设置硬上限（可按需配置 BSP_STEAMCMD_CONTAINER_MEMORY_MB；小内存机建议 1536–2048）'
  }
  const memoryMiB = Math.round(limits.Memory / MIB)
  const swapDisabled = limits.MemorySwap === limits.Memory
  return `${memoryMiB} MiB 硬上限${swapDisabled ? '（禁用 swap）' : ''}，非预留内存`
}
