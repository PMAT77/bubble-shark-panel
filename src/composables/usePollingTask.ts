import { onScopeDispose, shallowRef } from 'vue'

export interface PollingTaskOptions {
  intervalMs?: number
  immediate?: boolean
  pauseWhenHidden?: boolean
}

/** 带取消、in-flight 防重和作用域清理的轮询任务。 */
export function usePollingTask(task: (signal: AbortSignal) => Promise<void>, options: PollingTaskOptions = {}) {
  const running = shallowRef(false)
  const polling = shallowRef(false)
  const error = shallowRef<string | null>(null)
  const intervalMs = options.intervalMs ?? 5000
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | null = null
  let disposed = false
  let refreshPending = false
  const visibilityDocument = options.pauseWhenHidden && typeof document !== 'undefined' ? document : undefined
  const hidden = () => visibilityDocument?.visibilityState === 'hidden'

  function clearTimer() {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  function schedule() {
    clearTimer()
    if (polling.value && !hidden() && !disposed) {
      timer = setTimeout(() => void execute(), intervalMs)
    }
  }

  async function execute() {
    if (!polling.value || hidden() || disposed) {
      return
    }
    clearTimer()
    // 取消中的请求仍需结束后再恢复，避免慢请求与新一轮查询重叠。
    if (controller) {
      if (controller.signal.aborted) refreshPending = true
      return
    }
    controller = new AbortController()
    const activeController = controller
    running.value = true
    try {
      await task(activeController.signal)
      if (!activeController.signal.aborted) error.value = null
    }
    catch (reason) {
      if (!activeController.signal.aborted) {
        error.value = reason instanceof Error ? reason.message : '轮询失败，请稍后重试'
      }
    }
    finally {
      if (controller === activeController) {
        controller = null
        running.value = false
        if (refreshPending) {
          refreshPending = false
          void execute()
        }
        else schedule()
      }
    }
  }

  function start() {
    if (polling.value || disposed) {
      return
    }
    polling.value = true
    if (options.immediate !== false) {
      void execute()
    }
    else {
      schedule()
    }
  }

  function pause() {
    clearTimer()
    refreshPending = false
    controller?.abort()
    running.value = false
  }

  function stop() {
    polling.value = false
    pause()
  }

  function onVisibilityChange() {
    if (hidden()) pause()
    else if (polling.value) void execute()
  }

  visibilityDocument?.addEventListener('visibilitychange', onVisibilityChange)
  onScopeDispose(() => {
    disposed = true
    stop()
    visibilityDocument?.removeEventListener('visibilitychange', onVisibilityChange)
  })

  return { running, polling, error, start, stop, refresh: execute }
}
