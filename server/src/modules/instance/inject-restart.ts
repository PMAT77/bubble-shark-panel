import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ApiErrorResponse } from '../../../../shared/contracts/api'
import { restartInstanceCore } from './restart-instance-core'

/** 经共享重启逻辑执行停止后启动，并透传端口冲突等结构化错误 */
export async function injectRestartInstance(
  app: FastifyInstance,
  request: FastifyRequest,
  instanceId: string,
  options?: { autoAllocatePorts?: boolean },
): Promise<ApiErrorResponse | undefined> {
  const result = await restartInstanceCore(app, request, instanceId, { ...options, source: 'automatic' })
  if ('error' in result && result.error) {
    return result
  }
  return undefined
}
