import { ref, watch, type Ref } from 'vue'
import apiInstance, { type InstanceItem, type InstanceStartupSnapshot } from '@/api/modules/instance'
import { createRuntimeMetricsPoller } from './runtimeMetricsPoller'
import { createStartupNoticeTracker, shouldPollStartup } from '../startupPresentation'

const notices = createStartupNoticeTracker()
const acceptanceVersion = ref(0)

export function trackStartupAccepted(id: string, startedAfter: number, taskId?: string) {
  notices.accept(id, startedAfter, taskId)
  acceptanceVersion.value++
}

export function useInstanceStartup(
  instances: Readonly<Ref<InstanceItem[]>>,
  commit: (id: string, snapshot: InstanceStartupSnapshot) => void,
  onTerminal?: () => void,
) {
  let enabled = false
  const ids = () => instances.value.filter(item => shouldPollStartup(item) || notices.pending(item.id)).map(item => item.id).sort()
  const poller = createRuntimeMetricsPoller({
    interval: 3000,
    request: signal => Promise.all(ids().map(async id => ({ id, snapshot: (await apiInstance.getInstanceStartup(id, { signal })).data }))),
    commit: results => {
      let terminal = false
      for (const { id, snapshot } of results) {
        const instance = instances.value.find(item => item.id === id)
        if (!instance) continue
        if (!snapshot) { terminal = true; continue }
        const previous = instance.startup
        if (previous && Date.parse(snapshot.startedAt) < Date.parse(previous.startedAt)) continue
        if (previous?.taskId === snapshot.taskId && Date.parse(snapshot.updatedAt) < Date.parse(previous.updatedAt)) continue
        commit(id, snapshot)
        const notice = notices.consume(id, snapshot)
        if (notice === 'success') faToast.success('实例已启动，全部世界已就绪')
        if (notice === 'failed') faToast.error('启动失败', { description: snapshot.diagnosis?.message ?? '请查看控制台日志和资源设置' })
        if ((snapshot.status === 'success' || snapshot.status === 'failed' || snapshot.status === 'cancelled') && previous?.status !== snapshot.status) terminal = true
      }
      if (terminal) onTerminal?.()
    },
    onError: () => { /* 传输错误由下一轮重试，不能当作游戏启动失败。 */ },
  })
  function syncStartupPolling() {
    enabled = true
    if (ids().length) poller.start()
    else poller.stop()
  }
  function stopStartupPolling() { enabled = false; poller.stop() }
  watch(() => `${acceptanceVersion.value}:${ids().map(id => `${id}:${instances.value.find(item => item.id === id)?.startup?.taskId ?? ''}`).join(',')}`, () => {
    poller.stop()
    if (enabled) syncStartupPolling()
  })
  return { syncStartupPolling, stopStartupPolling }
}
