/** 在动画帧之间也限制容量，避免突发日志堆积。 */
export function createConsoleLogBuffer<T extends { id: number }>(
  publish: (lines: T[]) => void,
  schedule = requestAnimationFrame,
  cancel = cancelAnimationFrame,
) {
  const lines = new Map<number, T>()
  let frame: number | undefined
  function flush() {
    if (frame === undefined) return
    cancel(frame)
    frame = undefined
    publish([...lines.values()])
  }
  return {
    append(items: T[]) {
      for (const item of items) {
        if (lines.has(item.id)) continue
        lines.set(item.id, item)
        if (lines.size > 2000) lines.delete(lines.keys().next().value!)
      }
      if (items.length && frame === undefined) frame = schedule(flush)
    },
    flush,
    clear() {
      if (frame !== undefined) cancel(frame)
      frame = undefined
      lines.clear()
      publish([])
    },
  }
}
