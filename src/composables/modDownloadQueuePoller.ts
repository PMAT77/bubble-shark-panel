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

  const schedule = () => {
    if (!running) {
      return
    }
    timer = setTimer(() => {
      void tick()
    }, intervalMs)
  }

  const tick = async () => {
    if (!running) {
      return
    }
    timer = null
    if (options.isVisible && !options.isVisible()) {
      // 页面在后台不请求，但保留定时器：回到前台后由下一次 tick 立刻补上
      schedule()
      return
    }
    try {
      const queue = await options.fetchQueue()
      if (!running) {
        return
      }
      options.onUpdate(queue)
    }
    catch (error) {
      if (!running) {
        return
      }
      options.onError?.(error)
    }
    schedule()
  }

  return {
    start() {
      if (running) {
        return
      }
      running = true
      void tick()
    },
    stop() {
      running = false
      if (timer !== null) {
        clearTimer(timer)
        timer = null
      }
    },
    async refresh() {
      if (!running) {
        return
      }
      try {
        options.onUpdate(await options.fetchQueue())
      }
      catch (error) {
        options.onError?.(error)
      }
    },
    isRunning() {
      return running
    },
  }
}
