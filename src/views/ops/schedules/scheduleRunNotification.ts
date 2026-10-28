import type { ScheduleTaskItem } from '@/api/modules/schedule'

/** 面板数据库哨兵实例 id（与后端 DB_BACKUP_INSTANCE_ID 一致） */
const PANEL_DB_INSTANCE_ID = 'panel-db'

export const SCHEDULE_KIND_LABELS: Record<ScheduleTaskItem['kind'], string> = {
  restart: '定时重启',
  backup: '定时备份',
  update: '定时更新',
  db_snapshot: '面板快照',
}

export const SCHEDULE_STATUS_LABELS: Record<NonNullable<ScheduleTaskItem['lastRunStatus']>, string> = {
  running: '执行中',
  ok: '成功',
  failed: '失败',
  skipped: '跳过',
}

export interface ScheduleTriggerNotice {
  taskId: string
  level: 'success' | 'error' | 'warning' | 'info'
  title: string
  content: string
  durationMs: number
  /** 定时更新最终失败不能被页面的「立即执行」提示抑制。 */
  mustNotify?: boolean
}

/** 普通任务记录触发时刻；定时更新另带状态，以捕获同轮最终失败。 */
export type ScheduleRunBaseline = Map<string, string | null>

export function defaultScheduleTargetName(instanceId: string): string {
  return instanceId === PANEL_DB_INSTANCE_ID ? '面板数据库' : instanceId
}

function noticeLevel(status: NonNullable<ScheduleTaskItem['lastRunStatus']>): ScheduleTriggerNotice['level'] {
  if (status === 'failed') {
    return 'error'
  }
  if (status === 'skipped') {
    return 'warning'
  }
  return status === 'running' ? 'info' : 'success'
}

/** 单条通知文案（任务类型 + 目标 + 状态/结果） */
export function buildScheduleTriggerNotice(task: ScheduleTaskItem, targetName: string): ScheduleTriggerNotice {
  const status = task.lastRunStatus ?? 'ok'
  const detail = task.lastRunMessage?.trim() ? ` · ${task.lastRunMessage}` : ''
  return {
    taskId: task.id,
    level: noticeLevel(status),
    title: task.kind === 'update' && status === 'failed' ? '定时更新失败' : '计划任务已触发',
    content: `${SCHEDULE_KIND_LABELS[task.kind]}｜${targetName}：${SCHEDULE_STATUS_LABELS[status]}${detail}`,
    durationMs: task.kind === 'update' && status === 'failed' ? 0 : status === 'failed' ? 8000 : 6000,
    ...(task.kind === 'update' && status === 'failed' ? { mustNotify: true } : {}),
  }
}

/**
 * 依据上一次基线找出「新触发」的任务：某任务的 lastRunAt 相对基线出现了新值。
 * 传空基线时为首次采集（只建立基线，不产生通知）。
 * 定时更新还识别同轮 running→failed；首次采集也提示尚未处理的失败。
 */
export function collectScheduleTriggerNotices(
  previous: ReadonlyMap<string, string | null>,
  tasks: ScheduleTaskItem[],
  resolveTargetName: (instanceId: string) => string = defaultScheduleTargetName,
): { notices: ScheduleTriggerNotice[], baseline: ScheduleRunBaseline } {
  const notices: ScheduleTriggerNotice[] = []
  const baseline: ScheduleRunBaseline = new Map()
  for (const task of tasks) {
    const lastRunAt = task.lastRunAt ?? null
    const previousRunAt = previous.get(task.id) ?? null
    const key = task.kind === 'update' && lastRunAt ? `${lastRunAt}|${task.lastRunStatus}` : lastRunAt
    const failedUpdate = task.kind === 'update' && task.lastRunStatus === 'failed' && !task.enabled
    const changed = previous.has(task.id) && lastRunAt !== null && key !== previousRunAt
    const newRun = task.kind !== 'update' || !previousRunAt?.startsWith(`${lastRunAt}|`)
    if ((changed && (newRun || failedUpdate)) || (!previous.has(task.id) && failedUpdate)) {
      notices.push(buildScheduleTriggerNotice(task, resolveTargetName(task.instanceId)))
    }
    baseline.set(task.id, key)
  }
  return { notices, baseline }
}

export function consumeScheduleNoticeSuppression(notice: ScheduleTriggerNotice, suppressed: Set<string>): boolean {
  const wasSuppressed = suppressed.delete(notice.taskId)
  return wasSuppressed && !notice.mustNotify
}

/** 按账号记住已提示的更新失败；刷新后去重，新的执行仍会提醒。 */
export function createScheduleRunNoticeTracker(storage?: Pick<Storage, 'getItem' | 'setItem'>) {
  let baseline: ScheduleRunBaseline = new Map()
  let currentAccount: string | undefined
  return {
    collect(account: string, tasks: ScheduleTaskItem[], resolveTargetName = defaultScheduleTargetName): ScheduleTriggerNotice[] {
      if (currentAccount !== account) {
        baseline = new Map()
        currentAccount = account
      }
      const result = collectScheduleTriggerNotices(baseline, tasks, resolveTargetName)
      baseline = result.baseline
      return result.notices.filter((notice) => {
        if (!notice.mustNotify) return true
        const storageKey = `bsp-schedule-update-failure:${JSON.stringify([account, notice.taskId])}`
        const runKey = baseline.get(notice.taskId) ?? 'failed'
        try {
          if (storage?.getItem(storageKey) === runKey) return false
          storage?.setItem(storageKey, runKey)
        }
        catch { /* 存储不可用时，内存基线仍可避免重复轮询通知。 */ }
        return true
      })
    },
  }
}
