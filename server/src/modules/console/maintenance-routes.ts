import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ApiErrorResponse, ApiSuccessResponse } from '../../../../shared/contracts/api'
import type {
  InstanceMaintenanceAnnounceStateDto,
  InstanceMaintenancePushResultDto,
} from '../../../../shared/contracts/maintenance'
import {
  maintenanceDraftPayloadSchema,
  maintenanceInstanceQuerySchema,
  maintenancePushPayloadSchema,
} from '../../../../shared/contracts/maintenance'
import {
  getGameInstanceById,
  getMaintenanceDraft,
  insertMaintenancePushLog,
  listMaintenancePushLogs,
  upsertMaintenanceDraft,
} from '../../shared/db/index'
import type { PermissionKey } from '../../../../shared/constants/permissions'
import {
  ensureContainerRuntimeReady,
  isInstanceContainerRunning,
  sendInstanceContainerCommand,
} from '../instance/container-lifecycle'
import { businessError, success } from '../../shared/http/response'
import {
  buildMaintenanceAnnounceCommand,
  normalizeMaintenanceMessage,
  validateMaintenanceMessage,
} from './maintenance-announce'
import { toMaintenanceAnnounceStateDto, toMaintenancePushLogDto } from './maintenance-mapper'
import { authorizeInstance } from '../system/auth'

const LOCAL_NODE_ID = 'local-node'

/**
 * 维护公告的鉴权。
 *
 * `allowQueryToken` 是这三个接口特有的：公告里的图片与链接由浏览器直接发起请求，
 * 带不上自定义头，只能把令牌放进查询参数。例外仅限这三条，别扩散到别的接口。
 */
async function verifyAuthorizedUser(
  request: FastifyRequest,
  instanceId: string,
  permission: PermissionKey,
) {
  const authorized = await authorizeInstance(request, instanceId, permission, { allowQueryToken: true })
  if (authorized.error || !authorized.context) {
    return { error: authorized.error as ApiErrorResponse }
  }
  return { user: authorized.context.user }
}

async function resolveLocalInstance(instanceId: string, request: FastifyRequest) {
  if (!instanceId) {
    return { ok: false as const, error: businessError('实例 ID 不能为空', request) }
  }
  const instance = await getGameInstanceById(instanceId)
  if (!instance) {
    return { ok: false as const, error: businessError('实例不存在', request) }
  }
  if (instance.nodeId !== LOCAL_NODE_ID) {
    return { ok: false as const, error: businessError('当前仅支持本地节点实例维护公告', request) }
  }
  return { ok: true as const, instance }
}

export function registerMaintenanceAnnounceRoutes(app: FastifyInstance) {
  app.get('/app/instance/maintenance/announce', async (request): Promise<ApiSuccessResponse<InstanceMaintenanceAnnounceStateDto> | ApiErrorResponse> => {
    const parsedQuery = maintenanceInstanceQuerySchema.safeParse(request.query)
    if (!parsedQuery.success) {
      return businessError('请求参数无效', request)
    }
    const instanceId = parsedQuery.data.instanceId
    const auth = await verifyAuthorizedUser(request, instanceId, 'instance.console:read')
    if (auth.error) {
      return auth.error
    }
    const resolved = await resolveLocalInstance(instanceId, request)
    if (!resolved.ok) {
      return resolved.error
    }
    const draft = await getMaintenanceDraft(instanceId)
    const recentPushes = await listMaintenancePushLogs(instanceId)
    return success(toMaintenanceAnnounceStateDto(draft, recentPushes), request)
  })

  app.put('/app/instance/maintenance/announce', async (request): Promise<ApiSuccessResponse<InstanceMaintenanceAnnounceStateDto> | ApiErrorResponse> => {
    const parsedBody = maintenanceDraftPayloadSchema.safeParse(request.body ?? {})
    if (!parsedBody.success) {
      return businessError('请求参数无效', request)
    }
    const instanceId = parsedBody.data.instanceId
    const auth = await verifyAuthorizedUser(request, instanceId, 'maintenance:write')
    if (auth.error) {
      return auth.error
    }
    const message = normalizeMaintenanceMessage(parsedBody.data.message)
    const validationError = validateMaintenanceMessage(message)
    if (validationError) {
      return businessError(validationError, request)
    }
    const resolved = await resolveLocalInstance(instanceId, request)
    if (!resolved.ok) {
      return resolved.error
    }
    const draft = await upsertMaintenanceDraft(instanceId, message)
    const recentPushes = await listMaintenancePushLogs(instanceId)
    return success(toMaintenanceAnnounceStateDto(draft, recentPushes), request)
  })

  app.post('/app/instance/maintenance/announce/push', async (request): Promise<ApiSuccessResponse<InstanceMaintenancePushResultDto> | ApiErrorResponse> => {
    const parsedBody = maintenancePushPayloadSchema.safeParse(request.body ?? {})
    if (!parsedBody.success) {
      return businessError('请求参数无效', request)
    }
    const instanceId = parsedBody.data.instanceId
    const auth = await verifyAuthorizedUser(request, instanceId, 'maintenance:write')
    if (auth.error || !auth.user) {
      return auth.error!
    }
    const resolved = await resolveLocalInstance(instanceId, request)
    if (!resolved.ok) {
      return resolved.error
    }
    const instance = resolved.instance
    if (instance.status !== 'running') {
      return businessError('实例未运行，无法推送维护公告', request)
    }
    const masterRunning = await isInstanceContainerRunning(instanceId)
    if (!masterRunning) {
      return businessError('主世界未运行，无法推送维护公告', request)
    }

    const bodyMessage = normalizeMaintenanceMessage(parsedBody.data.message)
    const draft = await getMaintenanceDraft(instanceId)
    const message = bodyMessage || draft?.message?.trim() || ''
    const validationError = validateMaintenanceMessage(message)
    if (validationError) {
      return businessError(validationError, request)
    }

    const runtimeReady = await ensureContainerRuntimeReady()
    if (!runtimeReady.ok) {
      return businessError(runtimeReady.message ?? '容器运行时未就绪', request)
    }

    let command: string
    try {
      command = buildMaintenanceAnnounceCommand(message)
    }
    catch (error) {
      const msg = error instanceof Error ? error.message : '公告内容无效'
      return businessError(msg, request)
    }

    const result = await sendInstanceContainerCommand(instanceId, command, 'master')
    const pushLog = await insertMaintenancePushLog({
      instanceId,
      message,
      operatorAccount: auth.user.account,
      status: result.ok ? 'success' : 'failed',
      errorMessage: result.ok ? null : (result.message ?? '推送失败'),
    })

    if (bodyMessage) {
      await upsertMaintenanceDraft(instanceId, message)
    }

    return success({
      isSuccess: result.ok,
      pushLog: toMaintenancePushLogDto(pushLog),
      ...(result.ok ? {} : { errorMessage: result.message ?? '推送失败' }),
    }, request)
  })
}
