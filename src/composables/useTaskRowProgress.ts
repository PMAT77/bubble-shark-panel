export interface TaskRowProgress { id: string, taskId?: string | null, percent?: number | null, state: 'active' | 'paused' | 'success' | 'failed' | 'inactive' }
import { nextTick, onBeforeUnmount, onMounted, onUpdated, reactive, ref, watch, type Ref } from 'vue'


interface RowProgress { taskId: string, percent: number, cancelling: boolean, finishing: boolean, fading: boolean }

/** 同一可见画布切到各单元格；固定列使用自己的可见位置。 */
export function useTaskRowProgress(tasks: Ref<TaskRowProgress[]>) {
  const surface = ref<HTMLElement | null>(null)
  const rows = reactive(new Map<string, RowProgress>())
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let frame = 0
  let disposed = false
  let observer: ResizeObserver | undefined
  let observedViewport: Element | null = null

  function forget(id: string) {
    const timer = timers.get(id)
    if (timer) clearTimeout(timer)
    timers.delete(id)
    rows.delete(id)
  }
  function trackAccepted(id: string, taskId: string, initialPercent = 0) {
    forget(id)
    rows.set(id, { taskId, percent: initialPercent, cancelling: false, finishing: false, fading: false })
  }
  function measure() {
    frame = 0
    const root = surface.value
    const sample = root?.querySelector<HTMLTableRowElement>('tr[data-task-row]')
    if (!root || !sample) return
    const viewport = sample.closest('.n-scrollbar-container') ?? sample.closest('.n-data-table-base-table-body') ?? root
    if (observedViewport !== viewport) {
      if (observedViewport) observer?.unobserve(observedViewport)
      observer?.observe(viewport)
      observedViewport = viewport
    }
    const bounds = viewport.getBoundingClientRect()
    const width = (viewport as HTMLElement).clientWidth || bounds.width
    const geometry = Array.from(sample.cells).map(cell => {
      const box = cell.getBoundingClientRect()
      return { offset: box.left - bounds.left, width: box.width }
    })
    for (const row of root.querySelectorAll<HTMLTableRowElement>('tr[data-task-row]')) {
      row.style.setProperty('--task-progress-canvas-width', width + 'px')
      Array.from(row.cells).forEach((cell, index) => {
        const value = geometry[index]
        if (!value) return
        cell.style.setProperty('--task-progress-cell-offset', value.offset + 'px')
        cell.style.setProperty('--task-progress-cell-width', value.width + 'px')
      })
    }
  }
  function scheduleMeasure() { if (!disposed && !frame) frame = requestAnimationFrame(measure) }
  onUpdated(scheduleMeasure)
  function rowProps(id: string) {
    const progress = rows.get(id)
    if (!progress) return {}
    return {
      class: ['task-progress-row', progress.cancelling ? 'task-progress-paused' : '', progress.finishing ? 'task-progress-finishing' : '', progress.fading ? 'task-progress-fading' : ''].join(' '),
      'data-task-row': id,
      style: { '--task-progress-ratio': String(progress.percent / 100) },
    }
  }
  watch(tasks, async list => {
    const visible = new Set(list.map(row => row.id))
    for (const id of rows.keys()) if (!visible.has(id)) forget(id)
    for (const row of list) {
      const old = rows.get(row.id)
      if ((row.state === 'active' || row.state === 'paused') && row.taskId) {
        if (!old || old.taskId !== row.taskId) trackAccepted(row.id, row.taskId)
        const current = rows.get(row.id)!
        if (row.percent != null && Number.isFinite(row.percent)) current.percent = Math.max(current.percent, Math.min(100, Math.max(0, row.percent)))
        current.cancelling = row.state === 'paused' || row.percent == null
      }
      else if (old && row.state === 'success' && row.taskId === old.taskId) {
        if (old.finishing) continue
        old.percent = 100
        old.finishing = true
        timers.set(row.id, setTimeout(() => {
          old.fading = true
          timers.set(row.id, setTimeout(() => forget(row.id), 250))
        }, 900))
      }
      else if (old && row.state === 'failed' && row.taskId === old.taskId) old.cancelling = true
      else if (old) forget(row.id)
    }
    await nextTick()
    scheduleMeasure()
  }, { deep: true, flush: 'post', immediate: true })
  function visibility() { if (surface.value) surface.value.dataset.taskPaused = String(document.hidden) }
  function reset() { for (const id of rows.keys()) forget(id) }
  watch(surface, (root, previous) => {
    if (observedViewport) observer?.unobserve(observedViewport)
    observedViewport = null
    previous?.removeEventListener('scroll', scheduleMeasure, true)
    if (previous) observer?.unobserve(previous)
    root?.addEventListener('scroll', scheduleMeasure, { capture: true, passive: true })
    if (root) observer?.observe(root)
    visibility()
    scheduleMeasure()
  }, { flush: 'post' })
  onMounted(() => {
    observer = new ResizeObserver(scheduleMeasure)
    if (surface.value) {
      observer.observe(surface.value)
      surface.value.addEventListener('scroll', scheduleMeasure, { capture: true, passive: true })
    }
    document.addEventListener('visibilitychange', visibility)
    visibility()
  })
  onBeforeUnmount(() => {
    disposed = true
    observer?.disconnect()
    if (frame) cancelAnimationFrame(frame)
    surface.value?.removeEventListener('scroll', scheduleMeasure, true)
    document.removeEventListener('visibilitychange', visibility)
    for (const id of rows.keys()) forget(id)
  })
  return { surface, rowProps, trackAccepted, reset, scheduleMeasure }
}
