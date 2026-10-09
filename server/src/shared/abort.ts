import { setTimeout as delay } from 'node:timers/promises'

/** 只取消当前调用的等待，不影响共享工作的其他调用者。 */
export function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  if (signal.aborted) { void work.catch(() => {}); return Promise.reject(signal.reason ?? new Error('任务已取消')) }
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason ?? new Error('任务已取消')) }
    signal.addEventListener('abort', aborted, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted)).catch(() => {})
  })
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return delay(ms, undefined, { signal })
}
