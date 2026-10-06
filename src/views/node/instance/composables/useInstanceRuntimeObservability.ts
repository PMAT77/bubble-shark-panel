import { ref, watch, type Ref } from 'vue'
import type { InstanceItem, InstanceRuntimeMetrics } from '@/api/modules/instance'
import apiInstance from '@/api/modules/instance'
import { createRuntimeMetricsPoller } from './runtimeMetricsPoller'

export function useInstanceRuntimeObservability(instances: Ref<InstanceItem[]>) {
  const instanceMetrics = ref<Record<string, InstanceRuntimeMetrics | null>>({})
  const uptimeNowMs = ref(Date.now())
  let enabled = false
  let silent = true
  let uptimeTickTimer: ReturnType<typeof setInterval> | undefined
  const runningIds = () => instances.value.filter(item => item.status === 'running').map(item => item.id).sort()
  const poller = createRuntimeMetricsPoller({
    request: signal => apiInstance.getInstanceMetrics(runningIds(), { signal }),
    commit: res => { instanceMetrics.value = res.data?.items ?? {} },
    onError: () => { if (!silent) faToast.error('实例资源指标刷新失败') },
  })

  function stopRuntimeObservability() {
    enabled = false
    poller.stop()
    clearInterval(uptimeTickTimer)
    uptimeTickTimer = undefined
  }

  async function fetchInstanceMetrics(options?: { silent?: boolean }) {
    if (!runningIds().length) {
      instanceMetrics.value = {}
      return
    }
    silent = options?.silent ?? false
    await poller.refresh()
  }

  function syncRuntimeObservabilityPolling() {
    enabled = true
    if (!runningIds().length) {
      poller.stop()
      instanceMetrics.value = {}
      clearInterval(uptimeTickTimer)
      uptimeTickTimer = undefined
      return
    }
    silent = true
    uptimeNowMs.value = Date.now()
    poller.start()
    uptimeTickTimer ??= setInterval(() => { uptimeNowMs.value = Date.now() }, 1000)
  }

  watch(() => runningIds().join(','), () => {
    poller.stop()
    instanceMetrics.value = {}
    if (enabled) syncRuntimeObservabilityPolling()
  }, { flush: 'sync' })

  return {
    instanceMetrics,
    uptimeNowMs,
    fetchInstanceMetrics,
    syncRuntimeObservabilityPolling,
    stopRuntimeObservability,
    getMetricsForInstance: (id: string) => instanceMetrics.value[id] ?? null,
  }
}
