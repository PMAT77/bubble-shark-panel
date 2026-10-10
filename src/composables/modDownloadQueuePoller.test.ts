import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ModDownloadQueueDto } from '../api/modules/mod'
import {
  createModDownloadQueuePoller,
  MOD_DOWNLOAD_QUEUE_POLL_INTERVAL_MS,
  shouldPollModDownloadQueue,
  resolvePendingWorkshopIds,
} from './modDownloadQueuePoller.ts'

function createQueueDto(overrides: Partial<ModDownloadQueueDto> = {}): ModDownloadQueueDto {
  return {
    instanceId: 'inst-1',
    status: 'running',
    phase: 'downloading',
    items: [],
    eligibleCount: 30,
    inactiveMissingCount: 0,
    retryableFailedCount: 0,
    total: 30,
    queued: 25,
    downloading: 5,
    success: 0,
    failed: 0,
    currentWorkshopIds: ['1', '2', '3', '4', '5'],
    queueWorkshopIds: Array.from({ length: 25 }, (_value, index) => String(index + 6)),
    batchSize: 5,
    currentBatchIndex: 1,
    nextBatchAt: null,
    startedAt: null,
    updatedAt: null,
    lastError: null,
    warnings: [],
    ...overrides,
  }
}

it('only locks active queue items and submitting requests, leaving idle/paused candidates actionable', () => {
  for (const status of ['idle', 'paused'] as const) {
    assert.deepEqual([...resolvePendingWorkshopIds(createQueueDto({ status }), ['submitting'])], ['submitting'])
  }
  for (const status of ['running', 'pausing'] as const) {
    assert.deepEqual([...resolvePendingWorkshopIds(createQueueDto({ status, currentWorkshopIds: ['1'], queueWorkshopIds: ['2'] }), ['1'])], ['1', '2'])
  }
  assert.deepEqual([...resolvePendingWorkshopIds(null)], [])
})

/** 冲刷 async 链，让轮询器的 await 走完 */
function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

interface FakeTimers {
  setTimer: (handler: () => void, timeoutMs: number) => unknown
  clearTimer: (handle: unknown) => void
  scheduled: Array<{ handler: () => void, timeoutMs: number }>
  runNext: () => Promise<void>
  pendingCount: () => number
}

function createFakeTimers(): FakeTimers {
  const scheduled: Array<{ handler: () => void, timeoutMs: number }> = []
  return {
    scheduled,
    setTimer: (handler, timeoutMs) => {
      const entry = { handler, timeoutMs }
      scheduled.push(entry)
      return entry
    },
    clearTimer: (handle) => {
      const index = scheduled.indexOf(handle as { handler: () => void, timeoutMs: number })
      if (index >= 0) {
        scheduled.splice(index, 1)
      }
    },
    runNext: async () => {
      const entry = scheduled.shift()
      entry?.handler()
      await flush()
    },
    pendingCount: () => scheduled.length,
  }
}

describe('modDownloadQueuePoller', () => {
  it('使用动态间隔，在空闲观察时降低频率', async () => {
    const timers = createFakeTimers()
    let active = false
    const poller = createModDownloadQueuePoller({ fetchQueue: async () => createQueueDto(), onUpdate: () => {},
      getIntervalMs: () => active ? 3000 : 15000, setTimer: timers.setTimer, clearTimer: timers.clearTimer })
    poller.start()
    await flush()
    assert.equal(timers.scheduled[0]?.timeoutMs, 15000)
    active = true
    await timers.runNext()
    assert.equal(timers.scheduled[0]?.timeoutMs, 3000)
    poller.stop()
  })
  it('停止或重启后丢弃旧请求的结果', async () => {
    const timers = createFakeTimers()
    let resolve!: (queue: ModDownloadQueueDto) => void
    const updates: ModDownloadQueueDto[] = []
    const poller = createModDownloadQueuePoller({ fetchQueue: () => new Promise(done => resolve = done),
      onUpdate: queue => updates.push(queue), setTimer: timers.setTimer, clearTimer: timers.clearTimer })
    poller.start()
    poller.stop()
    poller.start()
    resolve(createQueueDto())
    await flush()
    assert.equal(updates.length, 0)
    assert.equal(timers.pendingCount(), 1)
    poller.stop()
  })
  it('整个页面只有一个轮询器，按队列接口取状态而不是每个 Mod 一次', async () => {
    const timers = createFakeTimers()
    let fetchCount = 0
    const updates: ModDownloadQueueDto[] = []
    const poller = createModDownloadQueuePoller({
      fetchQueue: async () => {
        fetchCount += 1
        // 30 个 pending Mod 也只对应一次请求
        return createQueueDto()
      },
      onUpdate: queue => updates.push(queue),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })

    poller.start()
    await flush()

    assert.equal(fetchCount, 1)
    assert.equal(updates.length, 1)
    assert.equal(updates[0]?.total, 30)
    assert.equal(timers.pendingCount(), 1, '只应存在一个定时器')
    assert.equal(timers.scheduled[0]?.timeoutMs, MOD_DOWNLOAD_QUEUE_POLL_INTERVAL_MS)

    // 第二次 tick 之后仍然只有一个定时器
    await timers.runNext()
    assert.equal(fetchCount, 2)
    assert.equal(timers.pendingCount(), 1)

    poller.stop()
    assert.equal(timers.pendingCount(), 0)
  })

  it('重复 start 不会产生第二个轮询器', async () => {
    const timers = createFakeTimers()
    let fetchCount = 0
    const poller = createModDownloadQueuePoller({
      fetchQueue: async () => {
        fetchCount += 1
        return createQueueDto()
      },
      onUpdate: () => {},
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })

    poller.start()
    poller.start()
    poller.start()
    await flush()

    assert.equal(fetchCount, 1)
    assert.equal(timers.pendingCount(), 1)
    poller.stop()
  })

  it('页面不可见时不发请求', async () => {
    const timers = createFakeTimers()
    let visible = false
    let fetchCount = 0
    const poller = createModDownloadQueuePoller({
      fetchQueue: async () => {
        fetchCount += 1
        return createQueueDto()
      },
      onUpdate: () => {},
      isVisible: () => visible,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })

    poller.start()
    await flush()
    assert.equal(fetchCount, 0)

    await timers.runNext()
    assert.equal(fetchCount, 0, '后台标签页不应产生请求')

    visible = true
    await timers.runNext()
    assert.equal(fetchCount, 1)
    poller.stop()
  })

  it('请求失败只上报错误，轮询继续', async () => {
    const timers = createFakeTimers()
    const errors: unknown[] = []
    let fetchCount = 0
    const poller = createModDownloadQueuePoller({
      fetchQueue: async () => {
        fetchCount += 1
        if (fetchCount === 1) {
          throw new Error('network down')
        }
        return createQueueDto()
      },
      onUpdate: () => {},
      onError: error => errors.push(error),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })

    poller.start()
    await flush()
    assert.equal(errors.length, 1)
    assert.equal(timers.pendingCount(), 1)

    await timers.runNext()
    assert.equal(fetchCount, 2)
    poller.stop()
  })

  it('stop 之后不再请求', async () => {
    const timers = createFakeTimers()
    let fetchCount = 0
    const poller = createModDownloadQueuePoller({
      fetchQueue: async () => {
        fetchCount += 1
        return createQueueDto()
      },
      onUpdate: () => {},
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })

    poller.start()
    await flush()
    assert.equal(fetchCount, 1)

    poller.stop()
    assert.equal(poller.isRunning(), false)
    await timers.runNext()
    assert.equal(fetchCount, 1)
  })
})

describe('shouldPollModDownloadQueue', () => {
  it('队列在跑时轮询', () => {
    assert.equal(shouldPollModDownloadQueue({ status: 'running', pendingCount: 0 }), true)
    assert.equal(shouldPollModDownloadQueue({ status: 'pausing', pendingCount: 0 }), true)
  })

  it('队列空闲且没有待下载项时停止轮询（不再挂着一个常驻请求）', () => {
    assert.equal(shouldPollModDownloadQueue({ status: 'idle', pendingCount: 0 }), false)
    assert.equal(shouldPollModDownloadQueue({ status: null, pendingCount: 0 }), false)
  })

  it('还有待下载项时继续轮询，好跟上别处点的「开始下载」', () => {
    assert.equal(shouldPollModDownloadQueue({ status: 'idle', pendingCount: 3 }), true)
    assert.equal(shouldPollModDownloadQueue({ status: 'paused', pendingCount: 3 }), true)
  })
})
