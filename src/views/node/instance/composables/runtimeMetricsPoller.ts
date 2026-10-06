/** 只有一个请求在途；取消后即使传输层仍返回，也不能提交旧结果。 */
export function createRuntimeMetricsPoller<T>(options: {
  request: (signal: AbortSignal) => Promise<T>
  commit: (result: T) => void
  onError: (error: unknown) => void
  interval?: number
}) {
  let generation = 0
  let active = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: Promise<void> | undefined
  let pendingGeneration = -1
  let controller: AbortController | undefined
  function stop() {
    active = false
    generation++
    clearTimeout(timer)
    timer = undefined
    controller?.abort()
  }
  async function refresh(): Promise<void> {
    const version = generation
    if (pending) {
      if (pendingGeneration === version) return pending
      await pending
      if (version !== generation) return
    }
    if (version !== generation) return
    // 同一代的并发刷新合并；重启的一代等待取消中的前序请求结束。
    if (pending) return pending
    controller = new AbortController()
    const signal = controller.signal
    const task = (async () => {
      try {
        const result = await options.request(signal)
        if (version === generation && !signal.aborted) options.commit(result)
      }
      catch (error) {
        if (version === generation && !signal.aborted) options.onError(error)
      }
    })()
    pending = task
    pendingGeneration = version
    try { await task }
    finally {
      if (pending === task) pending = undefined
      if (active && version === generation) {
        clearTimeout(timer)
        timer = setTimeout(() => void refresh(), options.interval ?? 5000)
      }
    }
  }
  return {
    refresh,
    stop,
    start() {
      if (active) return
      active = true
      void refresh()
    },
  }
}
