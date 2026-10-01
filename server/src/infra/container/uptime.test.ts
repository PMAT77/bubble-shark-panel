import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveUptimeSecondsFromIso, resolveUptimeSecondsFromMonotonic } from './uptime.ts'

describe('resolveUptimeSecondsFromIso', () => {
  it('Docker 的纳秒时间戳按毫秒截断后计算', () => {
    // State.StartedAt 形如 …T09:15:32.123456789Z，JS 只认到毫秒
    const now = Date.parse('2026-10-02T09:20:00.000Z')
    assert.equal(resolveUptimeSecondsFromIso('2026-10-02T09:15:32.123456789Z', now), 267)
  })

  it('读不到或解析不出时返回 undefined，由调用方退回旧口径', () => {
    assert.equal(resolveUptimeSecondsFromIso(undefined), undefined)
    assert.equal(resolveUptimeSecondsFromIso(''), undefined)
    assert.equal(resolveUptimeSecondsFromIso('not-a-time'), undefined)
  })

  it('时间戳落在未来时不返回负数', () => {
    const now = Date.parse('2026-10-02T09:00:00.000Z')
    assert.equal(resolveUptimeSecondsFromIso('2026-10-02T09:15:00.000Z', now), 0)
  })
})

describe('resolveUptimeSecondsFromMonotonic', () => {
  it('systemd 的 monotonic 启动时刻与系统 uptime 相减', () => {
    // ExecMainStartTimestampMonotonic 是自开机以来的微秒：1500 秒前启动，系统已开机 2000 秒
    assert.equal(resolveUptimeSecondsFromMonotonic('1500000000', 2000), 500)
  })

  it('单元从未启动过（monotonic 为 0）时算不出运行时长', () => {
    assert.equal(resolveUptimeSecondsFromMonotonic('0', 2000), undefined)
    assert.equal(resolveUptimeSecondsFromMonotonic(undefined, 2000), undefined)
  })

  it('启动时刻晚于当前 uptime 时不返回负数', () => {
    assert.equal(resolveUptimeSecondsFromMonotonic('3000000000', 2000), undefined)
  })
})
