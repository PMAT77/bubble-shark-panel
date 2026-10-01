/**
 * 实例运行期警告的措辞与清除口径。
 *
 * 抽成纯函数是因为这两件事都容易被写成一件事：
 *   1. systemd 的 `NRestarts` 是**累计值**，只要崩过一次就永远大于 0（只有面板主动启动时的
 *      `reset-failed` 才会归零）。所以「计数大于 0」既可能是正在崩溃循环，也可能是启动阶段
 *      崩过一次、之后已经连续跑了几十分钟——线上表现就是实例早已恢复正常，界面上却一直挂着
 *      「反复重启」，服主据此去减 Mod、关洞穴，白折腾一轮。
 *   2. 清除旧警告原先要求 `NRestarts` 为 0，而它永不为 0，条件事实上永远不成立。
 *
 * 判据改为「当前进程连续运行了多久」（`ContainerInspect.uptimeSeconds`，两条运行时都会填）。
 * 特别注意不能用面板记录的 `runtimeStartedAt` 代替：它是面板点启动的时刻，进程被自动拉起后
 * 不会跟着更新——正是它让「16 分 55 秒 + 已重启 1 次」看起来像一切正常。
 */

/** 短于这个时长仍按崩溃循环看待：DST 多 Mod 冷启动本身就要两分多钟，还没站稳就不算恢复 */
const RESTART_LOOP_HEALTHY_AFTER_SEC = 10 * 60
/** 连续干净运行超过这个时长，旧的运行期警告可以清掉 */
const RUNTIME_WARNING_CLEAR_AFTER_SEC = 30 * 60

export interface RestartLoopWarningInput {
  /** systemd 的累计重启次数 */
  restarts: number
  /** 运行时正在自动拉起（systemd 的 auto-restart 窗口）：此刻确实还在崩 */
  restarting: boolean
  /** 当前进程已连续运行的秒数；undefined = 运行时给不出 */
  uptimeSeconds?: number
  /** 运行时报得出的上一次退出原因；说不出来时为 null */
  exitReason?: string | null
}

/**
 * 运行期警告文案；不需要写警告时返回 null。
 *
 * 两种状态分开说，因为它们要做的事不同：仍在崩要去看日志、减 Mod、关洞穴；
 * 只是启动阶段崩过一次则什么都不用做，此时提「减少订阅的 Mod」是误导。
 */
export function buildRestartLoopWarning(input: RestartLoopWarningInput): string | null {
  const { restarts, restarting, uptimeSeconds } = input
  if (restarts <= 0) {
    return null
  }
  const reason = input.exitReason?.trim()
  // 读不到运行时长时按「仍在崩」说：宁可多提示一次，也不把崩溃循环说成已恢复
  if (restarting || uptimeSeconds === undefined || uptimeSeconds < RESTART_LOOP_HEALTHY_AFTER_SEC) {
    return `实例进程反复重启（已重启 ${restarts} 次）${reason ? `，最近一次退出：${reason}` : ''}。`
      + '请打开控制台查看分片日志确认原因；'
      + '内存不足时可在「世界设置 → 模组」减少订阅的 Mod，或关闭洞穴分片。'
  }
  // 文案里不带分钟数：它一变就会绕过「文案没变就不重复写库」的优化，对账跑在每个列表请求上，
  // 于是每分钟写一次库。具体跑了多久由实例卡片的「运行时长」给出，那里本来就是进程口径。
  return `实例在启动阶段崩溃过 ${restarts} 次${reason ? `（最近一次退出：${reason}）` : ''}，`
    + '当前进程已恢复运行。若大厅仍搜不到房间，请打开控制台查看分片日志确认原因。'
}

/** 旧警告可以清掉了：当前进程已经连续干净运行足够久 */
export function shouldClearRuntimeWarning(uptimeSeconds: number | undefined): boolean {
  return uptimeSeconds !== undefined && uptimeSeconds >= RUNTIME_WARNING_CLEAR_AFTER_SEC
}
