/**
 * 「当前进程已经连续运行了多久」的两个换算。
 *
 * 面板原先只有「面板自己记下的启动时刻」，重启后它不会跟着更新：于是卡片上的运行时长
 * 可能是 16 分钟，而进程实际只跑了 13 分钟——「刚崩过一次」这个事实被读数盖住了。
 *
 * 两条运行时的可靠来源不同，且都不能靠人读的时间戳硬解：
 *   - Native：systemd `ExecMainStartTimestamp` 是 `Thu 2026-10-02 09:15:32 CST` 这种本地格式，
 *     时区缩写（CST）有歧义，按它算会整体偏掉；改用同一次 `systemctl show` 给出的
 *     `ExecMainStartTimestampMonotonic`（自开机以来的微秒）与系统 uptime 相减。
 *   - Docker：`State.StartedAt` 是 RFC3339 纳秒（`…T09:15:32.123456789Z`），JS 只认到毫秒，
 *     先截断再解析。
 */

/** 截断到毫秒：`…:32.123456789Z` → `…:32.123Z` */
function truncateFractionalSeconds(value: string): string {
  return value.replace(/(\.\d{3})\d+/, '$1')
}

/** 由 ISO 时间戳算运行秒数（Docker 的 `State.StartedAt`）；解析不出来时返回 undefined */
export function resolveUptimeSecondsFromIso(
  startedAt: string | undefined,
  now = Date.now(),
): number | undefined {
  if (!startedAt) {
    return undefined
  }
  const startedMs = Date.parse(truncateFractionalSeconds(startedAt))
  if (!Number.isFinite(startedMs)) {
    return undefined
  }
  return Math.max(0, Math.floor((now - startedMs) / 1000))
}

/**
 * 由 systemd 的 monotonic 启动时刻算运行秒数。
 *
 * `ExecMainStartTimestampMonotonic` 与 `os.uptime()` 是同一个时钟的两端，相减不涉及时区，
 * 也天然不受系统时间被改动的影响。
 */
export function resolveUptimeSecondsFromMonotonic(
  startedMonotonicUsec: string | number | undefined,
  systemUptimeSeconds: number,
): number | undefined {
  const startedUsec = typeof startedMonotonicUsec === 'number'
    ? startedMonotonicUsec
    : Number(startedMonotonicUsec ?? Number.NaN)
  // systemd 在单元从未启动过时给 0：那是「没有这个信息」，不是「刚启动」
  if (!Number.isFinite(startedUsec) || startedUsec <= 0) {
    return undefined
  }
  const elapsed = systemUptimeSeconds - startedUsec / 1_000_000
  return elapsed >= 0 ? Math.floor(elapsed) : undefined
}
