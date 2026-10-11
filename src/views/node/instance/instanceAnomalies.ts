import type { InstanceItem } from '@/api/modules/instance'
import { isStartupActive } from './startupPresentation'

type World = 'master' | 'caves' | null
export interface InstanceAnomaly {
  reason: string
  world: World
}

export function instanceAnomalyText(anomaly: InstanceAnomaly): string {
  const label = anomaly.world === 'master' ? '地上' : anomaly.world === 'caves' ? '洞穴' : null
  if ((anomaly.world === 'master' && /^(主世界|地上)/.test(anomaly.reason))
    || (anomaly.world === 'caves' && anomaly.reason.startsWith('洞穴'))) return anomaly.reason
  return label ? `${label}：${anomaly.reason}` : anomaly.reason
}

/** 合并旧错误字段与启动诊断，保留不同世界的独立原因。 */
export function collectInstanceAnomalies(instance: InstanceItem | null): InstanceAnomaly[] {
  if (!instance) return []
  const result: InstanceAnomaly[] = []
  const startup = instance.startup
  const starting = isStartupActive(startup)
  const failedStartup = startup?.status === 'failed'
    && !['stopped', 'installing', 'pending_install'].includes(instance.status)
  const failedWorld: World = failedStartup
    ? startup.master.state === 'failed' ? 'master' : startup.caves.state === 'failed' ? 'caves' : null
    : null

  function add(text: string | null | undefined, world: World = null) {
    if (!text?.trim()) return
    const value = text.trim()
    const prefix = value.match(/^(主世界|地上|洞穴)?启动失败[：:]\s*/)
    const reason = (prefix ? value.slice(prefix[0].length) : value).trim()
    if (!reason) return
    world ??= prefix?.[1] === '洞穴' ? 'caves'
      : prefix?.[1] ? 'master'
        : /^(洞穴)/.test(reason) ? 'caves'
          : /^(主世界|地上)/.test(reason) ? 'master'
            : failedWorld
    const same = result.find(item => item.reason === reason && (item.world === world || !item.world || !world))
    if (same) same.world ??= world
    else result.push({ reason, world })
  }

  if (failedStartup || (starting && startup)) {
    for (const world of ['master', 'caves'] as const) {
      if (startup[world].state === 'failed') {
        add(startup[world].diagnosis?.message ?? startup[world].protectionStop?.message, world)
      }
    }
    if (failedStartup) add(startup.diagnosis?.message ?? startup.protectionStop?.message)
  }
  // 新任务先于旧错误清理落库；启动期间只使用本轮分片失败证据。
  if (!starting) {
    add(instance.runtimeWarning)
    // 安装进行中可能仍携带上一次安装的错误，不将历史失败当作新异常。
    if (!['installing', 'pending_install'].includes(instance.status)) add(instance.lastError)
  }
  if (failedStartup && !result.length) add('启动失败，请查看控制台日志和服务器配置', failedWorld)
  return result
}

/** 页面返回和刷新不重复通知；恢复后再发生，以及新启动任务，均可再次提醒。 */
export function createInstanceAnomalyTracker(storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {
  const states = new Map<string, { task: string | null, seen: string[] }>()
  return {
    consume(id: string, task: string | null, anomalies: InstanceAnomaly[]): boolean {
      const storageKey = `bsp-instance-anomaly:${id}`
      if (!anomalies.length) {
        states.delete(id)
        try { storage?.removeItem(storageKey) } catch { /* 禁用存储时使用本页会话去重。 */ }
        return false
      }
      let state = states.get(id)
      if (!state) {
        try {
          const saved = JSON.parse(storage?.getItem(storageKey) ?? 'null')
          if (saved && (typeof saved.task === 'string' || saved.task === null)
            && Array.isArray(saved.seen) && saved.seen.every((key: unknown) => typeof key === 'string')) state = saved
        }
        catch { /* 存储不可用或旧值损坏时重新建立基线。 */ }
      }
      if (!state || state.task !== task) state = { task, seen: [] }
      const keys = anomalies.map(item => JSON.stringify([item.world, item.reason]))
      const previous = state.seen
      const changed = anomalies.some(item => {
        const worlds: World[] = item.world ? [item.world, null] : ['master', 'caves', null]
        return !worlds.some(world => previous.includes(JSON.stringify([world, item.reason])))
      })
      // 只保留当前原因：某一原因解除后再出现，即使其他异常仍在，也需要再次提醒。
      state.seen = keys
      states.set(id, state)
      try { storage?.setItem(storageKey, JSON.stringify(state)) } catch { /* 内存基线仍可去重。 */ }
      return changed
    },
  }
}
