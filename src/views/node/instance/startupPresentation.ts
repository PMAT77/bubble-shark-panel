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

/** 启动终态只通知本会话发起的任务；swap 提示按浏览器会话去重，忽略历史失败。 */
export function createStartupNoticeTracker() {
  const accepted = new Map<string, { startedAfter: number, taskId?: string, matched: boolean }>()
  const notified = new Set<string>()
  const observed = new Set<string>()
  const swapNotified = new Set<string>()
  return {
    accept(id: string, startedAfter: number, taskId?: string) { accepted.set(id, { startedAfter, taskId, matched: false }) },
    pending(id: string) { return accepted.has(id) },
    consumeSwap(id: string, snapshot: InstanceStartupSnapshot) {
      const key = `${id}:${snapshot.taskId}`
      const request = accepted.get(id)
      const matchesRequest = request && (request.taskId ? request.taskId === snapshot.taskId : Date.parse(snapshot.startedAt) >= request.startedAfter)
      if (request && !matchesRequest) return null
      if (isStartupActive(snapshot)) observed.add(key)
      if (snapshot.status === 'cancelled' || snapshot.status === 'success'
        || (!isStartupActive(snapshot) && !matchesRequest && !observed.has(key))) return null
      const advice = snapshot.swapAdvice
      if (!advice?.command || !['none', 'low', 'exhausted'].includes(advice.state) || swapNotified.has(key)) return null
      swapNotified.add(key)
      try {
        const storageKey = `bsp_startup_swap:${key}`
        if (globalThis.sessionStorage?.getItem(storageKey) === '1') return null
        globalThis.sessionStorage?.setItem(storageKey, '1')
      }
      catch { /* 浏览器禁用存储时仍使用内存去重。 */ }
      return advice
    },
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
