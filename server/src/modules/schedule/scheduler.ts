import { readBrandEnv } from '../../../../shared/brand-env'
import type { FastifyInstance } from 'fastify'
import {
  listDueScheduleTasks,
  listScheduleTasks,
  updateScheduleTask,
} from '../../shared/db/index'
import type { DbScheduledTask } from '../../shared/db/index'
import { computeNextRunAtIso } from './next-run'
import { executeScheduleAction } from './schedule-actions'

const TICK_INTERVAL_MS = 30_000

let tickTimer: NodeJS.Timeout | null = null
let schedulerStarted = false
let tickInFlight = false
/** 单进程内防同任务重入（执行中的任务不会被下一次 tick 重复捞取） */
const inFlightTaskIds = new Set<string>()

function isUnitTest(): boolean {
  return readBrandEnv('BSP_UNIT_TEST') === '1'
}

/**
 * 面板启动时的恢复，覆盖全部任务（含已停用，避免残留的「执行中」卡死）：
 * - 上次进程中断留下的 last_run_status='running' 标记为 failed（执行中崩溃不会永久停在执行中）；
 * - enabled 且 next_run_at 已过期的任务不补跑，顺延到下一周期并记录 skipped
 *   （凌晨定时重启在面板离线后补跑反而危险）。
 */
export async function recoverMissedTasksOnBoot(app: FastifyInstance): Promise<void> {
  const tasks = await listScheduleTasks()
  const now = new Date()
  for (const task of tasks) {
    const wasRunning = task.lastRunStatus === 'running'
    const dueAt = task.nextRunAt ? Date.parse(task.nextRunAt) : Number.NaN
    const missed = !(Number.isFinite(dueAt) && dueAt > now.getTime())
    if (!wasRunning && !missed) {
      continue
    }
    const nextRunAt = missed
      ? computeNextRunAtIso(task.scheduleType, task.scheduleValue, now, task.scheduleTz)
      : null
    if (missed && nextRunAt === null && !wasRunning) {
      app.log.warn({ taskId: task.id, scheduleValue: task.scheduleValue }, '计划任务 scheduleValue 非法，无法恢复调度；请修正或删除该任务')
      continue
    }
    if (wasRunning) {
      // 保留真实的触发时刻（lastRunAt），只覆盖中断的状态
      await updateScheduleTask(task.id, {
        lastRunStatus: 'failed',
        lastRunMessage: '面板重启导致上次执行中断',
        ...(nextRunAt === null ? {} : { nextRunAt }),
      })
      app.log.warn({ taskId: task.id, kind: task.kind }, '计划任务上次执行被面板重启中断，已标记失败')
      continue
    }
    await updateScheduleTask(task.id, {
      lastRunAt: task.nextRunAt,
      lastRunStatus: 'skipped',
      lastRunMessage: '面板离线期间错过执行，已顺延至下一周期',
      nextRunAt,
    })
    app.log.info({ taskId: task.id, kind: task.kind, nextRunAt }, '计划任务错过执行已顺延')
  }
}

async function runDueTask(app: FastifyInstance, task: DbScheduledTask): Promise<void> {
  const now = new Date()
  // 先推进 next_run_at 再执行：执行中崩溃也不会在重启后立即重复执行同一到期任务。
  // 同时把最近执行置为执行中，供面板列表展示（终态写回时复用同一个 lastRunAt 触发时刻）。
  const nextRunAt = computeNextRunAtIso(task.scheduleType, task.scheduleValue, now, task.scheduleTz)
  await updateScheduleTask(task.id, {
    ...(nextRunAt === null ? {} : { nextRunAt }),
    lastRunAt: now.toISOString(),
    lastRunStatus: 'running',
    lastRunMessage: '执行中…',
  })

  let result
  try {
    result = await executeScheduleAction(app, task)
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    result = { status: 'failed' as const, message: `执行异常: ${message}` }
  }

  await updateScheduleTask(task.id, {
    lastRunAt: now.toISOString(),
    lastRunStatus: result.status,
    lastRunMessage: result.message,
  })
  app.log.info({
    taskId: task.id,
    kind: task.kind,
    instanceId: task.instanceId,
    status: result.status,
    message: result.message,
    nextRunAt,
  }, '计划任务执行完成')
}

async function tick(app: FastifyInstance): Promise<void> {
  if (tickInFlight) {
    return
  }
  tickInFlight = true
  try {
    const due = await listDueScheduleTasks(new Date().toISOString())
    for (const task of due) {
      if (inFlightTaskIds.has(task.id)) {
        continue
      }
      inFlightTaskIds.add(task.id)
      void runDueTask(app, task)
        .catch(error => app.log.error({ taskId: task.id, err: error }, '计划任务执行流程异常'))
        .finally(() => inFlightTaskIds.delete(task.id))
    }
  }
  catch (error) {
    app.log.error({ err: error }, '计划任务调度 tick 失败')
  }
  finally {
    tickInFlight = false
  }
}

/** 启动调度循环（幂等；单元测试环境不自动启动） */
export function startScheduleScheduler(app: FastifyInstance): void {
  if (schedulerStarted || isUnitTest()) {
    return
  }
  schedulerStarted = true
  void recoverMissedTasksOnBoot(app).catch(error => app.log.error({ err: error }, '计划任务启动恢复失败'))
  tickTimer = setInterval(() => void tick(app), TICK_INTERVAL_MS)
  if (typeof tickTimer === 'object' && 'unref' in tickTimer && typeof tickTimer.unref === 'function') {
    tickTimer.unref()
  }
  app.log.info({ tickIntervalMs: TICK_INTERVAL_MS }, '计划任务调度器已启动')
}

export function stopScheduleScheduler(): void {
  if (tickTimer) {
    clearTimeout(tickTimer)
    tickTimer = null
  }
  schedulerStarted = false
}

export function isScheduleSchedulerStarted(): boolean {
  return schedulerStarted
}
