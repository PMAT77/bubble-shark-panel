import type { ModDownloadQueueDto, ModDownloadQueueStatus } from '../api/modules/mod'

/**
 * Mod 下载队列轮询器。
 *
 * 下载状态只有一个来源——实例级队列接口。此前每个 Mod 各起一个 2 秒轮询，
 * 30 个 pending 就是每秒十几个请求；现在整页只有一个轮询器，默认 3 秒一次。
 *
 * 这里刻意只做「调度」：取数据、报错、定时由外部注入，便于在单测里断言
 * 「只有一个定时器」「页面隐藏时不发请求」这类行为。
 */
export const MOD_DOWNLOAD_QUEUE_POLL_INTERVAL_MS = 3000

/** 空闲/暂停时的候选只是待下载，不能锁住单项操作。 */
export function resolvePendingWorkshopIds(queue: ModDownloadQueueDto | null, submitting: Iterable<string> = []): Set<string> {
  const running = queue?.status === 'running' || queue?.status === 'pausing'
  return new Set([...submitting, ...(running ? [...queue.currentWorkshopIds, ...queue.queueWorkshopIds] : [])])
}

/**
 * 是否需要继续轮询队列。
 *
 * 队列空闲（idle/paused）且没有任何待下载项时没有轮询的意义：状态不会自己变化，
 * 而用户点「开始下载」「订阅」「全部更新」时我们会立刻重启轮询。常驻的 3 秒请求
 * 在「全部就绪」的实例上只是白费流量与后端请求。
 *
 * 只要还有待下载项就继续轮询：用户可能在别的页面点了开始，这里要能跟上进度。
 */
export function shouldPollModDownloadQueue(input: {
  status: ModDownloadQueueStatus | null
  pendingCount: number
}): boolean {
  if (input.status === 'running' || input.status === 'pausing') {
    return true
  }
  return input.pendingCount > 0
}

export interface ModDownloadQueuePollerOptions {
  fetchQueue: () => Promise<ModDownloadQueueDto>
  onUpdate: (queue: ModDownloadQueueDto) => void
  onError?: (error: unknown) => void
  intervalMs?: number
  getIntervalMs?: () => number
  /** 页面不可见时停轮询（不产生请求）；重新可见后由下一次 tick 恢复 */
  isVisible?: () => boolean
  setTimer?: (handler: () => void, timeoutMs: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface ModDownloadQueuePoller {
  start: () => void
  stop: () => void
  refresh: () => Promise<void>
  isRunning: () => boolean
}

export function createModDownloadQueuePoller(
  options: ModDownloadQueuePollerOptions,
): ModDownloadQueuePoller {
  const intervalMs = options.intervalMs ?? MOD_DOWNLOAD_QUEUE_POLL_INTERVAL_MS
  const setTimer = options.setTimer
    ?? ((handler: () => void, timeoutMs: number) => globalThis.setTimeout(handler, timeoutMs))
  const clearTimer = options.clearTimer
    ?? ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>))

  let timer: unknown = null
  let running = false
  let generation = 0
  let fetching = false

  const schedule = () => {
    if (!running) {
      return
    }
    timer = setTimer(() => {
      void tick()
    }, options.getIntervalMs?.() ?? intervalMs)
  }

  const tick = async () => {
    if (!running) {
      return
    }
    timer = null
    if (fetching) { schedule(); return }
    if (options.isVisible && !options.isVisible()) {
      // 页面在后台不请求，但保留定时器：回到前台后由下一次 tick 立刻补上
      schedule()
      return
    }
    const current = generation
    fetching = true
    try {
      const queue = await options.fetchQueue()
      if (!running || generation !== current) {
        return
      }
      options.onUpdate(queue)
    }
    catch (error) {
      if (!running || generation !== current) {
        return
      }
      options.onError?.(error)
    }
    finally { fetching = false }
    if (generation === current) schedule()
  }

  return {
    start() {
      if (running) {
        return
      }
      running = true
      generation += 1
      void tick()
    },
    stop() {
      running = false
      generation += 1
      if (timer !== null) {
        clearTimer(timer)
        timer = null
      }
    },
    async refresh() {
      if (!running || fetching) return
      if (timer !== null) { clearTimer(timer); timer = null }
      await tick()
    },
    isRunning() {
      return running
    },
  }
}
