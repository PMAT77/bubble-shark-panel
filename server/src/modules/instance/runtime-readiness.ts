/**
 * 实例「是不是真的起来了」。
 *
 * 面板原先只有一个判据——运行时单元在跑——于是进程起来后在加载 Mod 与世界的那几分钟里，
 * 界面显示的是「运行中」，服主据此以为房间已经能被搜到；而实际上服务器还没走到
 * 「向大厅注册」那一步。线上就是这么被误导的：卡片写着运行中，游戏里搜不到房间。
 *
 * 就绪判据用 DST 自己写进分片日志的标记（见 `container-lifecycle.ts` 的
 * `hasMasterReadyMarker`），它不依赖面板是否采集到 stdout，容器与原生两种模式都成立。
 * 本模块只做「拿到就绪事实之后怎么描述」，读日志放在调用方，便于用纯函数固化口径。
 */

export type InstanceRuntimeReadinessState = 'ready' | 'loading' | 'stalled' | 'not_running'

export interface InstanceRuntimeReadiness {
  state: InstanceRuntimeReadinessState
  /** 已加载秒数；非运行态或启动时刻读不到时为 null */
  loadingSeconds: number | null
}

export interface RuntimeReadinessInput {
  status: string
  /** 本轮启动写入的就绪时刻（ISO）；尚未就绪为 null */
  runtimeReadyAt: string | null
  /** 面板记录的启动时刻（ISO） */
  runtimeStartedAt: string | null
  /** 超过这个秒数还没就绪就不再算「加载慢」，判 stalled（默认取等主世界就绪的上限） */
  notReadyAfterSec: number
  now?: number
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * 实例运行态的三分：已就绪 / 正在加载 / 迟迟未就绪。
 *
 * `stalled` 用与「等主世界就绪再拉洞穴」同一个上限（默认 900 秒）：超过它仍没有就绪标记，
 * 说明不是"慢"而是"卡住了"，此时继续显示「运行中」就是在骗人。
 * 就绪时刻一旦写入就不再回退（下次启动时由调用方清空），因此这里只看有没有值。
 */
export function resolveRuntimeReadiness(input: RuntimeReadinessInput): InstanceRuntimeReadiness {
  if (input.status !== 'running') {
    return { state: 'not_running', loadingSeconds: null }
  }
  if (parseTimestamp(input.runtimeReadyAt) !== null) {
    return { state: 'ready', loadingSeconds: null }
  }
  const startedMs = parseTimestamp(input.runtimeStartedAt)
  if (startedMs === null) {
    // 启动时刻读不到：不能拿 0 当"刚启动"，也不能凭空说卡住
    return { state: 'loading', loadingSeconds: null }
  }
  const loadingSeconds = Math.max(0, Math.floor(((input.now ?? Date.now()) - startedMs) / 1000))
  return {
    state: loadingSeconds >= input.notReadyAfterSec ? 'stalled' : 'loading',
    loadingSeconds,
  }
}
