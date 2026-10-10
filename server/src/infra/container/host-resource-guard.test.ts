import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assessHostMemoryForHeavyOperation,
  buildHostSwapAdvice,
  buildStartupSwapAdvice,
  parseMeminfoValueKb,
  resolveMinHostAvailableMbForOperation,
  resolveSwapState,
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

describe('swap advice follows the available budget', () => {
  it('only warns on confirmed shortage and sizes commands for no, low and exhausted swap', () => {
    const reading = { availableMb: 512, swapFreeMb: 0, swapTotalMb: 0 }
    assert.equal(buildStartupSwapAdvice(reading, 512), undefined)
    assert.equal(buildStartupSwapAdvice({ ...reading, swapTotalMb: 2048 }, 512), undefined)
    assert.equal(buildStartupSwapAdvice({ ...reading, availableMb: null }, 4096), undefined)
    assert.equal(buildStartupSwapAdvice({ ...reading, swapFreeMb: null }, 4096), undefined)
    assert.equal(buildStartupSwapAdvice({ ...reading, swapTotalMb: null }, 4096), undefined)
    assert.equal(buildStartupSwapAdvice(reading, 0), undefined)
    const none = buildStartupSwapAdvice(reading, 4096)
    assert.equal(none?.state, 'none')
    assert.equal(none?.command, 'sudo env BSP_SWAP_SIZE=4G bsp setup-swap')
    assert.match(none?.message ?? '', /未配置 swap.*创建 4 GiB/)
    const low = buildStartupSwapAdvice({ ...reading, swapFreeMb: 1024, swapTotalMb: 2048 }, 4096)
    assert.equal(low?.state, 'low')
    assert.match(low?.command ?? '', /extra-3g BSP_SWAP_SIZE=3G/)
    const exhausted = buildStartupSwapAdvice({ ...reading, swapTotalMb: 2048 }, 600)
    assert.equal(exhausted?.state, 'exhausted')
    assert.match(exhausted?.command ?? '', /extra-2g BSP_SWAP_SIZE=2G/)
  })
  it('distinguishes no swap, exhausted, insufficient, sufficient and unknown readings', () => {
    assert.equal(resolveSwapState({ swapFreeMb: 0, swapTotalMb: 0 }), 'none')
    assert.equal(resolveSwapState({ swapFreeMb: 0, swapTotalMb: 2048 }), 'exhausted')
    assert.equal(resolveSwapState({ availableMb: 500, swapFreeMb: 100, swapTotalMb: 2048 }, 2048), 'low')
    assert.equal(resolveSwapState({ availableMb: 500, swapFreeMb: 1548, swapTotalMb: 2048 }, 2048), 'ready')
    assert.equal(resolveSwapState({ availableMb: 500, swapFreeMb: null, swapTotalMb: 2048 }, 2048), 'unknown')
    assert.equal(resolveSwapState({ swapFreeMb: null, swapTotalMb: null }), 'unknown')
  })

  it('sizes a new file from the shortfall without disabling existing swap', () => {
    const exhausted = buildHostSwapAdvice({ availableMb: 900, swapFreeMb: 0, swapTotalMb: 2048 }, 3800)
    assert.equal(exhausted.state, 'exhausted')
    assert.match(exhausted.command ?? '', /BSP_SWAP_FILE=\/swapfile-bsp-extra-3g BSP_SWAP_SIZE=3G bsp setup-swap/)
    assert.match(exhausted.message, /追加 3 GiB/)
    assert.doesNotMatch(exhausted.message, /停用.*删|swapoff/)
    const low = buildHostSwapAdvice({ availableMb: 900, swapFreeMb: 1024, swapTotalMb: 2048 }, 3800)
    assert.equal(low.state, 'low')
    assert.match(low.command ?? '', /BSP_SWAP_FILE=\/swapfile-bsp-extra-2g BSP_SWAP_SIZE=2G/)
    const none = buildHostSwapAdvice({ availableMb: 900, swapFreeMb: 0, swapTotalMb: 0 }, 3800)
    assert.match(none.command ?? '', /sudo env BSP_SWAP_SIZE=3G bsp setup-swap/)
    const ready = buildHostSwapAdvice({ availableMb: 900, swapFreeMb: 3000, swapTotalMb: 4096 }, 3800)
    assert.equal(ready.command, null)
  })
})

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
    const keys = ['BSP_HOST_DST_PLANNING_MB', 'BSP_HOST_MEMORY_HEADROOM_MB', 'BSP_HOST_MIN_AVAILABLE_MB', 'BSP_DST_CONTAINER_MEMORY_MB']
    const saved = new Map<string, string | undefined>()
    for (const key of keys) {
      saved.set(key, process.env[key])
      delete process.env[key]
    }
    // 与线上 panel.env 一致
    process.env.BSP_HOST_DST_PLANNING_MB = '512'
    process.env.BSP_HOST_MEMORY_HEADROOM_MB = '384'
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

  const machine = { availableMb: 3517, totalMb: 3915, swapFreeMb: 0, swapTotalMb: 0 }

  it('没有 swap 时拒绝启动，并明确指向 bsp setup-swap', () => {
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
      assert.match(result.detail, /bsp setup-swap/)
      assert.match(result.detail, /关闭洞穴分片/)
      assert.match(result.detail, /减少订阅的 Mod/)
      // 前端靠 swapTotalMb 判定「系统有没有 swap」：总量为 0 才是「未配置」
      assert.equal(result.data.swapTotalMb, 0)
      assert.equal(result.data.swapFreeMb, 0)
    })
  })

  it('swap 配了但被用满时，给的是扩容做法而不是再跑一遍 setup-swap', () => {
    withPanelEnv(() => {
      const result = assessHostMemoryForHeavyOperation(
        'dst-container-start',
        { shardCount: 2, modCount: 36 },
        { availableMb: 790, totalMb: 3915, swapFreeMb: 0, swapTotalMb: 2048 },
      )
      assert.equal(result.ok, false)
      if (result.ok) {
        return
      }
      // 总量非 0 说明 swap 是配过的：此时 bsp setup-swap 会直接返回、什么都不做
      assert.equal(result.data.swapTotalMb, 2048)
      assert.equal(result.data.swapFreeMb, 0)
      assert.match(result.detail, /缓存区已用满（共 2048 MiB）/)
      assert.match(result.detail, /扩缓存区/)
      assert.match(result.detail, /BSP_SWAP_FILE=\/swapfile-bsp-extra-3g BSP_SWAP_SIZE=3G bsp setup-swap/)
      assert.doesNotMatch(result.detail, /停用.*删|swapoff|rm /)
      assert.doesNotMatch(result.detail, /创建 2 GiB swapfile/)
    })
  })

  it('执行 bsp setup-swap 加上 2 GiB swap 后，同样的配置被放行', () => {
    withPanelEnv(() => {
      const result = assessHostMemoryForHeavyOperation(
        'dst-container-start',
        { shardCount: 2, modCount: 36 },
        { ...machine, swapFreeMb: 2048, swapTotalMb: 2048 },
      )
      assert.equal(result.ok, true)
    })
  })

  it('swap 存在但已被吃穿时仍然拒绝，并把当前 swap 余量透给前端', () => {
    withPanelEnv(() => {
      const result = assessHostMemoryForHeavyOperation(
        'dst-container-start',
        { shardCount: 2, modCount: 36 },
        { availableMb: 300, totalMb: 3915, swapFreeMb: 16, swapTotalMb: 2048 },
      )
      assert.equal(result.ok, false)
      if (result.ok) {
        return
      }
      // 还有 swap 也可能不足预算，应给追加新文件的命令。
      assert.equal(result.data.swapFreeMb, 16)
      assert.match(result.detail, /余量不足本次启动预算/)
      assert.match(result.detail, /BSP_SWAP_FILE=\/swapfile-bsp-extra-4g BSP_SWAP_SIZE=4G/)
      assert.doesNotMatch(result.detail, /近似线性|峰值约为双分片的一半/)
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
    const prevMem = process.env.BSP_STEAMCMD_CONTAINER_MEMORY_MB
    const prevHead = process.env.BSP_HOST_MEMORY_HEADROOM_MB
    const prevMin = process.env.BSP_HOST_MIN_AVAILABLE_MB
    const prevPlan = process.env.BSP_HOST_STEAMCMD_PLANNING_MB
    delete process.env.BSP_STEAMCMD_CONTAINER_MEMORY_MB
    delete process.env.BSP_HOST_MEMORY_HEADROOM_MB
    delete process.env.BSP_HOST_MIN_AVAILABLE_MB
    delete process.env.BSP_HOST_STEAMCMD_PLANNING_MB
    const required = resolveMinHostAvailableMbForOperation('steamcmd-install')
    if (prevMem !== undefined) {
      process.env.BSP_STEAMCMD_CONTAINER_MEMORY_MB = prevMem
    }
    if (prevHead !== undefined) {
      process.env.BSP_HOST_MEMORY_HEADROOM_MB = prevHead
    }
    if (prevMin !== undefined) {
      process.env.BSP_HOST_MIN_AVAILABLE_MB = prevMin
    }
    if (prevPlan !== undefined) {
      process.env.BSP_HOST_STEAMCMD_PLANNING_MB = prevPlan
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
      'BSP_HOST_DST_PLANNING_MB',
      'BSP_HOST_MEMORY_HEADROOM_MB',
      'BSP_HOST_MIN_AVAILABLE_MB',
      'BSP_DST_CONTAINER_MEMORY_MB',
      'BSP_DST_CONTAINER_CPU_QUOTA',
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
      process.env.BSP_HOST_DST_PLANNING_MB = '512'
      // 显式配置只作为下界：0 个 Mod 时就是 512 + 默认 512 余量
      assert.equal(
        resolveMinHostAvailableMbForOperation('dst-container-start', { shardCount: 1, modCount: 0 }),
        512 + 512,
      )
    })
  })

  it('36 个 Mod 的双分片按真实规模加宿主机余量，不再被放行', () => {
    withCleanEnv(() => {
      process.env.BSP_HOST_DST_PLANNING_MB = '512'
      // 单分片峰值 512 + 32×36 = 1664；双分片 3328；再加 512 MiB 余量
      assert.equal(
        resolveMinHostAvailableMbForOperation('dst-container-start', { shardCount: 2, modCount: 36 }),
        1664 * 2 + 512,
      )
    })
  })

  it('低硬限不能压低真实需求估算', () => {
    withCleanEnv(() => {
      process.env.BSP_DST_CONTAINER_MEMORY_MB = '1024'
      assert.equal(
        resolveMinHostAvailableMbForOperation('dst-container-start', { shardCount: 1, modCount: 36 }),
        1664 + 512,
      )
    })
  })

  it('显式关闭守卫生效，洞穴只计算新增单片并使用实际DST硬限', () => {
    withCleanEnv(() => {
      process.env.BSP_HOST_MIN_AVAILABLE_MB = '0'
      assert.deepEqual(assessHostMemoryForHeavyOperation('dst-container-start', { shardCount: 2, modCount: 40 }, { availableMb: 0, swapFreeMb: 0 }), { ok: true, availableMb: 0, requiredMb: 0 })
      delete process.env.BSP_HOST_MIN_AVAILABLE_MB
      process.env.BSP_HOST_MEMORY_HEADROOM_MB = '1024'
      assert.equal(resolveMinHostAvailableMbForOperation('dst-container-start', { shardCount: 1, modCount: 40 }), 1792 + 1024)
      const failed = assessHostMemoryForHeavyOperation('dst-container-start', { shardCount: 1, modCount: 40, memoryCapMb: 3072 }, { availableMb: 0, swapFreeMb: 0 })
      assert.equal(failed.ok, false)
      if (!failed.ok) {
        assert.equal(failed.data.capMb, 3072)
        assert.match(failed.detail, /当前启动分片的内存硬上限为 3072 MiB/)
      }
    })
  })
})
