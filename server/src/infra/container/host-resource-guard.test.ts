import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assessHostMemoryForHeavyOperation,
  parseMeminfoValueKb,
  resolveMinHostAvailableMbForOperation,
} from './host-resource-guard.ts'

/**
 * 线上服务器的真实 /proc/meminfo 片段（2026-09-16 23:45 采集，2 vCPU / 4 GiB / 无 swap）。
 * 用真实样本而不是编造的数字：开发机是 Windows、没有 /proc，
 * 「读真实内存 → 判断是否放行」这条生产路径此前一次都没被执行过。
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

describe('parseMeminfoValueKb', () => {
  it('从真实样本里取出用户机器的内存与 swap', () => {
    assert.equal(parseMeminfoValueKb(REAL_MEMINFO, 'MemTotal'), 4009448)
    assert.equal(parseMeminfoValueKb(REAL_MEMINFO, 'MemAvailable'), 3601408)
    assert.equal(parseMeminfoValueKb(REAL_MEMINFO, 'SwapFree'), 0)
  })

  it('字段缺失时返回 null，而不是把「没有 swap」误读成别的值', () => {
    assert.equal(parseMeminfoValueKb(REAL_MEMINFO, 'SwapFreeTotal'), null)
    assert.equal(parseMeminfoValueKb('', 'MemAvailable'), null)
  })

  it('不会把 SwapTotal 误当成 SwapFree', () => {
    const withSwap = 'SwapTotal:       2097148 kB\nSwapFree:        2097148 kB\n'
    assert.equal(parseMeminfoValueKb(withSwap, 'SwapFree'), 2097148)
  })
})

/**
 * 这台机器的验收判定：36 个 Mod、主世界 + 洞穴两个分片。
 * 单分片峰值 512 + 32×36 = 1664 MiB，双分片 3328，再加 384 MiB 余量 = 3712 MiB。
 */
describe('用用户机器的真实内存数字判定启动是否放行', () => {
  function withPanelEnv(run: () => void) {
    const keys = ['GSH_HOST_DST_PLANNING_MB', 'GSH_HOST_MEMORY_HEADROOM_MB', 'GSH_HOST_MIN_AVAILABLE_MB', 'GSH_DST_CONTAINER_MEMORY_MB']
    const saved = new Map<string, string | undefined>()
    for (const key of keys) {
      saved.set(key, process.env[key])
      delete process.env[key]
    }
    // 与线上 panel.env 一致
    process.env.GSH_HOST_DST_PLANNING_MB = '512'
    try {
      run()
    }
    finally {
      for (const [key, value] of saved) {
        if (value === undefined) {
          delete process.env[key]
        }
        else {
          process.env[key] = value
        }
      }
    }
  }

  const machine = { availableMb: 3517, totalMb: 3915, swapFreeMb: 0 }

  it('没有 swap 时拒绝启动，并明确指向 gsh setup-swap', () => {
    withPanelEnv(() => {
      const result = assessHostMemoryForHeavyOperation(
        'dst-container-start',
        { shardCount: 2, modCount: 36 },
        machine,
      )
      assert.equal(result.ok, false)
      if (result.ok) {
        return
      }
      assert.equal(result.requiredMb, 3712)
      assert.match(result.detail, /gsh setup-swap/)
      assert.match(result.detail, /关闭洞穴分片/)
      assert.match(result.detail, /减少订阅的 Mod/)
      // 前端靠这个字段决定通知里是「未配置 Swap，先执行 sudo gsh setup-swap」还是「已有 Swap，继续」
      assert.equal(result.data.swapFreeMb, 0)
    })
  })

  it('执行 gsh setup-swap 加上 2 GiB swap 后，同样的配置被放行', () => {
    withPanelEnv(() => {
      const result = assessHostMemoryForHeavyOperation(
        'dst-container-start',
        { shardCount: 2, modCount: 36 },
        { ...machine, swapFreeMb: 2048 },
      )
      assert.equal(result.ok, true)
    })
  })

  it('swap 存在但已被吃穿时仍然拒绝，并把当前 swap 余量透给前端', () => {
    withPanelEnv(() => {
      const result = assessHostMemoryForHeavyOperation(
        'dst-container-start',
        { shardCount: 2, modCount: 36 },
        { availableMb: 300, totalMb: 3915, swapFreeMb: 16 },
      )
      assert.equal(result.ok, false)
      if (result.ok) {
        return
      }
      // 非 0 即「有 swap」：通知里因此走「已配置 Swap，启动继续」分支，而不是又让人跑一遍命令
      assert.equal(result.data.swapFreeMb, 16)
    })
  })

  it('关掉洞穴只用单分片时，不加 swap 也放行', () => {
    withPanelEnv(() => {
      const result = assessHostMemoryForHeavyOperation(
        'dst-container-start',
        { shardCount: 1, modCount: 36 },
        machine,
      )
      // 单分片 1664 + 384 = 2048 ≤ 3517
      assert.equal(result.ok, true)
    })
  })

  it('读不到 /proc 时不拦截（Windows 原生进程模式）', () => {
    withPanelEnv(() => {
      const result = assessHostMemoryForHeavyOperation(
        'dst-container-start',
        { shardCount: 2, modCount: 36 },
        { availableMb: null, totalMb: null, swapFreeMb: null },
      )
      assert.equal(result.ok, true)
    })
  })
})

describe('resolveMinHostAvailableMbForOperation', () => {
  it('steamcmd requirement uses planning peak not docker cap', () => {
    const prevMem = process.env.GSH_STEAMCMD_CONTAINER_MEMORY_MB
    const prevHead = process.env.GSH_HOST_MEMORY_HEADROOM_MB
    const prevMin = process.env.GSH_HOST_MIN_AVAILABLE_MB
    const prevPlan = process.env.GSH_HOST_STEAMCMD_PLANNING_MB
    delete process.env.GSH_STEAMCMD_CONTAINER_MEMORY_MB
    delete process.env.GSH_HOST_MEMORY_HEADROOM_MB
    delete process.env.GSH_HOST_MIN_AVAILABLE_MB
    delete process.env.GSH_HOST_STEAMCMD_PLANNING_MB
    const required = resolveMinHostAvailableMbForOperation('steamcmd-install')
    if (prevMem !== undefined) {
      process.env.GSH_STEAMCMD_CONTAINER_MEMORY_MB = prevMem
    }
    if (prevHead !== undefined) {
      process.env.GSH_HOST_MEMORY_HEADROOM_MB = prevHead
    }
    if (prevMin !== undefined) {
      process.env.GSH_HOST_MIN_AVAILABLE_MB = prevMin
    }
    if (prevPlan !== undefined) {
      process.env.GSH_HOST_STEAMCMD_PLANNING_MB = prevPlan
    }
    assert.equal(required, 1280 + 512)
  })
})

describe('assessHostMemoryForHeavyOperation', () => {
  it('skips check when /proc/meminfo unavailable', () => {
    const result = assessHostMemoryForHeavyOperation('dst-container-start')
    if (result.availableMb === null) {
      assert.equal(result.ok, true)
    }
  })
})

/**
 * 回归：原先守卫固定按单分片 512 MiB 估算，36 个 Mod 的双分片启动被轻易放行，
 * 然后在加载途中被内核 OOM 杀掉（线上主世界 anon-rss 已达 2.0 GiB 时死亡）。
 */
describe('DST 启动守卫按分片数与 Mod 数估算', () => {
  function withCleanEnv(run: () => void) {
    const keys = [
      'GSH_HOST_DST_PLANNING_MB',
      'GSH_HOST_MEMORY_HEADROOM_MB',
      'GSH_HOST_MIN_AVAILABLE_MB',
      'GSH_DST_CONTAINER_MEMORY_MB',
      'GSH_DST_CONTAINER_CPU_QUOTA',
    ]
    const saved = new Map<string, string | undefined>()
    for (const key of keys) {
      saved.set(key, process.env[key])
      delete process.env[key]
    }
    try {
      run()
    }
    finally {
      for (const [key, value] of saved) {
        if (value === undefined) {
          delete process.env[key]
        }
        else {
          process.env[key] = value
        }
      }
    }
  }

  it('单分片无 Mod 时保持原来的下限', () => {
    withCleanEnv(() => {
      process.env.GSH_HOST_DST_PLANNING_MB = '512'
      // 显式配置只作为下界：0 个 Mod 时就是 512 + 384 余量
      assert.equal(
        resolveMinHostAvailableMbForOperation('dst-container-start', { shardCount: 1, modCount: 0 }),
        512 + 384,
      )
    })
  })

  it('36 个 Mod 的双分片按真实规模要 3712 MiB，不再被放行', () => {
    withCleanEnv(() => {
      process.env.GSH_HOST_DST_PLANNING_MB = '512'
      // 单分片峰值 512 + 32×36 = 1664；双分片 3328；再加 384 MiB 余量
      assert.equal(
        resolveMinHostAvailableMbForOperation('dst-container-start', { shardCount: 2, modCount: 36 }),
        1664 * 2 + 384,
      )
    })
  })

  it('分片内存上限会钳住单分片估算', () => {
    withCleanEnv(() => {
      process.env.GSH_DST_CONTAINER_MEMORY_MB = '1024'
      assert.equal(
        resolveMinHostAvailableMbForOperation('dst-container-start', { shardCount: 1, modCount: 36 }),
        1024 + 384,
      )
    })
  })
})
