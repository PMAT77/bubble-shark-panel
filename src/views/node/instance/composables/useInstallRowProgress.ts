import type { InstanceItem } from '@/api/modules/instance'
import { nextTick, onBeforeUnmount, onMounted, reactive, ref, watch, type Ref } from 'vue'
import { isInstanceInstallingStatus } from '../instanceDisplay'

interface RowProgress { taskId: string, percent: number, cancelling: boolean, finishing: boolean, fading: boolean }

/** 同一可见画布切到各单元格；固定列使用自己的可见位置。 */
export function useInstallRowProgress(instances: Ref<InstanceItem[]>) {
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
  function trackAccepted(id: string, taskId: string) {
    forget(id)
    rows.set(id, { taskId, percent: 1, cancelling: false, finishing: false, fading: false })
  }
  function measure() {
    frame = 0
    const root = surface.value
    const sample = root?.querySelector<HTMLTableRowElement>('tr[data-install-row]')
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
    for (const row of root.querySelectorAll<HTMLTableRowElement>('tr[data-install-row]')) {
      row.style.setProperty('--install-canvas-width', width + 'px')
      Array.from(row.cells).forEach((cell, index) => {
        const value = geometry[index]
        if (!value) return
        cell.style.setProperty('--install-cell-offset', value.offset + 'px')
        cell.style.setProperty('--install-cell-width', value.width + 'px')
      })
    }
  }
  function scheduleMeasure() { if (!disposed && !frame) frame = requestAnimationFrame(measure) }
  function rowProps(row: InstanceItem) {
    const progress = rows.get(row.id)
    if (!progress) return {}
    return {
      class: ['instance-install-row', progress.cancelling ? 'install-cancelling' : '', progress.finishing ? 'install-finishing' : '', progress.fading ? 'install-fading' : ''].join(' '),
      'data-install-row': row.id,
      style: { '--install-ratio': String(progress.percent / 100) },
    }
  }
  watch(instances, async list => {
    const visible = new Set(list.map(row => row.id))
    for (const id of rows.keys()) if (!visible.has(id)) forget(id)
    for (const row of list) {
      const taskId = row.installTask?.taskId ?? row.installTaskId
      const percent = row.installTask?.overallPercent ?? row.installPercent
      const old = rows.get(row.id)
      if (isInstanceInstallingStatus(row.status) && taskId && percent != null) {
        if (!old || old.taskId !== taskId) trackAccepted(row.id, taskId)
        const current = rows.get(row.id)!
        current.percent = Math.max(current.percent, Math.min(99, percent))
        current.cancelling = row.installTask?.phaseCode === 'cancelling'
      }
      else if (old && row.installLogStatus === 'success' && taskId === old.taskId) {
        if (old.finishing) continue
        old.percent = 100
        old.finishing = true
        // 600ms 填满后停留 300ms，再淡出；历史成功不重播。
        timers.set(row.id, setTimeout(() => {
          old.fading = true
          timers.set(row.id, setTimeout(() => forget(row.id), 250))
        }, 900))
      }
      else if (old) forget(row.id)
    }
    await nextTick()
    scheduleMeasure()
  }, { deep: true, flush: 'post' })
  function visibility() { if (surface.value) surface.value.dataset.installPaused = String(document.hidden) }
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
  return { surface, rowProps, trackAccepted }
}
