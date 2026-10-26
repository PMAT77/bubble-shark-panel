import { z } from 'zod'

/** 任务类型：定时重启 / 定时备份 / 定时更新 / 数据库快照 */
export const scheduleTaskKindSchema = z.enum(['restart', 'backup', 'update', 'db_snapshot'])
export type ScheduleTaskKind = z.infer<typeof scheduleTaskKindSchema>

/** 调度类型：interval=每 N 小时；daily=每日固定时刻 */
export const scheduleTypeSchema = z.enum(['interval', 'daily'])
export type ScheduleType = z.infer<typeof scheduleTypeSchema>

/** daily 任务时区：beijing=北京时间（固定 UTC+8）；server=面板进程本地时区 */
export const scheduleTimezoneSchema = z.enum(['beijing', 'server'])
export type ScheduleTimezone = z.infer<typeof scheduleTimezoneSchema>

/** 最近一次执行状态：执行中 / 成功 / 失败 / 跳过（互斥守卫或错过补跑策略） */
export const scheduleRunStatusSchema = z.enum(['running', 'ok', 'failed', 'skipped'])
export type ScheduleRunStatus = z.infer<typeof scheduleRunStatusSchema>

const intervalValueSchema = z.string().trim().regex(/^(?:[1-9]|1[0-6][0-8])$/, 'interval 必须为 1-168 的整数小时')
const dailyValueSchema = z.string().trim().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'daily 必须为 HH:MM（服务器本地时区）')

export const scheduleCreateRequestSchema = z
  .object({
    /** db_snapshot 任务使用哨兵值 panel-db（与备份表数据库快照一致） */
    instanceId: z.string().trim().min(1).max(128),
    kind: scheduleTaskKindSchema,
    scheduleType: scheduleTypeSchema,
    scheduleValue: z.string().trim().min(1).max(5),
    /** daily 任务执行时区；interval 忽略。默认北京时间 */
    scheduleTimezone: scheduleTimezoneSchema.default('beijing'),
  })
  .superRefine((value, ctx) => {
    if (value.scheduleType === 'interval') {
      const parsed = intervalValueSchema.safeParse(value.scheduleValue)
      if (!parsed.success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scheduleValue'], message: 'interval 必须为 1-168 的整数小时' })
      }
      return
    }
    const parsed = dailyValueSchema.safeParse(value.scheduleValue)
    if (!parsed.success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scheduleValue'], message: 'daily 必须为 HH:MM 格式（如 04:30）' })
    }
  })
export type ScheduleCreateRequest = z.infer<typeof scheduleCreateRequestSchema>

export const scheduleUpdateRequestSchema = z
  .object({
    taskId: z.string().trim().min(1).max(128),
    scheduleType: scheduleTypeSchema.optional(),
    scheduleValue: z.string().trim().min(1).max(5).optional(),
    scheduleTimezone: scheduleTimezoneSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    // 仅当 type 与 value 同时给出时才做组合格式校验；
    // 只改 value 时依赖服务端按任务现有 type 复核（避免误拒另一类型的合法值）
    if (value.scheduleValue === undefined || value.scheduleType === undefined) {
      return
    }
    const schema = value.scheduleType === 'daily' ? dailyValueSchema : intervalValueSchema
    if (!schema.safeParse(value.scheduleValue).success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scheduleValue'], message: value.scheduleType === 'daily' ? 'daily 必须为 HH:MM 格式' : 'interval 必须为 1-168 的整数小时' })
    }
  })
export type ScheduleUpdateRequest = z.infer<typeof scheduleUpdateRequestSchema>

export const scheduleTaskIdRequestSchema = z.object({
  taskId: z.string().trim().min(1).max(128),
})
export type ScheduleTaskIdRequest = z.infer<typeof scheduleTaskIdRequestSchema>

export const scheduleListRequestSchema = z.object({
  instanceId: z.string().trim().min(1).max(128).optional(),
})
export type ScheduleListRequest = z.infer<typeof scheduleListRequestSchema>

export const scheduleTaskItemSchema = z.object({
  id: z.string(),
  instanceId: z.string(),
  kind: scheduleTaskKindSchema,
  scheduleType: scheduleTypeSchema,
  scheduleValue: z.string(),
  scheduleTimezone: scheduleTimezoneSchema,
  enabled: z.boolean(),
  lastRunAt: z.string().nullable(),
  lastRunStatus: scheduleRunStatusSchema.nullable(),
  lastRunMessage: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
})
export type ScheduleTaskItem = z.infer<typeof scheduleTaskItemSchema>

export const scheduleMutationResultSchema = z.object({
  isSuccess: z.boolean(),
  taskId: z.string().optional(),
})
export type ScheduleMutationResult = z.infer<typeof scheduleMutationResultSchema>

export const scheduleRunNowResultSchema = z.object({
  /** 任务动作已触发；异步执行时 true 表示已受理 */
  triggered: z.boolean(),
  message: z.string().optional(),
})
export type ScheduleRunNowResult = z.infer<typeof scheduleRunNowResultSchema>
