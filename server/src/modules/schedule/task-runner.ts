import type { FastifyInstance } from 'fastify'
import { getGameInstanceById, getScheduleTaskById, updateScheduleTask, type DbScheduledTask } from '../../shared/db'
import { emitPanelEvent } from '../notify/events'
import { executeScheduleAction, type ScheduleActionResult } from './schedule-actions'
import { computeNextRunAtIso } from './next-run'

const runningTaskIds = new Set<string>()
export function isScheduleTaskRunning(taskId: string): boolean { return runningTaskIds.has(taskId) }

export async function notifyScheduledUpdateFailure(task: DbScheduledTask, message: string): Promise<void> {
  const instance = await getGameInstanceById(task.instanceId)
  emitPanelEvent({
    type: 'scheduled_update_failed', subjectId: task.instanceId, subjectName: instance?.name ?? task.instanceId,
    message: `实例「${instance?.name ?? task.instanceId}」定时更新失败：${message}`,
    severity: 'critical', at: new Date().toISOString(), occurrenceKey: `${task.id}:${task.lastRunAt}`,
  })
}

/** 定时与手动入口共同抢占任务，先落执行中再返回受理结果。 */
export async function startScheduleTask(app: FastifyInstance, task: DbScheduledTask): Promise<
  { completion: Promise<ScheduleActionResult>, error?: never } | { error: string, completion?: never }
> {
  if (runningTaskIds.has(task.id)) return { error: '任务正在执行，请勿重复触发' }
  runningTaskIds.add(task.id)
  try {
    const latest = await getScheduleTaskById(task.id)
    if (!latest?.enabled) { runningTaskIds.delete(task.id); return { error: '任务已停用或删除' } }
    const lastRunAt = new Date().toISOString()
    const executing = { ...latest, lastRunAt }
    const nextRunAt = computeNextRunAtIso(latest.scheduleType, latest.scheduleValue, new Date(), latest.scheduleTz)
    await updateScheduleTask(task.id, { lastRunAt, lastRunStatus: 'running', lastRunMessage: '执行中…', nextRunAt })
    const completion = Promise.resolve().then(async (): Promise<ScheduleActionResult> => {
      let result: ScheduleActionResult
      try { result = await executeScheduleAction(app, executing) }
      catch (error) {
        result = { status: 'failed', message: `执行异常：${error instanceof Error ? error.message : String(error)}`,
          ...(latest.kind === 'update' ? { disableTask: true } : {}) }
      }
      await updateScheduleTask(task.id, {
        lastRunAt, lastRunStatus: result.status, lastRunMessage: result.message,
        ...(result.disableTask ? { enabled: false, nextRunAt: null } : {}),
      })
      if (latest.kind === 'update' && result.status === 'failed') await notifyScheduledUpdateFailure(executing, result.message)
      app.log.info({ taskId: task.id, kind: latest.kind, instanceId: latest.instanceId, ...result }, '计划任务执行完成')
      return result
    }).finally(() => { runningTaskIds.delete(task.id) })
    // 异步入口不能留下无人处理的拒绝；调用方仍可 await 同一 completion 获取错误。
    void completion.catch(error => app.log.error({ taskId: task.id, err: error }, '计划任务执行流程异常'))
    return { completion }
  }
  catch (error) { runningTaskIds.delete(task.id); throw error }
}
