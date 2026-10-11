import { ref, watch, type Ref } from 'vue'
import { useNotification } from 'naive-ui'
import { showStartupSwapNotification } from '@/utils/hostMemoryPressure'
import apiInstance, { type InstanceItem, type InstanceStartupSnapshot } from '@/api/modules/instance'
import { createRuntimeMetricsPoller } from './runtimeMetricsPoller'
import { createStartupNoticeTracker, shouldPollStartup, startupPhaseLabel } from '../startupPresentation'

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
  options: { notifyFailure?: boolean } = {},
) {
  const notification = useNotification()
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
        // 主世界确认就绪即恢复其查询，不等待洞穴终态。
        if (snapshot.master.state === 'ready' && previous?.master.state !== 'ready') terminal = true
        const swapAdvice = notices.consumeSwap(id, snapshot)
        if (swapAdvice) showStartupSwapNotification(notification, instance.name, swapAdvice)
        const notice = notices.consume(id, snapshot)
        if (notice === 'success') faToast.success(snapshot.target === 'caves' ? '洞穴已启动并连接主世界' : startupPhaseLabel(snapshot))
        if (notice === 'failed' && options.notifyFailure !== false) faToast.error(snapshot.master.state === 'ready' ? '洞穴启动失败，主世界继续运行' : '主世界启动失败', { description: snapshot.diagnosis?.message ?? '请查看控制台日志和服务器配置' })
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
