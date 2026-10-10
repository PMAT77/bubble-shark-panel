import { resolveDstContainerResourceLimits } from './dst-container-resources'
import type { HostMemoryReading } from './host-resource-guard'
import { buildHostSwapAdvice, readHostMemoryReading, resolveSwapState } from './host-resource-guard'
import type { ContainerRef, ContainerRuntime } from './types'

export function formatMemoryCapHint(actualMb: number | null | undefined, configuredMb?: number | null): string {
  if (actualMb != null && actualMb > 0) return `（实际内存硬上限 ${actualMb} MiB）`
  return configuredMb ? `（配置上限 ${configuredMb} MiB，实际未读取）` : '（实际内存硬上限未读取）'
}

/** 仅在需要故障额度详情时查询；不把旧启动报告当作新进程的证据。 */
export async function readRuntimeMemoryCapMb(runtime: ContainerRuntime, ref: ContainerRef | null | undefined): Promise<number | null | undefined> {
  if (!ref) return undefined
  try { return (await runtime.resourceSnapshot?.(ref))?.memoryMaxMb }
  catch { return undefined }
}

/** 读取宿主机内存快照，供退出原因的补充判断使用 */
export function readHostMemorySnapshot(): HostMemoryReading {
  return readHostMemoryReading()
}

/**
 * 分片被信号终止 / 非零退出时的补充判断。
 *
 * 线上最真实的故障是**整机 OOM**：内核报 `constraint=CONSTRAINT_NONE, global_oom`，
 * 而 systemd 看到的只是一次 SIGKILL，`Result` 很可能是 `signal` 而不是 `oom-kill`。
 * 于是最可能的原因拿到了最没用的提示（「进程被信号终止」），排查只能重新回到 SSH。
 *
 * 这里不做内核日志读取（面板没有权限，这正是控制台看不见日志的根因），
 * 只用面板读得到的 /proc/meminfo 补充资源余量提示；是否 OOM 仍需退出前证据，
 * 没配 swap 本身不能确认退出原因。
 *
 * 「没配 swap」与「配了但被用满」必须分开说：前者执行 `bsp setup-swap` 能建出 swapfile，
 * 后者会被脚本直接跳过（检测到已有 swap 就不动），照着提示跑一遍什么都不会变。
 */
export function describeMemoryHint(memory: HostMemoryReading | undefined): string | null {
  if (!memory) {
    return null
  }
  const { availableMb, swapFreeMb } = memory
  const swapState = resolveSwapState(memory)
  const advice = buildHostSwapAdvice(memory, 512)
  const appendAdvice = `${advice.message}${advice.command ? `执行 ${advice.command}。` : ''}`
  if (swapState === 'none') {
    return `宿主机未配置缓存区，加载峰值的可用余量较少；是否内存不足需结合退出前资源与内核日志确认。${appendAdvice}`
  }
  if (swapState === 'exhausted') {
    return `宿主机的缓存区已被用满（共 ${memory.swapTotalMb} MiB），请结合退出前资源与内核日志确认是否内存不足。${appendAdvice}`
  }
  if (availableMb !== null && availableMb + (swapFreeMb ?? 0) < 512) {
    return `宿主机内存已接近耗尽（可用约 ${availableMb} MiB，缓存区余量约 ${swapFreeMb ?? 0} MiB），可能发生内存不足。${appendAdvice}`
  }
  return null
}

/**
 * systemd 的 `Result` 值 → 用户能看懂的原因。
 *
 * 抽到独立模块是因为它同时被「状态对账」与「等待主世界就绪」两条路径使用：
 * 前者把原因写进实例的运行期警告，后者用它在主世界崩掉时给出可读的中止原因。
 */
export function describeSystemdExitReason(
  result: string | undefined,
  memoryCapMb?: number,
  memory?: HostMemoryReading,
  actualMemoryCapMb?: number | null,
): string | null {
  switch (result) {
    case 'oom-kill':
      return `内存不足被系统终止${formatMemoryCapHint(actualMemoryCapMb, memoryCapMb)}`
    case 'exit-code':
      return withMemoryHint('进程以非零状态退出', memory)
    case 'signal':
      return withMemoryHint('进程被信号终止', memory)
    case 'timeout':
      return '启动或停止超时'
    case 'watchdog':
      return '看门狗超时'
    case 'core-dump':
      return '进程崩溃并产生核心转储'
    case 'start-limit-hit':
      return '反复重启次数已达上限，运行时已停止拉起'
    default:
      // 拿不到 Result 时不编造原因：调用方会在「最近一次退出：」这类句式里直接用它
      return null
  }
}

function withMemoryHint(base: string, memory: HostMemoryReading | undefined): string {
  const hint = describeMemoryHint(memory)
  return hint ? `${base}；${hint}` : base
}

/** 全局配置的分片内存上限（MiB），未验证运行时；未设置时为 undefined */
export function resolveShardMemoryCapMb(): number | undefined {
  const limits = resolveDstContainerResourceLimits()
  return limits?.memory ? Math.round(limits.memory / (1024 * 1024)) : undefined
}
