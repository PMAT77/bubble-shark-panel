import type { InstanceItem } from '@/api/modules/instance'
import { GAME_CODES } from '@/constants/games'

type InstallGuideTarget = Pick<InstanceItem, 'gameCode' | 'status'>
type InstallResultTarget = Pick<InstanceItem, 'name' | 'status' | 'lastErrorPhase'> & Partial<Pick<InstanceItem, 'installLogStatus' | 'lastError' | 'installTask'>>

export interface InstallResultNotificationPayload {
  type: 'success' | 'error' | 'info'
  title: string
  content: string
  durationMs: number
}

export function shouldShowPostCreateInstallGuide(instance: InstallGuideTarget): boolean {
  return instance.gameCode === GAME_CODES.DST
    && (instance.status === 'pending_install' || instance.status === 'installing')
}

export function buildInstallResultNotification(
  instance: InstallResultTarget,
): InstallResultNotificationPayload | null {
  if (instance.installLogStatus === 'cancelled') {
    const operation = instance.installTask?.kind === 'update' ? '更新' : '安装'
    return { type: 'info', title: `实例${operation}已取消`, content: `「${instance.name}」${operation}已取消，可稍后重试`, durationMs: 5000 }
  }
  if (instance.installLogStatus === 'success') {
    const updating = instance.installTask?.kind === 'update'
    return {
      type: 'success',
      title: updating ? '实例更新完成' : '实例安装完成',
      content: `「${instance.name}」${updating ? '更新' : '安装'}完成${instance.status === 'stopped' ? '，可以启动实例' : ''}`,
      durationMs: 5000,
    }
  }
  if (instance.status === 'stopped') return null
  if (instance.status !== 'error' || instance.installLogStatus === 'running') return null
  /**
   * error 未必是安装的结果：安装成功后启动失败（内存不足、端口占用）也会落到 error。
   * 只有安装环节的失败才作为「安装失败」上报，其余的交给启动路径自己的提示。
   */
  if (instance.lastErrorPhase !== 'install') {
    return null
  }
  return {
    type: 'error',
    title: instance.installTask?.kind === 'update' ? '实例更新失败' : '实例安装失败',
    content: `「${instance.name}」${instance.installTask?.kind === 'update' ? '更新' : '安装'}失败：${instance.lastError || '请查看安装日志'}`,
    durationMs: 5000,
  }
}

/** 输入是完整的已授权实例集合；按任务而非实例去重，历史终态不重播。 */
export function collectInstallResultNotifications(list: InstanceItem[], pending: Map<string, string>) {
  for (const row of list) {
    const taskId = row.installTask?.taskId ?? row.installTaskId
    if (taskId && (row.status === 'installing' || row.status === 'pending_install')) pending.set(row.id, taskId)
  }
  const notifications: InstallResultNotificationPayload[] = []
  for (const [id, taskId] of pending) {
    const row = list.find(item => item.id === id)
    if (!row) { pending.delete(id); continue }
    if ((row.installTask?.taskId ?? row.installTaskId) !== taskId) continue
    if (!row.installLogStatus || row.installLogStatus === 'running') continue
    pending.delete(id)
    const payload = buildInstallResultNotification(row)
    if (payload) notifications.push(payload)
  }
  return notifications
}
