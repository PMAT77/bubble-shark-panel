import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  collectHostResourceSnapshot,
  computeCpuUsageRate,
  getCpuUsageRate,
  resolveMemoryUsage,
  resolveSwapUsage,
} from './host-metrics'
import { parseMeminfoValueKb } from './proc-meminfo'

/**
 * 线上 4 GiB / 2 vCPU 机器的真实 /proc/meminfo 片段（2026-09-16 采集，与
 * host-resource-guard.test.ts 用的是同一份样本）。
 *
 * 关键点：MemFree 只剩 315 MiB，而 MemAvailable 还有 3.4 GiB —— 同一时刻两种口径
 * 分别得出 92% 与 10%。面板此前用 MemFree，于是把「还能再起一个分片」的机器画成
 * 内存告急，而启动守卫按 MemAvailable 放行，两边自相矛盾。
 */
const REAL_MEMINFO = `MemTotal:        4009448 kB
MemFree:          322764 kB
MemAvailable:    3601408 kB
Buffers:            9040 kB
Cached:           602984 kB
SwapCached:            0 kB
SwapTotal:             0 kB
SwapFree:              0 kB
`

const REAL_TOTAL_KB = 4009448
const REAL_AVAILABLE_KB = 3601408
const REAL_FREE_KB = 322764

describe('resolveMemoryUsage', () => {
  it('已用 = 总量 − 可用（MemAvailable），不是 − MemFree', () => {
    const reading = resolveMemoryUsage(REAL_TOTAL_KB * 1024, REAL_AVAILABLE_KB)
    assert.equal(reading.usageRate, 10.18)
    assert.equal(reading.totalGb, 3.82)
    assert.equal(reading.freeGb, 3.43)
  })

  it('同一份样本按 MemFree 口径会得出 90% 以上：这正是本次改口径要修的偏差', () => {
    const byMemFree = resolveMemoryUsage(REAL_TOTAL_KB * 1024, REAL_FREE_KB)
    assert.ok(byMemFree.usageRate > 90, `MemFree 口径应高于 90%，实际 ${byMemFree.usageRate}`)
  })

  it('可用内存恰好一半时为 50%', () => {
    const reading = resolveMemoryUsage(4 * 1024 * 1024 * 1024, 2 * 1024 * 1024)
    assert.equal(reading.usageRate, 50)
    assert.equal(reading.usedGb, 2)
    assert.equal(reading.freeGb, 2)
  })

  it('拿不到 MemAvailable（无 /proc）时回退 os.freemem()，不抛错', () => {
    const reading = resolveMemoryUsage(4 * 1024 * 1024 * 1024, null)
    assert.ok(reading.usageRate >= 0 && reading.usageRate <= 100)
    assert.ok(reading.freeGb >= 0)
  })

  it('可用内存超过总量时不会算出负数', () => {
    const reading = resolveMemoryUsage(4 * 1024 * 1024 * 1024, 8 * 1024 * 1024)
    assert.equal(reading.usageRate, 0)
    assert.equal(reading.usedGb, 0)
    assert.equal(reading.freeGb, 4)
  })
})

describe('computeCpuUsageRate', () => {
  it('首次采样没有基线时返回 null，而不是「开机以来平均值」', () => {
    assert.equal(computeCpuUsageRate(null, { total: 1000, idle: 500 }), null)
  })

  it('按两次读数的增量算使用率（全核 100%）', () => {
    const rate = computeCpuUsageRate({ total: 10_000, idle: 6_000 }, { total: 12_000, idle: 7_600 })
    assert.equal(rate, 20)
  })

  it('没有增量或 idle 回绕时返回 null，由调用方保留上一次读数', () => {
    assert.equal(computeCpuUsageRate({ total: 10_000, idle: 6_000 }, { total: 10_000, idle: 6_000 }), null)
    assert.equal(computeCpuUsageRate({ total: 10_000, idle: 6_000 }, { total: 11_000, idle: 5_000 }), null)
  })
})

describe('getCpuUsageRate', () => {
  it('最小采样窗口内的连续调用返回同一个值', () => {
    // 旧实现每次请求都推进「上一次读数」，两处界面同时刷新时会互相把窗口切成毫秒级
    const first = getCpuUsageRate()
    const second = getCpuUsageRate()
    assert.equal(first, second)
  })
})

describe('resolveSwapUsage', () => {
  const oneGiBInKb = 1024 * 1024

  it('按 SwapTotal / SwapFree 算使用率与余量', () => {
    const reading = resolveSwapUsage(2 * oneGiBInKb, oneGiBInKb)
    assert.deepEqual(reading, {
      totalGb: 2,
      usedGb: 1,
      freeGb: 1,
      usageRate: 50,
    })
  })

  it('用满时是 100%，不是「没配置」', () => {
    const reading = resolveSwapUsage(2 * oneGiBInKb, 0)
    assert.equal(reading?.usageRate, 100)
    assert.equal(reading?.freeGb, 0)
  })

  it('未配置缓存区（SwapTotal 为 0）返回 null，与「用满」区分开', () => {
    // host-resource-guard 的真实样本正是这种机器：SwapTotal 与 SwapFree 都是 0
    assert.equal(resolveSwapUsage(0, 0), null)
    assert.equal(resolveSwapUsage(parseMeminfoValueKb(REAL_MEMINFO, 'SwapTotal'), parseMeminfoValueKb(REAL_MEMINFO, 'SwapFree')), null)
  })

  it('读不到 /proc 时返回 null', () => {
    assert.equal(resolveSwapUsage(null, null), null)
    assert.equal(resolveSwapUsage(2 * oneGiBInKb, null), null)
  })

  it('SwapFree 大于 SwapTotal 时不会算出负的已用', () => {
    const reading = resolveSwapUsage(oneGiBInKb, 2 * oneGiBInKb)
    assert.equal(reading?.usedGb, 0)
    assert.equal(reading?.usageRate, 0)
    assert.equal(reading?.freeGb, 1)
  })
})

describe('collectHostResourceSnapshot', () => {
  it('returns normalized cpu/memory/disk snapshot', () => {
    const snapshot = collectHostResourceSnapshot()
    assert.ok(snapshot.cpu.cores >= 1)
    assert.ok(snapshot.cpu.usageRate >= 0 && snapshot.cpu.usageRate <= 100)
    assert.ok(snapshot.memory.totalGb > 0)
    assert.ok(snapshot.disk.totalGb >= 0)
  })

  it('内存使用率与 usedGb/totalGb 一致（同一次读取，不是两套口径）', () => {
    const snapshot = collectHostResourceSnapshot()
    const { usedGb, totalGb, usageRate } = snapshot.memory
    assert.ok(totalGb > 0)
    assert.ok(Math.abs((usedGb / totalGb) * 100 - usageRate) < 2, `used/total 与 usageRate 不一致：${usedGb}/${totalGb} vs ${usageRate}%`)
  })

  it('只解析得到 MemAvailable 时才用可用口径，字段名拼错会退化为回退路径而不是静默清零', () => {
    assert.equal(parseMeminfoValueKb(REAL_MEMINFO, 'MemAvailable'), REAL_AVAILABLE_KB)
    assert.equal(parseMeminfoValueKb(REAL_MEMINFO, 'MemAvailble'), null)
  })
})
