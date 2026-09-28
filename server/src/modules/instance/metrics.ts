import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ApiErrorResponse, ApiSuccessResponse } from '../../../../shared/contracts/api'
import { instanceIdsBodySchema } from '../../../../shared/contracts/instance'
import type {
  InstanceIdsBody,
  InstanceMetricsPayload,
  InstanceRuntimeMetrics,
} from '../../../../shared/contracts/instance'
import type { DbGameInstance } from '../../shared/db/index'
import {
  listGameInstances,
} from '../../shared/db/index'
import { getContainerRuntime } from '../../infra/container'
import { businessError, success } from '../../shared/http/response'
import { ensureContainerRuntimeReady, isInstanceContainerRunning, resolveInstanceContainerRef } from './container-lifecycle'
import { ErrorCode } from '../../../../shared/constants/error-code'
import { resolveInstanceScope } from '../system/auth'

const LOCAL_NODE_ID = 'local-node'

export type InstanceMetricsResponse = InstanceMetricsPayload

function computeUptimeSeconds(startedAt: string | null | undefined): number | null {
  if (!startedAt) {
    return null
  }
  const startedMs = Date.parse(startedAt)
  if (Number.isNaN(startedMs)) {
    return null
  }
  return Math.max(0, Math.floor((Date.now() - startedMs) / 1000))
}

async function collectMetricsForInstance(instance: DbGameInstance): Promise<InstanceRuntimeMetrics | null> {
  if (instance.status !== 'running' || instance.nodeId !== LOCAL_NODE_ID) {
    return null
  }
  if (!await isInstanceContainerRunning(instance.id)) {
    return null
  }
  const ref = await resolveInstanceContainerRef(instance.id)
  if (!ref) {
    return null
  }
  try {
    const runtime = getContainerRuntime()
    const stats = await runtime.stats(ref)
    return {
      cpuUsageRate: stats.cpuUsageRate,
      memoryMb: stats.memoryMb,
      uptimeSeconds: computeUptimeSeconds(instance.runtimeStartedAt),
    }
  }
  catch {
    return {
      cpuUsageRate: null,
      memoryMb: null,
      uptimeSeconds: computeUptimeSeconds(instance.runtimeStartedAt),
    }
  }
}

export async function handleInstanceMetrics(
  request: FastifyRequest,
  body: InstanceIdsBody,
): Promise<ApiSuccessResponse<InstanceMetricsResponse> | ApiErrorResponse> {
  const scope = await resolveInstanceScope(request, 'instance:read')
  if (scope.error || !scope.instanceIds) {
    return scope.error ?? businessError('无法确定可见实例范围', request)
  }
  const visibleInstanceIds = new Set(scope.instanceIds)

  const runtimeReady = await ensureContainerRuntimeReady()
  if (!runtimeReady.ok) {
    return businessError(runtimeReady.message ?? '游戏运行时未就绪', request)
  }

  const idFilter = new Set(
    (body.ids ?? [])
      .map(id => id?.trim())
      .filter((id): id is string => Boolean(id)),
  )
  const hasIdFilter = idFilter.size > 0

  if (hasIdFilter && [...idFilter].some(id => !visibleInstanceIds.has(id))) {
    // 与批量更新检查同一口径：不做部分执行，也不告诉调用方"哪几个 ID 是存在的"
    return businessError('没有该实例的访问权限', request, ErrorCode.FORBIDDEN)
  }

  const instances = await listGameInstances({ status: 'running' })
  const targets = instances.filter((item) => {
    if (item.nodeId !== LOCAL_NODE_ID) {
      return false
    }
    // 缺省（不传 ids）时此前是「本机全部运行中实例」，那会让只被授权两个实例的账号
    // 拿到别人实例的 CPU / 内存曲线。缺省范围改为「全部可见实例」。
    if (!visibleInstanceIds.has(item.id)) {
      return false
    }
    if (hasIdFilter && !idFilter.has(item.id)) {
      return false
    }
    return true
  })

  const collectedAt = new Date().toISOString()
  const items: Record<string, InstanceRuntimeMetrics | null> = {}

  if (hasIdFilter) {
    for (const id of idFilter) {
      items[id] = null
    }
  }

  await Promise.all(targets.map(async (instance) => {
    items[instance.id] = await collectMetricsForInstance(instance)
  }))

  return success({ items, collectedAt }, request)
}

export function registerInstanceMetricsRoute(app: FastifyInstance) {
  app.post('/app/instance/metrics', async (request) => {
    const body = instanceIdsBodySchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    return handleInstanceMetrics(request, body.data)
  })
}
