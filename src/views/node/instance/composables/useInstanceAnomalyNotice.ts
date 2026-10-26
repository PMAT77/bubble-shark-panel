import type { InstanceItem } from '@/api/modules/instance'
import type { NotificationReactive } from 'naive-ui'
import { NButton, useNotification } from 'naive-ui'
import { computed, h, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { collectInstanceAnomalies, createInstanceAnomalyTracker } from '../instanceAnomalies'

// 与启动 swap 提示一样，按浏览器标签页记住已提示的异常。
let storage: Storage | undefined
try { storage = globalThis.sessionStorage } catch { /* 存储被禁用时回退到内存。 */ }
const tracker = createInstanceAnomalyTracker(storage)

export function useInstanceAnomalyNotice(instance: Readonly<Ref<InstanceItem | null>>, active: Readonly<Ref<boolean>>) {
  const notification = useNotification()
  const anomalies = computed(() => collectInstanceAnomalies(instance.value))
  const detailsVisible = ref(false)
  let notice: NotificationReactive | null = null
  let ownerId: string | undefined

  function closeNotice() {
    notice?.destroy()
    notice = null
  }
  function showDetails() {
    if (!active.value || !anomalies.value.length) return
    detailsVisible.value = true
    closeNotice()
  }
  watch([instance, active], ([item, isActive]) => {
    if (!isActive || ownerId !== item?.id || !anomalies.value.length) {
      detailsVisible.value = false
      closeNotice()
    }
    ownerId = item?.id
    if (!isActive || !item) return
    const changed = tracker.consume(item.id, item.startup?.taskId ?? null, anomalies.value)
    if (!anomalies.value.length) return
    if (!changed) {
      return
    }
    closeNotice()
    const options = {
      title: `${item.name} · 异常提醒`,
      content: '请查看异常详情了解原因',
      duration: 8000,
      closable: true,
      keepAliveOnHover: true,
      action: () => h(NButton, { size: 'small', quaternary: true, onClick: showDetails }, () => '查看详情'),
      onAfterLeave: () => { if (notice === nextNotice) notice = null },
    }
    const nextNotice = item.status === 'error' || item.startup?.status === 'failed' || item.lastError
      ? notification.error(options) : notification.warning(options)
    notice = nextNotice
  }, { immediate: true, flush: 'post' })
  onBeforeUnmount(closeNotice)
  return { anomalies, detailsVisible, showDetails }
}
