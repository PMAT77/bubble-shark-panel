import { computed, onActivated, onDeactivated, onBeforeUnmount, ref, watch, type MaybeRefOrGetter, toValue } from 'vue'
import { useNotification, type NotificationReactive } from 'naive-ui'
import api from '@/api/modules/world-maintenance'
import type { WorldMaintenanceOperation, WorldMaintenancePayload } from '@/api/modules/world-maintenance'
import { createRequestId } from '@/utils/requestId'

type ActionInput = WorldMaintenancePayload extends infer P ? P extends WorldMaintenancePayload ? Omit<P, 'instanceId' | 'requestId' | 'backupBefore'> : never : never
export function useWorldMaintenance(instanceId: MaybeRefOrGetter<string>, enabled: MaybeRefOrGetter<boolean> = true) {
  const notification = useNotification()
  const operation = ref<WorldMaintenanceOperation | null>(null)
  const activeKey = ref<string | null>(null)
  const submitting = ref(false)
  const backupBefore = ref(true)
  const busy = computed(() => submitting.value || ['running', 'awaiting_confirmation', 'unknown'].includes(operation.value?.state ?? ''))
  let timer: ReturnType<typeof setTimeout> | undefined
  let generation = 0
  let disposed = false
  let suspended = false
  let notice: NotificationReactive | null = null
  const phaseLabels = { preparing: '核验运行状态与目标', saving: '保存存档', backing_up: '创建安全备份', applying_config: '更新生成配置', executing: '发送生成或重载请求', starting: '启动实例', verifying: '等待世界加载并核验', finished: '操作已结束' }
  function closeNotice() {
    notice?.destroy()
    notice = null
  }
  function updateOperation(data: WorldMaintenanceOperation | null, accepted = false) {
    const previous = operation.value
    operation.value = data
    if (!data) { closeNotice(); return }
    if (disposed || suspended) return
    if (!accepted && !previous && ['completed', 'failed', 'cancelled'].includes(data.state)) return
    if (previous?.id === data.id && previous.state === data.state && previous.phase === data.phase
      && previous.message === data.message && previous.backupWarning === data.backupWarning && previous.backupSkipped === data.backupSkipped) return
    closeNotice()
    const type = data.state === 'completed' ? 'success' : ['failed', 'unknown'].includes(data.state) ? 'error'
      : data.state === 'awaiting_confirmation' ? 'warning' : 'info'
    const title = data.state === 'completed' ? '操作已完成' : data.state === 'failed' ? '操作失败'
      : data.state === 'unknown' ? '操作结果未确认' : data.state === 'cancelled' ? '操作已取消'
        : data.state === 'awaiting_confirmation' ? '安全备份失败，等待确认' : phaseLabels[data.phase]
    const nextNotice = notification[type]({
      title,
      content: [data.message || '正在执行，请等待结果。', data.backupWarning, data.backupSkipped ? '本次操作未创建安全备份。' : null].filter(Boolean).join('\n'),
      duration: ['running', 'awaiting_confirmation'].includes(data.state) ? 0 : 8000,
      closable: true,
      keepAliveOnHover: true,
      onAfterLeave: () => { if (notice === nextNotice) notice = null },
    })
    notice = nextNotice
  }
  async function refresh() {
    clearTimeout(timer)
    const id = toValue(instanceId)
    const current = generation
    if (!id || !toValue(enabled) || disposed || suspended) return
    try {
      const { data } = await api.status(id)
      if (generation !== current || disposed || suspended) return
      updateOperation(data)
      if (data && ['completed', 'failed', 'cancelled', 'unknown'].includes(data.state)) activeKey.value = null
      timer = setTimeout(() => void refresh(), data && ['running', 'awaiting_confirmation'].includes(data.state) ? 1000 : 3000)
    }
    catch { activeKey.value = null; if (!disposed && !suspended) timer = setTimeout(() => void refresh(), 3000) }
  }
  async function submit(action: ActionInput, key: string) {
    if (busy.value) return
    let requestId: string
    try { requestId = createRequestId() }
    catch (error) {
      faToast.error('无法发起世界维护', { description: error instanceof Error ? error.message : '请刷新页面后重试。' })
      return
    }
    submitting.value = true
    activeKey.value = key
    try {
      const { data } = await api.begin({ ...action, instanceId: toValue(instanceId), requestId, backupBefore: backupBefore.value } as WorldMaintenancePayload)
      updateOperation(data, true)
      clearTimeout(timer)
      await refresh()
    }
    catch { activeKey.value = null }
    finally { submitting.value = false }
  }
  async function continueWithoutBackup(continueAction: boolean) {
    if (!operation.value || submitting.value) return
    submitting.value = true
    try { await api.continue(toValue(instanceId), operation.value.id, continueAction); await refresh() }
    finally { submitting.value = false }
  }
  async function recheck() {
    if (!operation.value || submitting.value) return
    submitting.value = true
    try { updateOperation((await api.verify(toValue(instanceId), operation.value.id)).data, true); await refresh() }
    finally { submitting.value = false }
  }
  watch(() => [toValue(instanceId), toValue(enabled)], () => {
    generation += 1
    clearTimeout(timer)
    closeNotice()
    operation.value = null
    activeKey.value = null
    void refresh()
  }, { immediate: true })
  onActivated(() => { suspended = false; void refresh() })
  onDeactivated(() => { suspended = true; generation += 1; clearTimeout(timer); closeNotice() })
  onBeforeUnmount(() => { disposed = true; clearTimeout(timer); closeNotice() })
  return { operation, activeKey, submitting, backupBefore, busy, refresh, submit, continueWithoutBackup, recheck }
}
