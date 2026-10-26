import type { FastifyInstance } from 'fastify'
import type { ScheduledUpdateResult } from './scheduled-update'

export interface InstanceScheduledOperationResult {
  ok: boolean
  message?: string
}

/**
 * 计划任务所需的实例内部操作通道。
 * 实现由 instance 模块注册（闭包内可访问 handleInstanceStart 等内部能力），
 * schedule 模块经此调用，避免构造带用户 token 的 HTTP 请求。
 */
export interface InstanceScheduledOps {
  /** 停止运行中实例并重新启动（等价手动重启语义，但无需用户会话） */
  restart: (app: FastifyInstance, instanceId: string) => Promise<InstanceScheduledOperationResult>
  update: (app: FastifyInstance, instanceId: string, progress: (message: string) => Promise<void>) => Promise<ScheduledUpdateResult>
  recoverUpdate: (instanceId: string) => Promise<string>
}

let registered: InstanceScheduledOps | null = null

export function registerInstanceScheduledOps(impl: InstanceScheduledOps | null): void {
  registered = impl
}

export async function restartInstanceBySchedule(app: FastifyInstance, instanceId: string): Promise<InstanceScheduledOperationResult> {
  if (!registered) {
    return { ok: false, message: '实例模块尚未初始化，无法执行计划重启' }
  }
  return registered.restart(app, instanceId)
}

export async function updateInstanceBySchedule(app: FastifyInstance, instanceId: string, progress: (message: string) => Promise<void>): Promise<ScheduledUpdateResult> {
  if (!registered) return { status: 'failed', disableTask: true, message: '实例模块尚未初始化，无法执行定时更新；任务已停用' }
  return registered.update(app, instanceId, progress)
}

export async function recoverScheduledInstanceUpdate(instanceId: string): Promise<string> {
  if (!registered) return '实例模块尚未初始化，未能确认实例停止'
  return registered.recoverUpdate(instanceId)
}
