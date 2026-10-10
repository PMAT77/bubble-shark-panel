import type { InstanceItem, InstanceStartupSnapshot } from '@/api/modules/instance'

const PHASE_LABELS: Record<InstanceStartupSnapshot['phase'], string> = {
  queued: '等待启动', prepare: '准备运行环境', master_loading: '主世界加载中',
  caves_loading: '洞穴加载中', connecting: '验证分片连接', ready: '全部世界已就绪',
  failed: '启动失败', cancelled: '启动已取消',
}

export function startupPhaseLabel(snapshot: InstanceStartupSnapshot) {
  if (snapshot.protectionStop) return '内存保护停止'
  return PHASE_LABELS[snapshot.phase]
}

export function isStartupActive(snapshot: InstanceStartupSnapshot | null | undefined) {
  return snapshot?.status === 'queued' || snapshot?.status === 'running'
}

export function isInstanceWorldReady(instance: Pick<InstanceItem, 'status' | 'runtimeReadyAt'> & { startup?: InstanceStartupSnapshot | null }) {
  return instance.status === 'running' && !instance.startup?.protectionStop && (instance.startup ? instance.startup.status === 'success' : Boolean(instance.runtimeReadyAt))
}

export function shouldPollStartup(instance: Pick<InstanceItem, 'status' | 'runtimeReadyAt'> & { startup?: InstanceStartupSnapshot | null }) {
  return isStartupActive(instance.startup) || (instance.status === 'running' && !instance.startup && !instance.runtimeReadyAt)
}

/** 只通知当前页面会话发起的启动；旧任务、重复轮询与跨页面重连均不再弹提示。 */
export function createStartupNoticeTracker() {
  const accepted = new Map<string, { startedAfter: number, taskId?: string, matched: boolean }>()
  const notified = new Set<string>()
  return {
    accept(id: string, startedAfter: number, taskId?: string) { accepted.set(id, { startedAfter, taskId, matched: false }) },
    pending(id: string) { return accepted.has(id) },
    consume(id: string, snapshot: InstanceStartupSnapshot): 'success' | 'failed' | null {
      const request = accepted.get(id)
      if (!request) return null
      if (!request.taskId && Date.parse(snapshot.startedAt) < request.startedAfter) return null
      request.taskId ??= snapshot.taskId
      if (request.taskId !== snapshot.taskId) { if (request.matched) accepted.delete(id); return null }
      request.matched = true
      if (isStartupActive(snapshot)) return null
      accepted.delete(id)
      if (snapshot.status === 'cancelled' || notified.has(snapshot.taskId)) return null
      notified.add(snapshot.taskId)
      return snapshot.status === 'success' ? 'success' : 'failed'
    },
  }
}
