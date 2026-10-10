import { computed, onActivated, onDeactivated, onBeforeUnmount, ref, watch, type MaybeRefOrGetter, toValue } from 'vue'
import api from '@/api/modules/world-maintenance'
import type { WorldMaintenanceOperation, WorldMaintenancePayload } from '@/api/modules/world-maintenance'

type ActionInput = WorldMaintenancePayload extends infer P ? P extends WorldMaintenancePayload ? Omit<P, 'instanceId' | 'requestId' | 'backupBefore'> : never : never
export function useWorldMaintenance(instanceId: MaybeRefOrGetter<string>, enabled: MaybeRefOrGetter<boolean> = true) {
  const operation = ref<WorldMaintenanceOperation | null>(null)
  const activeKey = ref<string | null>(null)
  const submitting = ref(false)
  const backupBefore = ref(true)
  const busy = computed(() => submitting.value || ['running', 'awaiting_confirmation', 'unknown'].includes(operation.value?.state ?? ''))
  let timer: ReturnType<typeof setTimeout> | undefined
  let generation = 0
  let disposed = false
  let suspended = false
  async function refresh() {
    clearTimeout(timer)
    const id = toValue(instanceId)
    const current = generation
    if (!id || !toValue(enabled) || disposed || suspended) return
    try {
      const { data } = await api.status(id)
      if (generation !== current || disposed || suspended) return
      operation.value = data
      if (data && ['completed', 'failed', 'cancelled', 'unknown'].includes(data.state)) activeKey.value = null
      timer = setTimeout(() => void refresh(), data && ['running', 'awaiting_confirmation'].includes(data.state) ? 1000 : 3000)
    }
    catch { activeKey.value = null; if (!disposed && !suspended) timer = setTimeout(() => void refresh(), 3000) }
  }
  async function submit(action: ActionInput, key: string) {
    if (busy.value) return
    submitting.value = true
    activeKey.value = key
    try {
      const { data } = await api.begin({ ...action, instanceId: toValue(instanceId), requestId: crypto.randomUUID(), backupBefore: backupBefore.value } as WorldMaintenancePayload)
      operation.value = data
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
    try { operation.value = (await api.verify(toValue(instanceId), operation.value.id)).data; await refresh() }
    finally { submitting.value = false }
  }
  watch(() => [toValue(instanceId), toValue(enabled)], () => {
    generation += 1
    clearTimeout(timer)
    operation.value = null
    activeKey.value = null
    void refresh()
  }, { immediate: true })
  onActivated(() => { suspended = false; void refresh() })
  onDeactivated(() => { suspended = true; generation += 1; clearTimeout(timer) })
  onBeforeUnmount(() => { disposed = true; clearTimeout(timer) })
  return { operation, activeKey, submitting, backupBefore, busy, refresh, submit, continueWithoutBackup, recheck }
}
