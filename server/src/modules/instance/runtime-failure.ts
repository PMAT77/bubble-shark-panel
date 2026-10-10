import type { DbInstanceRuntimeFailureKind } from '../../shared/db/types'
import { formatMemoryCapHint } from '../../infra/container/exit-reason'

/**
 * 「实例没起来」到底是不是内存问题。
 *
 * 面板读不到内核日志（`dmesg` 要 root），所以判据分三档，从确凿到推断：
 *   1. cgroup 的 `oom_kill` 计数（Native 模式可读，且进程被自动拉起后仍然保留）——最确凿；
 *   2. systemd 的 `Result=oom-kill`（重启成功后会被重置成 success，所以只能当补充证据）；
 *   3. 反复重启 + 从未就绪 + 宿主机可用缓冲见底——推断，但足以支持"先加缓存区试试"。
 *
 * 归因直接决定界面给不给「增加缓存区」的引导：把 Mod 报错误判成内存问题，会让人白折腾一轮
 * 缓存区；反过来把内存问题说成 Mod 问题，则什么都不会改善。所以证据不足时宁可只说
 * 「尚未就绪，去看日志」。
 */

/** 可用缓冲低于这个数（MiB）时，"反复重启"基本只有内存一种解释 */
const SUSPICIOUS_BUFFER_MB = 1024

export interface RuntimeFailureInput {
  /** 本轮启动是否出现过世界就绪标记 */
  readySeen: boolean
  /** systemd 的累计重启次数 */
  restarts: number
  /** 运行时正在自动拉起（auto-restart 窗口） */
  restarting?: boolean
  /** systemd 的 `Result`；重启成功后会被重置，因此可能为空 */
  exitResult?: string
  /** cgroup `memory.events` 的 oom_kill 计数；读不到为 undefined */
  memOomKillCount?: number
  /** 该单元的内存峰值（MiB）；读不到为 undefined */
  memPeakMb?: number
  /** 分片的配置上限（MiB），不能当作已验证的运行时上限 */
  shardCapMb?: number
  /** 本次故障检查读到的实际有限硬限；不可读或不限时为 null / undefined */
  actualShardCapMb?: number | null
  /** 宿主机可用缓冲（可用内存 + swap 余量，MiB）；读不到为 null */
  bufferMb: number | null
  /** 已加载秒数；读不到为 null */
  loadingSeconds: number | null
  /** 超过它仍没就绪就算卡住（与等主世界就绪的上限同一个值） */
  notReadyAfterSec: number
}

export interface RuntimeFailure {
  kind: DbInstanceRuntimeFailureKind
  /** 一句话结论，直接进实例的运行期告警 */
  detail: string
}

/**
 * 归因结论；没有结论时返回 null（此时由「重启告警」那套措辞负责说明，两者不重复写）。
 *
 * **已经就绪就不给归因**：实例最终起来了，就不该在界面上留一个"当初没起来"的引导，
 * 那会让人以为现在还坏着。
 */
export function classifyRuntimeFailure(input: RuntimeFailureInput): RuntimeFailure | null {
  if (input.readySeen) {
    return null
  }
  const capHint = formatMemoryCapHint(input.actualShardCapMb, input.shardCapMb)
  const peakHint = input.memPeakMb ? `，实际峰值约 ${input.memPeakMb} MiB` : ''

  if (typeof input.memOomKillCount === 'number' && input.memOomKillCount > 0) {
    return {
      kind: 'memory',
      detail: `该分片因内存不足终止过 ${input.memOomKillCount} 次${capHint}${peakHint}`,
    }
  }
  if (input.exitResult === 'oom-kill') {
    return { kind: 'memory', detail: `内存不足被系统终止${capHint}` }
  }
  if (input.restarts > 0 && input.bufferMb !== null && input.bufferMb < SUSPICIOUS_BUFFER_MB) {
    return {
      kind: 'memory',
      detail: `加载途中反复重启（已重启 ${input.restarts} 次），宿主机可用缓冲仅 ${input.bufferMb} MiB，疑为内存不足`,
    }
  }
  if (input.restarts > 0) {
    return { kind: 'not_ready', detail: `世界在加载途中退出过 ${input.restarts} 次，尚未就绪` }
  }
  if (input.loadingSeconds !== null && input.loadingSeconds >= input.notReadyAfterSec) {
    return {
      kind: 'not_ready',
      detail: `已加载 ${Math.floor(input.loadingSeconds / 60)} 分钟仍未就绪`,
    }
  }
  return null
}

/** 归因结论 → 实例上展示的告警文案 */
export function buildRuntimeFailureWarning(failure: RuntimeFailure): string {
  if (failure.kind === 'memory') {
    return `${failure.detail}。请先停止实例，再按提示增加缓存区；`
      + '也可以在「世界设置 → 模组」减少订阅的 Mod，或关闭洞穴分片来降低峰值。'
  }
  return `${failure.detail}。请打开控制台查看分片日志确认原因（常见是某个 Mod 报错）。`
}
