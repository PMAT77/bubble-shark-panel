import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ApiErrorResponse, ApiSuccessResponse } from '../../../../shared/contracts/api'
import { ErrorCode } from '../../../../shared/constants/error-code'
import { normalizeRequestToken } from '../../shared/http/token'
import { LOCAL_NODE_ID } from '../../shared/dst/local-dst-instance'
import { getGameInstanceById } from '../../shared/db/index'
import { businessError, success } from '../../shared/http/response'
import {
  ensureContainerRuntimeReady,
  stopInstanceContainer,
} from './container-lifecycle'
import {
  isInstallJobActive,
} from './install-service'

export interface RestartInstanceCoreOptions {
  autoAllocatePorts?: boolean
  /** 为 false 时跳过鉴权（调用方已校验） */
  skipAuth?: boolean
}

async function requireContainerRuntime(request: FastifyRequest): Promise<ApiErrorResponse | undefined> {
  const runtimeReady = await ensureContainerRuntimeReady()
  if (!runtimeReady.ok) {
    return businessError(runtimeReady.message ?? '游戏运行时未就绪', request)
  }
  return undefined
}

/**
 * 停止运行中容器并通过 start 路由逻辑重新启动（与 POST /app/instance/restart 等价）。
 */
export async function restartInstanceCore(
  app: FastifyInstance,
  request: FastifyRequest,
  instanceId: string,
  options?: RestartInstanceCoreOptions,
): Promise<ApiSuccessResponse<{ isSuccess: boolean }> | ApiErrorResponse> {
  const id = instanceId.trim()
  if (!id) {
    return businessError('实例 ID 不能为空', request)
  }
  const current = await getGameInstanceById(id)
  if (!current) {
    return businessError('实例不存在', request)
  }
  if (current.nodeId !== LOCAL_NODE_ID) {
    return businessError('当前仅支持本地节点执行实例命令', request)
  }
  const runtimeError = await requireContainerRuntime(request)
  if (runtimeError) {
    return runtimeError
  }
  if (current.status === 'pending_install' || current.status === 'installing' || isInstallJobActive(id)) {
    return businessError('实例正在安装中，请稍后再试', request)
  }
  if (current.status === 'running' || current.containerId) {
    try {
      await stopInstanceContainer(id)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : '重启时停止实例失败'
      const { updateGameInstanceRuntime } = await import('../../shared/db/index')
      await updateGameInstanceRuntime(id, {
        status: 'error',
        lastError: message,
        lastErrorPhase: 'runtime',
      })
      return businessError(message, request)
    }
  }
  const response = await app.inject({
    method: 'POST',
    url: '/app/instance/start',
    headers: {
      token: normalizeRequestToken(request.headers.token),
    },
    payload: {
      id,
      autoAllocatePorts: options?.autoAllocatePorts === true,
    },
  })
  if (response.statusCode >= 400) {
    return businessError('实例重启失败', request)
  }
  const payload = JSON.parse(response.body) as ApiSuccessResponse<{ isSuccess: boolean }> | ApiErrorResponse
  if ('error' in payload && payload.error) {
    return businessError(
      payload.error,
      request,
      payload.code ?? ErrorCode.BUSINESS_RULE_VIOLATION,
      payload.data ?? {},
    )
  }
  return success({ isSuccess: true }, request)
}
