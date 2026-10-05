import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { describeMemoryHint, describeSystemdExitReason } from './exit-reason.ts'

/**
 * 线上最真实的故障是**整机 OOM**：内核报 `constraint=CONSTRAINT_NONE, global_oom`，
 * 而 systemd 看到的只是一次 SIGKILL、`Result` 很可能是 `signal` 而不是 `oom-kill`。
 * 于是最可能的原因拿到了最没用的提示，排查只能重新回到 SSH。
 */
describe('describeSystemdExitReason 的内存补充判断', () => {
  it('cgroup OOM 直接说明上限', () => {
    assert.equal(
      describeSystemdExitReason('oom-kill', 2048),
      '内存不足被系统终止（该分片上限 2048 MiB）',
    )
  })

  it('被信号终止且宿主机没有缓存区时，直接指出最可能的原因与做法', () => {
    const reason = describeSystemdExitReason('signal', 2048, { availableMb: 3517, swapFreeMb: 0, swapTotalMb: 0 })
    assert.ok(reason)
    assert.match(reason, /进程被信号终止/)
    assert.match(reason, /未配置缓存区/)
    assert.match(reason, /bsp setup-swap/)
  })

  it('缓存区配了但被用满时，给的是扩容做法而不是再跑一遍 setup-swap', () => {
    const reason = describeSystemdExitReason('signal', undefined, {
      availableMb: 790,
      swapFreeMb: 0,
      swapTotalMb: 2048,
    })
    assert.ok(reason)
    assert.match(reason, /进程被信号终止/)
    // 已有缓存区时 bsp setup-swap 会直接返回：提示再跑一遍只会白折腾一轮
    assert.match(reason, /缓存区已被用满（共 2048 MiB）/)
    assert.match(reason, /BSP_SWAP_SIZE=4G bsp setup-swap/)
    assert.doesNotMatch(reason, /未配置缓存区/)
  })

  it('非零退出同样带上内存判断', () => {
    const reason = describeSystemdExitReason('exit-code', undefined, {
      availableMb: 3517,
      swapFreeMb: 0,
      swapTotalMb: 0,
    })
    assert.ok(reason)
    assert.match(reason, /非零状态退出/)
    assert.match(reason, /bsp setup-swap/)
  })

  it('内存真的紧张时按当前余量提示，即使已经配了 swap', () => {
    const reason = describeSystemdExitReason('signal', undefined, { availableMb: 120, swapFreeMb: 64 })
    assert.ok(reason)
    assert.match(reason, /接近耗尽/)
    assert.match(reason, /120 MiB/)
  })

  it('内存充裕时不硬扯到 OOM', () => {
    assert.equal(
      describeSystemdExitReason('signal', undefined, { availableMb: 3000, swapFreeMb: 2048 }),
      '进程被信号终止',
    )
  })

  it('读不到内存信息时退回基础描述', () => {
    assert.equal(describeSystemdExitReason('signal'), '进程被信号终止')
  })

  it('拿不到 Result 时不编造原因，避免污染「最近一次退出：」这类句式', () => {
    assert.equal(describeSystemdExitReason(undefined, 2048, { availableMb: 100, swapFreeMb: 0, swapTotalMb: 0 }), null)
  })

  it('正常退出值与未知值都不给原因', () => {
    assert.equal(describeSystemdExitReason('success'), null)
    assert.equal(describeSystemdExitReason('whatever'), null)
  })
})

describe('describeMemoryHint', () => {
  it('没有内存快照时不给提示', () => {
    assert.equal(describeMemoryHint(undefined), null)
  })

  it('确实没有配置缓存区时才让补缓存区', () => {
    assert.match(describeMemoryHint({ availableMb: 9999, swapFreeMb: 0, swapTotalMb: 0 }) ?? '', /bsp setup-swap/)
  })

  it('swap 配了但已用满时不说「未配置」，改说扩容', () => {
    const hint = describeMemoryHint({ availableMb: 9999, swapFreeMb: 0, swapTotalMb: 2048 })
    assert.ok(hint)
    assert.match(hint, /已被用满（共 2048 MiB）/)
    assert.match(hint, /BSP_SWAP_SIZE=4G bsp setup-swap/)
    assert.doesNotMatch(hint, /未配置/)
  })

  it('读不到缓存区总量时不编造原因（无 /proc 的环境）', () => {
    assert.equal(describeMemoryHint({ availableMb: 9999, swapFreeMb: null, swapTotalMb: null }), null)
  })

  it('swap 充足且内存充裕时不提示', () => {
    assert.equal(describeMemoryHint({ availableMb: 3000, swapFreeMb: 2048, swapTotalMb: 2048 }), null)
  })
})
