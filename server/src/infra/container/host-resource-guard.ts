import { readBrandEnv } from '../../../../shared/brand-env'
import type { HostMemoryPressureData } from '../../../../shared/contracts/host-memory-pressure'
import type { SwapAdvice } from '../../../../shared/contracts/instance-resources'
import {
  kbToMb,
  parseMeminfoValueKb,
  readHostMemoryAvailableMb,
  readHostMemoryTotalMb,
  readHostSwapFreeMb,
  readProcMeminfoKb,
} from '../../shared/proc-meminfo'
import { resolveDstContainerResourceLimits } from './dst-container-resources'
import { resolveSteamcmdContainerMemoryCapMb } from './steamcmd-container-resources'

const MIB = 1024 * 1024

/** 守卫用：SteamCMD 安装典型峰值（MiB），与 Docker 硬上限解耦 */
const DEFAULT_STEAMCMD_PLANNING_MB = 1280
/** 守卫用：未限制 DST 容器时的启动峰值估计 */
const DEFAULT_DST_PLANNING_MB = 768
/** 单分片空跑（0 个 Mod）的内存基线（MiB） */
const DST_PLANNING_BASE_MB = 512
/**
 * 每个已启用 Mod 的额外内存估算（MiB）。
 * 线上实测：36 个 Mod 的主世界分片 anon-rss 峰值约 2.0 GiB，与 512 + 32×36 ≈ 1.6 GiB 同量级。
 */
const DST_PLANNING_MB_PER_MOD = 32
/** 守卫用：同机 seed 复制时的页缓存峰值估计 */
const DEFAULT_SEED_PLANNING_MB = 768

export type HeavyHostOperation = 'steamcmd-install' | 'dst-container-start' | 'install-seed-copy'

/** DST 启动守卫的上下文：只有知道要起几个分片、挂多少 Mod，估算才有意义 */
export interface DstStartMemoryContext {
  /** 本次新增分片的有效硬限，仅用于说明；0/null 表示不限。 */
  memoryCapMb?: number | null
  /** 本次启动会拉起的分片数（仅主世界 1，开启洞穴 2） */
  shardCount?: number
  /** 启用中的 Mod 数量 */
  modCount?: number
  /** 同一采样的 RAM + swap 峰值；不受分片硬限截断。 */
  measuredDemandMb?: number | null
}

/** 一次读取的宿主机内存快照，作为守卫判定的输入（可注入以便测试） */
export interface HostMemoryReading {
  availableMb: number | null
  /** 仅用于失败说明里的「总内存约 N MiB」提示，因此可省略 */
  totalMb?: number | null
  swapFreeMb: number | null
  /** swap 总量；省略或为 null 表示没读到（无 /proc 的环境），此时说不了「未配置」也分不清「用满」 */
  swapTotalMb?: number | null
  poolAvailableMb?: number | null
}

/** 读取真实 /proc/meminfo；无 /proc 的环境（Windows 原生）返回 null 字段 */
export function readHostMemoryReading(): HostMemoryReading {
  return {
    availableMb: kbToMb(readProcMeminfoKb('MemAvailable')),
    totalMb: kbToMb(readProcMeminfoKb('MemTotal')),
    swapFreeMb: kbToMb(readProcMeminfoKb('SwapFree')),
    swapTotalMb: kbToMb(readProcMeminfoKb('SwapTotal')),
  }
}

/** low 表示已有 swap 余量仍不足本次操作预算。 */
export type SwapState = 'unknown' | 'none' | 'low' | 'exhausted' | 'ready'

/**
 * 只按 `SwapFree` 判「有没有 swap」是错的：它为 0 既可能是没配，也可能是配了但被用满。
 * 两者的做法相反——前者执行 `bsp setup-swap` 能建出 swapfile，后者会被它直接跳过
 * （脚本检测到已有 swap 就不动），照做一遍什么都不会变，排查方向被带偏。
 */
export function resolveSwapState(
  memory: Pick<HostMemoryReading, 'swapFreeMb' | 'swapTotalMb'> & Partial<Pick<HostMemoryReading, 'availableMb'>>,
  requiredMb = 0,
): SwapState {
  const { swapFreeMb, swapTotalMb } = memory
  if (swapTotalMb === 0) return 'none'
  if (swapFreeMb === null || ((swapTotalMb == null) && swapFreeMb === 0)) return 'unknown'
  if (swapFreeMb === 0) return 'exhausted'
  return memory.availableMb != null && memory.availableMb + swapFreeMb < requiredMb ? 'low' : 'ready'
}

export function buildHostSwapAdvice(memory: HostMemoryReading, requiredMb: number): { state: SwapState, message: string, command: string | null } {
  const state = resolveSwapState(memory, requiredMb)
  const missingMb = Math.max(0, Math.ceil(requiredMb - (memory.availableMb ?? 0) - (memory.swapFreeMb ?? 0)))
  const sizeGb = Math.max(2, Math.ceil(missingMb / 1024))
  const shortage = missingMb ? `按本次启动估算还差约 ${missingMb} MiB。` : ''
  if (state === 'none') return {
    state, message: `宿主机未配置 swap。${shortage}可创建 ${sizeGb} GiB swap 吸收加载峰值；频繁换页会增加启动耗时。`,
    command: `sudo env BSP_SWAP_SIZE=${sizeGb}G bsp setup-swap`,
  }
  if (state === 'low' || state === 'exhausted') return {
    state, message: `${state === 'exhausted' ? '宿主机 swap 已用满' : `宿主机可用 swap 约 ${memory.swapFreeMb} MiB，余量不足本次启动预算`}。${shortage}先停止其他实例释放内存；需要扩缓存区时可追加 ${sizeGb} GiB swap 文件。请确认磁盘余量，若示例路径已存在则换一个新路径；频繁换页会增加启动耗时。`,
    command: `sudo env BSP_SWAP_FILE=/swapfile-bsp-extra-${sizeGb}g BSP_SWAP_SIZE=${sizeGb}G bsp setup-swap`,
  }
  return state === 'ready'
    ? { state, message: `宿主机可用 swap 约 ${memory.swapFreeMb} MiB，当前余量满足估算预算；频繁换页会增加启动耗时。`, command: null }
    : { state, message: '无法读取宿主机 swap 状态，可先检查已启用的 swap。', command: 'sudo swapon --show' }
}

/** 只有确认启动余量不足才给操作建议；未知读数或充足 RAM 不制造 swap 告警。 */
export function buildStartupSwapAdvice(memory: HostMemoryReading, requiredMb: number): SwapAdvice | undefined {
  const values = [memory.availableMb, memory.swapFreeMb, memory.swapTotalMb]
  if (!values.every(value => value != null && Number.isFinite(value) && value >= 0)
    || !Number.isFinite(requiredMb) || requiredMb <= 0
    || memory.availableMb! + memory.swapFreeMb! >= requiredMb) return undefined
  const advice = buildHostSwapAdvice(memory, requiredMb)
  if (!advice.command || !['none', 'low', 'exhausted'].includes(advice.state)) return undefined
  const missingMb = Math.ceil(requiredMb - memory.availableMb! - memory.swapFreeMb!)
  const sizeGb = Math.max(2, Math.ceil(missingMb / 1024))
  const reason = advice.state === 'none' ? '宿主机未配置 swap' : advice.state === 'exhausted' ? '宿主机 swap 已用满' : '内存与 swap 余量不足'
  return { ...advice, message: `${reason}，启动预计还缺约 ${missingMb} MiB。建议${advice.state === 'none' ? '创建' : '追加'} ${sizeGb} GiB swap。` }
}

function parsePositiveMbEnv(key: string): number | undefined {
  const raw = readBrandEnv(key)?.trim()
  if (!raw) {
    return undefined
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined
  }
  return Math.floor(parsed)
}

/**
 * 安装前内存守卫用的 SteamCMD 峰值估计（非 Docker Memory 上限）。
 * 实际上 SteamCMD 常态占用通常几百 MiB；上限仅在瞬时冲高时触发 OOM。
 */
export function resolveSteamcmdPlanningMb(): number {
  const explicit = parsePositiveMbEnv('BSP_HOST_STEAMCMD_PLANNING_MB')
  if (explicit !== undefined) {
    return explicit
  }
  const capMb = resolveSteamcmdContainerMemoryCapMb('app-update')
  if (capMb === undefined) {
    return DEFAULT_STEAMCMD_PLANNING_MB
  }
  // 守卫按典型峰值估算；即使用户设了很高硬上限，也不按上限占满来拦截
  return Math.min(capMb, DEFAULT_STEAMCMD_PLANNING_MB)
}

/**
 * 单分片启动峰值估算（MiB）。
 *
 * 传入 Mod 数量时按真实规模估算：Mod 才是内存大头，只用固定值会让「36 个 Mod 双分片」
 * 这种配置轻易通过守卫，然后在加载途中被内核 OOM 杀掉（线上已发生）。
 * 显式配置只作为下界——配置写得偏小不能变成「放行一次注定 OOM 的启动」；
 * 确实要强制启动请用 BSP_HOST_MIN_AVAILABLE_MB=0 关掉守卫。
 */
export function resolveDstShardPlanningMb(modCount?: number): number {
  const base = parsePositiveMbEnv('BSP_HOST_DST_PLANNING_MB') ?? DEFAULT_DST_PLANNING_MB
  const estimated = typeof modCount === 'number' && Number.isFinite(modCount)
    ? DST_PLANNING_BASE_MB + DST_PLANNING_MB_PER_MOD * Math.max(0, Math.floor(modCount))
    : 0
  const planned = Math.max(base, estimated)
  return planned
}

function resolveSeedPlanningMb(): number {
  return parsePositiveMbEnv('BSP_HOST_SEED_PLANNING_MB') ?? DEFAULT_SEED_PLANNING_MB
}

function resolveHostMemoryHeadroomMb(): number {
  return parsePositiveMbEnv('BSP_HOST_MEMORY_HEADROOM_MB') ?? 512
}

/** 执行重操作前要求宿主机（面板容器 /proc）剩余可用内存下限（MiB） */
export function resolveMinHostAvailableMbForOperation(
  operation: HeavyHostOperation,
  context: DstStartMemoryContext = {},
): number {
  if (readBrandEnv('BSP_HOST_MIN_AVAILABLE_MB')?.trim() === '0') return 0
  const override = parsePositiveMbEnv('BSP_HOST_MIN_AVAILABLE_MB')
  if (override !== undefined) {
    return override
  }
  const headroomMb = resolveHostMemoryHeadroomMb()
  switch (operation) {
    case 'steamcmd-install':
      return resolveSteamcmdPlanningMb() + headroomMb
    case 'dst-container-start': {
      // 按分片数累加：主世界与洞穴会各自把整套 Mod 读进内存，同时加载时峰值叠加。
      // （面板现在会等主世界就绪再拉起洞穴，但这是上界估算，宁可保守。）
      const shardCount = Math.max(1, Math.floor(context.shardCount ?? 1))
      return Math.max(resolveDstShardPlanningMb(context.modCount) * shardCount, context.measuredDemandMb ?? 0) + headroomMb
    }
    case 'install-seed-copy':
      return resolveSeedPlanningMb() + headroomMb
    default:
      return 1024
  }
}

/**
 * 内存口径与 `/proc/meminfo` 解析统一放在 `shared/proc-meminfo`，这里只做转发，
 * 保持 `host-resource-guard` 既有导出面（调用方与测试一直从这里取）。
 */
export {
  parseMeminfoValueKb,
  readHostMemoryAvailableMb,
  readHostMemoryTotalMb,
  readHostSwapFreeMb,
}

export type HostMemoryPressureFailure = {
  ok: false
  availableMb: number
  requiredMb: number
  summary: string
  detail: string
  data: HostMemoryPressureData
}

export type HostMemoryPressureResult =
  | { ok: true, availableMb: number | null, requiredMb: number }
  | HostMemoryPressureFailure

function buildHostMemoryPressureFailure(
  availableMb: number,
  requiredMb: number,
  totalMb: number | null,
  capMb: number | undefined,
  swapFreeMb: number | null,
  swapTotalMb: number | null,
  context: DstStartMemoryContext,
): HostMemoryPressureFailure {
  const totalHint = totalMb ? `（总内存约 ${totalMb} MiB）` : ''
  const advice = buildHostSwapAdvice({ availableMb, totalMb, swapFreeMb, swapTotalMb }, requiredMb)
  const swapState = advice.state
  const swapHint = swapState === 'unknown'
    ? ''
    : swapState === 'none'
      ? '，未配置缓存区'
      : swapState === 'exhausted'
        ? `，缓存区已用满（共 ${swapTotalMb} MiB）`
        : `，可用缓存区约 ${swapFreeMb} MiB`
  const explanationLines = [
    '说明：安装/启动按典型峰值估算，并非按容器上限占满内存。',
    ...(capMb ? [`当前启动分片的内存硬上限为 ${capMb} MiB（非预留占用）。`] : []),
    ...(context.modCount !== undefined
      ? [`本次启动按 ${context.shardCount ?? 1} 个分片、${context.modCount} 个启用中的 Mod 估算单分片峰值。`]
      : []),
  ]
  const detail = [
    `当前可用约 ${availableMb} MiB${swapHint}，本操作建议至少 ${requiredMb} MiB${totalHint}。`,
    '',
    ...explanationLines,
    '',
    '建议：',
    `1. ${advice.message}${advice.command ? `\n   ${advice.command}` : ''}`,
    '2. 关闭洞穴分片，减少同机运行的游戏进程与总占用',
    '3. 在「世界设置 → 模组」减少订阅的 Mod，优先检查大型 Mod 的实际占用',
    '4. 停止其他正在运行的实例，释放内存',
    '',
    '若确需强制执行：在 panel.env 设置 BSP_HOST_MIN_AVAILABLE_MB=0 可关闭内存守卫（小内存机慎用，可能触发 OOM）。',
  ].join('\n')
  const summary = `宿主机可用内存不足（当前约 ${availableMb} MiB${swapHint}，建议至少 ${requiredMb} MiB${totalHint}）`
  const data: HostMemoryPressureData = {
    availableMb,
    requiredMb,
    totalMb,
    capMb: capMb ?? null,
    swapFreeMb,
    swapTotalMb,
    detail,
  }
  return { ok: false, availableMb, requiredMb, summary, detail, data }
}

/**
 * 在面板容器内读取 MemAvailable，避免 SteamCMD 与 DST 同时压垮小内存宿主机。
 * 判据用 MemAvailable + SwapFree：DST 加载尖峰是短时的，swap 能实打实地吸收它；
 * 只看物理内存会把「有 swap 就能跑」的机器误判成跑不动。Windows 原生进程模式无 /proc 时跳过检查。
 */
export function assessHostMemoryForHeavyOperation(
  operation: HeavyHostOperation,
  context: DstStartMemoryContext = {},
  reading: HostMemoryReading = readHostMemoryReading(),
): HostMemoryPressureResult {
  const { availableMb, totalMb, swapFreeMb, swapTotalMb } = reading
  const requiredMb = resolveMinHostAvailableMbForOperation(operation, context)
  if (requiredMb === 0) return { ok: true, availableMb, requiredMb }
  if (availableMb === null) {
    return { ok: true, availableMb: null, requiredMb }
  }
  const usableMb = availableMb + (swapFreeMb ?? 0)
  const poolRequiredMb = operation === 'dst-container-start' ? Math.max(0, requiredMb - resolveHostMemoryHeadroomMb()) : 0
  if (usableMb >= requiredMb && (reading.poolAvailableMb == null || reading.poolAvailableMb + (swapFreeMb ?? 0) >= poolRequiredMb)) {
    return { ok: true, availableMb, requiredMb }
  }
  const capMb = operation === 'dst-container-start'
    ? (context.memoryCapMb === undefined ? (resolveDstContainerResourceLimits()?.memory ?? 0) / MIB || undefined : context.memoryCapMb || undefined)
    : resolveSteamcmdContainerMemoryCapMb('app-update')
  const failure = buildHostMemoryPressureFailure(
    availableMb,
    requiredMb,
    totalMb ?? null,
    capMb,
    swapFreeMb,
    swapTotalMb ?? null,
    context,
  )
  if (usableMb >= requiredMb) {
    failure.summary = '游戏共享内存池与 swap 余量不足'
    failure.detail = `游戏共享池可用约 ${Math.round(reading.poolAvailableMb ?? 0)} MiB，本次新增分片需求约 ${Math.round(poolRequiredMb)} MiB；请停止其他实例或手动追加 swap。\n${failure.detail}`
    failure.data.detail = failure.detail
  }
  return failure
}
