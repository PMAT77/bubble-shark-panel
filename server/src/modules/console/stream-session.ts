import type { ServerResponse } from 'node:http'

const MAX_PENDING_BYTES = 1024 * 1024

/** 每个订阅独立清理；慢连接不能把内存压力传给其他订阅者。 */
export function createConsoleStreamSession(response: ServerResponse, release: () => void) {
  let closed = false
  const cleanups = new Set<() => void>([release])
  function dispose() {
    if (closed) return
    closed = true
    response.off('close', dispose)
    response.off('error', close)
    for (const cleanup of cleanups) cleanup()
    cleanups.clear()
  }
  function close() {
    dispose()
    response.destroy()
  }
  response.on('close', dispose)
  response.on('error', close)
  return {
    dispose,
    close,
    get closed() { return closed || response.destroyed || response.writableEnded },
    onCleanup(cleanup: () => void) {
      if (closed) cleanup()
      else cleanups.add(cleanup)
    },
    write(text: string) {
      if (closed || response.destroyed || response.writableEnded) {
        dispose()
        return false
      }
      if (response.writableLength + Buffer.byteLength(text) > MAX_PENDING_BYTES) {
        close()
        return false
      }
      try { response.write(text); return true }
      catch { close(); return false }
    },
  }
}
