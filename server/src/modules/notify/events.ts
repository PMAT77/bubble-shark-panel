/**
 * 面板事件总线（进程内发布订阅）。
 * 运维链路（崩溃检测、备份结果、阈值告警等）发布事件；
 * 通知模块订阅后按渠道配置外发。单进程语义，不做跨节点分发。
 */

export type PanelEventType =
  | 'instance_exited_unexpectedly'
  | 'backup_completed'
  | 'backup_failed'
  | 'update_available'
  | 'resource_threshold'

export interface PanelEvent {
  type: PanelEventType
  /** 事件主体：实例 id 或 panel-db 等哨兵 */
  subjectId: string
  /** 展示用名称（实例名等） */
  subjectName: string
  message: string
  severity: 'info' | 'warning' | 'critical'
  at: string
  /** 同一实例不同保护轮次各通知一次，重复发布仍受冷却保护。 */
  occurrenceKey?: string
}

type PanelEventListener = (event: PanelEvent) => void

const listeners = new Set<PanelEventListener>()

export function subscribePanelEvent(listener: PanelEventListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function emitPanelEvent(event: PanelEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    }
    catch {
      // 单个订阅者异常不阻断其余通知链路
    }
  }
}
