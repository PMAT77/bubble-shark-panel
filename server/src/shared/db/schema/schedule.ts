import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * 实例计划任务（单机定时动作）。
 * Community 核心承诺的「单机实例定时重启/备份/定时更新/数据库快照」。
 */
export const scheduledTasks = sqliteTable('scheduled_tasks', {
  id: text('id').primaryKey(),
  instanceId: text('instance_id').notNull(),
  /** 任务类型：restart/backup/update/db_snapshot */
  kind: text('kind').notNull(),
  /** 调度类型：interval=每 N 小时；daily=每日 HH:MM */
  scheduleType: text('schedule_type').notNull(),
  /** daily 任务时区：beijing=北京时间（固定 UTC+8）；server=面板进程本地时区。interval 忽略 */
  scheduleTz: text('schedule_tz').notNull().default('beijing'),
  /** interval 存小时数字符串（1-168）；daily 存 HH:MM */
  scheduleValue: text('schedule_value').notNull(),
  enabled: integer('enabled').notNull().default(1),
  lastRunAt: text('last_run_at'),
  /** ok / failed / skipped（互斥守卫跳过或错过的任务） */
  lastRunStatus: text('last_run_status'),
  lastRunMessage: text('last_run_message'),
  /** 下次执行时间（ISO 字符串，持久化以支持面板重启后恢复调度相位） */
  nextRunAt: text('next_run_at'),
  createdBy: text('created_by').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})
