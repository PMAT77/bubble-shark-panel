import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ApiErrorResponse, ApiSuccessResponse } from '../../../../shared/contracts/api'
import type {
  ScheduleMutationResult,
  ScheduleRunNowResult,
  ScheduleTaskItem,
} from '../../../../shared/contracts/schedule'
import {
  scheduleCreateRequestSchema,
  scheduleListRequestSchema,
  scheduleTaskIdRequestSchema,
  scheduleUpdateRequestSchema,
} from '../../../../shared/contracts/schedule'
import type { PermissionKey } from '../../../../shared/constants/permissions'
import {
  countEnabledTasksByKind,
  createScheduleTask,
  deleteScheduleTask,
  getGameInstanceById,
  getScheduleTaskById,
  listScheduleTasks,
  newScheduleTaskId,
  updateScheduleTask,
} from '../../shared/db/index'
import type { DbScheduledTask } from '../../shared/db/index'
import { businessError, success } from '../../shared/http/response'
import { authorizeInstance, requirePermission, resolveAuthorizedContext, resolveInstanceScope } from '../system/auth'
import { DB_BACKUP_INSTANCE_ID } from '../system/db-snapshot-service'
import { computeNextRunAtIso, describeSchedule } from './next-run'
import { executeScheduleAction } from './schedule-actions'

function toTaskItem(task: DbScheduledTask): ScheduleTaskItem {
  return {
    id: task.id,
    instanceId: task.instanceId,
    kind: task.kind,
    scheduleType: task.scheduleType,
    scheduleValue: task.scheduleValue,
    scheduleTimezone: task.scheduleTz,
    enabled: task.enabled,
    lastRunAt: task.lastRunAt,
    lastRunStatus: task.lastRunStatus,
    lastRunMessage: task.lastRunMessage,
    nextRunAt: task.nextRunAt,
    createdBy: task.createdBy,
    createdAt: task.createdAt,
  }
}

interface ScheduleAuth {
  error?: ApiErrorResponse
  operatorAccount: string
}

async function authorize(
  request: FastifyRequest,
  permission: PermissionKey = 'schedule:write',
): Promise<ScheduleAuth> {
  const auth = await resolveAuthorizedContext(request, { permissions: permission })
  if (auth.error || !auth.context) {
    return { error: auth.error ?? businessError('登录状态失效，请重新登录', request), operatorAccount: '' }
  }
  return { operatorAccount: auth.context.user.account }
}

/**
 * 计划任务的实例归属校验。
 *
 * 计划任务分两种归属：绑定某个实例的（重启/备份/更新检查），以及**面板全局**的
 * 数据库快照——后者用哨兵实例 id 存在同一个表里，不属于任何实例，因此跳过实例授权，
 * 只要求 `schedule:write` 权限点。
 *
 * 三种调用形态都要过这里：create 用请求体里的实例 id；update / delete / run-now
 * 用**任务自身**的实例 id（先查任务再校验——只凭 taskId 执行是原先的越权缺口）。
 */
async function authorizeTaskInstance(
  request: FastifyRequest,
  instanceId: string,
  permission: PermissionKey = 'schedule:write',
): Promise<ApiErrorResponse | undefined> {
  if (instanceId === DB_BACKUP_INSTANCE_ID) {
    return requirePermission(request, permission)
  }
  const authorized = await authorizeInstance(request, instanceId, permission)
  return authorized.error
}

/**
 * schedule 模块：实例计划任务（定时重启/备份/更新检查/数据库快照）。
 * Community 核心承诺的单机定时动作；调度器随模块注册启动。
 */
export function registerScheduleModule(app: FastifyInstance) {
  app.post('/app/schedule/list', async (request): Promise<ApiSuccessResponse<ScheduleTaskItem[]> | ApiErrorResponse> => {
    const scope = await resolveInstanceScope(request, 'schedule:read')
    if (scope.error || !scope.instanceIds) {
      return scope.error ?? businessError('无法确定可见实例范围', request)
    }
    const body = scheduleListRequestSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const tasks = await listScheduleTasks(body.data.instanceId)
    // 数据库快照任务不属于任何实例（哨兵 id），不参与实例范围过滤
    const visible = new Set(scope.instanceIds)
    return success(
      tasks
        .filter(task => task.instanceId === DB_BACKUP_INSTANCE_ID || visible.has(task.instanceId))
        .map(toTaskItem),
      request,
    )
  })

  app.post('/app/schedule/create', async (request): Promise<ApiSuccessResponse<ScheduleMutationResult> | ApiErrorResponse> => {
    const auth = await authorize(request)
    if (auth.error) {
      return auth.error
    }
    const body = scheduleCreateRequestSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效：调度类型或值不合法', request)
    }
    const { kind, scheduleType, scheduleValue, scheduleTimezone } = body.data

    let instanceId = body.data.instanceId
    if (kind === 'db_snapshot') {
      // 数据库快照是面板全局任务，统一哨兵实例 id（与 backups 表数据库快照一致）
      instanceId = DB_BACKUP_INSTANCE_ID
      if (await countEnabledTasksByKind('db_snapshot') > 0) {
        return businessError('已存在启用中的数据库快照任务，请先停用后再创建', request)
      }
    }
    else {
      if (instanceId === DB_BACKUP_INSTANCE_ID) {
        return businessError('该任务类型必须绑定具体实例', request)
      }
      const authorized = await authorizeTaskInstance(request, instanceId)
      if (authorized) {
        return authorized
      }
      const instance = await getGameInstanceById(instanceId)
      if (!instance) {
        return businessError('实例不存在', request)
      }
    }

    const nextRunAt = computeNextRunAtIso(scheduleType, scheduleValue, new Date(), scheduleTimezone)
    if (nextRunAt === null) {
      return businessError('调度配置无效：interval 需为 1-168 整数小时，daily 需为 HH:MM', request)
    }

    const task = await createScheduleTask({
      id: newScheduleTaskId(),
      instanceId,
      kind,
      scheduleType,
      scheduleValue,
      scheduleTz: scheduleTimezone,
      enabled: true,
      nextRunAt,
      createdBy: auth.operatorAccount,
    })
    app.log.info({ taskId: task.id, kind, instanceId, schedule: describeSchedule(scheduleType, scheduleValue, scheduleTimezone) }, '计划任务已创建')
    return success({ isSuccess: true, taskId: task.id }, request)
  })

  app.post('/app/schedule/update', async (request): Promise<ApiSuccessResponse<ScheduleMutationResult> | ApiErrorResponse> => {
    const auth = await authorize(request)
    if (auth.error) {
      return auth.error
    }
    const body = scheduleUpdateRequestSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const task = await getScheduleTaskById(body.data.taskId)
    if (!task) {
      return businessError('计划任务不存在', request)
    }
    // 先查任务、再按**它自己的实例归属**校验：此前只凭 taskId 就改，
    // 等于任何持有该权限点的账号都能改别的实例的定时重启
    const authorized = await authorizeTaskInstance(request, task.instanceId)
    if (authorized) {
      return authorized
    }

    const finalType = body.data.scheduleType ?? task.scheduleType
    const finalValue = body.data.scheduleValue ?? task.scheduleValue
    const finalTz = body.data.scheduleTimezone ?? task.scheduleTz
    if (computeNextRunAtIso(finalType, finalValue, new Date(), finalTz) === null) {
      return businessError('调度配置无效：interval 需为 1-168 整数小时，daily 需为 HH:MM', request)
    }

    // 调度配置（含时区）变化或重新启用时重算 next_run_at，避免沿用过去的相位立即触发
    const scheduleChanged = finalType !== task.scheduleType || finalValue !== task.scheduleValue || finalTz !== task.scheduleTz
    const reenabled = body.data.enabled === true && !task.enabled
    const nextRunAt = scheduleChanged || reenabled || (body.data.enabled === false)
      ? computeNextRunAtIso(finalType, finalValue, new Date(), finalTz)
      : undefined

    const updated = await updateScheduleTask(task.id, {
      scheduleType: body.data.scheduleType,
      scheduleValue: body.data.scheduleValue,
      scheduleTz: body.data.scheduleTimezone,
      enabled: body.data.enabled,
      ...(nextRunAt === undefined ? {} : { nextRunAt }),
    })
    return success({ isSuccess: true, taskId: updated?.id ?? task.id }, request)
  })

  app.post('/app/schedule/delete', async (request): Promise<ApiSuccessResponse<ScheduleMutationResult> | ApiErrorResponse> => {
    const auth = await authorize(request)
    if (auth.error) {
      return auth.error
    }
    const body = scheduleTaskIdRequestSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const target = await getScheduleTaskById(body.data.taskId)
    if (!target) {
      return businessError('计划任务不存在', request)
    }
    const authorized = await authorizeTaskInstance(request, target.instanceId)
    if (authorized) {
      return authorized
    }
    const removed = await deleteScheduleTask(body.data.taskId)
    if (!removed) {
      return businessError('计划任务不存在', request)
    }
    return success({ isSuccess: true }, request)
  })

  app.post('/app/schedule/run-now', async (request): Promise<ApiSuccessResponse<ScheduleRunNowResult> | ApiErrorResponse> => {
    const auth = await authorize(request)
    if (auth.error) {
      return auth.error
    }
    const body = scheduleTaskIdRequestSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const task = await getScheduleTaskById(body.data.taskId)
    if (!task) {
      return businessError('计划任务不存在', request)
    }
    // 手动触发会真的跑一次动作（重启世界、建备份），所以同样按任务的实例归属校验
    const authorized = await authorizeTaskInstance(request, task.instanceId)
    if (authorized) {
      return authorized
    }
    if (!task.enabled) {
      return businessError('任务已停用，请先启用再执行', request)
    }

    // 与调度器一致：先置执行中，执行后写回 last_run_* 并顺延 next_run_at
    // （终态复用同一个触发时刻，便于前端把「一次触发」识别为一条通知）
    const startedAt = new Date()
    await updateScheduleTask(task.id, {
      lastRunAt: startedAt.toISOString(),
      lastRunStatus: 'running',
      lastRunMessage: '执行中…（手动触发）',
    })
    const result = await executeScheduleAction(app, task)
    await updateScheduleTask(task.id, {
      lastRunAt: startedAt.toISOString(),
      lastRunStatus: result.status,
      lastRunMessage: result.message,
      nextRunAt: computeNextRunAtIso(task.scheduleType, task.scheduleValue, new Date(), task.scheduleTz),
    })
    return success({ triggered: true, message: result.message }, request)
  })

  // 调度器不在此启动：本模块注册发生在 bootstrap 的数据库初始化之前，
  // 此刻执行启动恢复会因 SQLite 未就绪而失败（并导致错过的任务被 tick 补跑）。
  // 统一由 bootstrap 在 initDatabase 之后调用 startScheduleScheduler(app)。
}
