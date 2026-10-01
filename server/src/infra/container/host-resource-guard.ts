import type { HostMemoryPressureData } from '../../../../shared/contracts/host-memory-pressure'
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
  /** 本次启动会拉起的分片数（仅主世界 1，开启洞穴 2） */
  shardCount?: number
  /** 启用中的 Mod 数量 */
  modCount?: number
}

/** 一次读取的宿主机内存快照，作为守卫判定的输入（可注入以便测试） */
export interface HostMemoryReading {
  availableMb: number | null
  /** 仅用于失败说明里的「总内存约 N MiB」提示，因此可省略 */
  totalMb?: number | null
  swapFreeMb: number | null
  /** swap 总量；省略或为 null 表示没读到（无 /proc 的环境），此时说不了「未配置」也分不清「用满」 */
  swapTotalMb?: number | null
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

/** swap 落点的状态。`unknown` 只在读不到 /proc/meminfo 时出现 */
export type SwapState = 'unknown' | 'none' | 'exhausted' | 'ready'

/**
 * 只按 `SwapFree` 判「有没有 swap」是错的：它为 0 既可能是没配，也可能是配了但被用满。
 * 两者的做法相反——前者执行 `gsh setup-swap` 能建出 swapfile，后者会被它直接跳过
 * （脚本检测到已有 swap 就不动），照做一遍什么都不会变，排查方向被带偏。
 */
export function resolveSwapState(
  memory: Pick<HostMemoryReading, 'swapFreeMb' | 'swapTotalMb'>,
): SwapState {
  const { swapFreeMb, swapTotalMb } = memory
  if (swapTotalMb === null || swapTotalMb === undefined) {
    return swapFreeMb !== null && swapFreeMb > 0 ? 'ready' : 'unknown'
  }
  if (swapTotalMb === 0) {
    return 'none'
  }
  return (swapFreeMb ?? 0) > 0 ? 'ready' : 'exhausted'
}

function parsePositiveMbEnv(key: string): number | undefined {
  const raw = process.env[key]?.trim()
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
  const explicit = parsePositiveMbEnv('GSH_HOST_STEAMCMD_PLANNING_MB')
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
 * 确实要强制启动请用 GSH_HOST_MIN_AVAILABLE_MB=0 关掉守卫。
 */
export function resolveDstShardPlanningMb(modCount?: number): number {
  const limits = resolveDstContainerResourceLimits()
  const capMb = limits?.memory ? Math.round(limits.memory / MIB) : undefined
  const base = parsePositiveMbEnv('GSH_HOST_DST_PLANNING_MB') ?? DEFAULT_DST_PLANNING_MB
  const estimated = typeof modCount === 'number' && Number.isFinite(modCount)
    ? DST_PLANNING_BASE_MB + DST_PLANNING_MB_PER_MOD * Math.max(0, Math.floor(modCount))
    : 0
  const planned = Math.max(base, estimated)
  return capMb ? Math.min(capMb, planned) : planned
}

function resolveSeedPlanningMb(): number {
  return parsePositiveMbEnv('GSH_HOST_SEED_PLANNING_MB') ?? DEFAULT_SEED_PLANNING_MB
}

function resolveHostMemoryHeadroomMb(): number {
  return parsePositiveMbEnv('GSH_HOST_MEMORY_HEADROOM_MB') ?? 512
}

/** 执行重操作前要求宿主机（面板容器 /proc）剩余可用内存下限（MiB） */
export function resolveMinHostAvailableMbForOperation(
  operation: HeavyHostOperation,
  context: DstStartMemoryContext = {},
): number {
  const override = parsePositiveMbEnv('GSH_HOST_MIN_AVAILABLE_MB')
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
      return resolveDstShardPlanningMb(context.modCount) * shardCount + Math.min(headroomMb, 384)
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
  const swapState = resolveSwapState({ swapFreeMb, swapTotalMb })
  const swapHint = swapState === 'unknown'
    ? ''
    : swapState === 'none'
      ? '，未配置缓存区'
      : swapState === 'exhausted'
        ? `，缓存区已用满（共 ${swapTotalMb} MiB）`
        : `，可用缓存区约 ${swapFreeMb} MiB`
  const swapAdvice = swapState === 'exhausted'
    ? '1. 扩缓存区（最有效）：缓存区已被用满，加载尖峰没有落点；先停用并删掉旧的缓存区文件，再执行 GSH_SWAP_SIZE=4G gsh setup-swap 重建'
    : '1. 加缓存区（最有效）：执行 gsh setup-swap 创建 2 GiB 缓存区文件，让加载尖峰有地方落'
  const explanationLines = [
    '说明：安装/启动按典型峰值估算，并非按容器上限占满内存。',
    ...(capMb ? [`DST 分片内存硬上限为 ${capMb} MiB（每个分片，非预留占用）。`] : []),
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
    swapAdvice,
    '2. 关闭洞穴分片：单分片启动峰值约为双分片的一半',
    '3. 在「世界设置 → 模组」减少订阅的 Mod：内存占用与 Mod 数量近似线性',
    '4. 停止其他正在运行的实例，释放内存',
    '',
    '若确需强制执行：在 panel.env 设置 GSH_HOST_MIN_AVAILABLE_MB=0 可关闭内存守卫（小内存机慎用，可能触发 OOM）。',
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
  if (availableMb === null) {
    return { ok: true, availableMb: null, requiredMb }
  }
  const usableMb = availableMb + (swapFreeMb ?? 0)
  if (usableMb >= requiredMb) {
    return { ok: true, availableMb, requiredMb }
  }
  const capMb = resolveSteamcmdContainerMemoryCapMb('app-update')
  return buildHostMemoryPressureFailure(
    availableMb,
    requiredMb,
    totalMb ?? null,
    capMb,
    swapFreeMb,
    swapTotalMb ?? null,
    context,
  )
}
