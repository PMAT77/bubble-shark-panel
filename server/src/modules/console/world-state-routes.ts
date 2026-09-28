import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ApiErrorResponse, ApiSuccessResponse } from '../../../../shared/contracts/api'
import type { InstanceWorldStateDto } from '../../../../shared/contracts/instance'
import { instanceWorldStateQuerySchema } from '../../../../shared/contracts/instance'
import { getGameInstanceById } from '../../shared/db/index'
import { instanceConsoleLogStore } from '../../shared/instance-runtime/console-log-store'
import {
  ensureContainerRuntimeReady,
  isCavesContainerRunning,
  isInstanceContainerRunning,
  sendInstanceContainerCommand,
} from '../instance/container-lifecycle'
import { businessError, success } from '../../shared/http/response'
import { authorizeInstance } from '../system/auth'
import { buildWorldStateQueryCommand, parseWorldStateLogLine } from './world-state-parser'

const LOCAL_NODE_ID = 'local-node'

/** 指令送达后等待游戏输出的轮询参数 */
const POLL_INTERVAL_MS = 250
const POLL_MAX_ATTEMPTS = 16

async function resolveRunningInstance(instanceId: string, request: FastifyRequest) {
  if (!instanceId) {
    return { ok: false as const, error: businessError('实例 ID 不能为空', request) }
  }
  const instance = await getGameInstanceById(instanceId)
  if (!instance) {
    return { ok: false as const, error: businessError('实例不存在', request) }
  }
  if (instance.nodeId !== LOCAL_NODE_ID) {
    return { ok: false as const, error: businessError('当前仅支持本地节点实例世界状态查询', request) }
  }
  if (instance.status !== 'running') {
    return { ok: false as const, error: businessError('实例未运行，无法查询世界状态', request) }
  }
  return { ok: true as const, instance }
}

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}

/**
 * 世界运行时状态查询（游戏天数 / 季节）。
 *
 * 通过控制台指令注入 + 日志标记回读实现：向目标分片发送 print 指令，
 * 在日志流中定位 GSHWS: 标记行并解析。仅实例运行时可用。
 */
export function registerWorldStateRoutes(app: FastifyInstance) {
  app.get('/app/instance/world-state', async (request): Promise<ApiSuccessResponse<InstanceWorldStateDto> | ApiErrorResponse> => {
    const query = instanceWorldStateQuerySchema.safeParse(request.query)
    if (!query.success) {
      return businessError('请求参数无效', request)
    }
    const { instanceId, shard } = query.data
    /**
     * 这个接口名为"读世界状态"，实际会向运行中的游戏下发一条 `print` 指令，
     * 所以它同时需要读权限与实例授权，不能被当成纯查询放行。
     */
    const authorized = await authorizeInstance(request, instanceId, 'instance.console:read')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveRunningInstance(instanceId, request)
    if (!resolved.ok) {
      return resolved.error
    }
    if (shard === 'caves') {
      const cavesRunning = await isCavesContainerRunning(instanceId)
      if (!cavesRunning) {
        return businessError('洞穴未运行，无法查询洞穴世界状态', request)
      }
    }
    else {
      const masterRunning = await isInstanceContainerRunning(instanceId)
      if (!masterRunning) {
        return businessError('主世界未运行，无法查询世界状态', request)
      }
    }
    const runtimeReady = await ensureContainerRuntimeReady()
    if (!runtimeReady.ok) {
      return businessError(runtimeReady.message ?? '容器运行时未就绪', request)
    }

    const afterId = instanceConsoleLogStore.listLogs(instanceId).at(-1)?.id ?? 0
    const sendResult = await sendInstanceContainerCommand(instanceId, buildWorldStateQueryCommand(), shard)
    if (!sendResult.ok) {
      return businessError(sendResult.message ?? '世界状态查询指令发送失败', request)
    }

    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
      await sleep(POLL_INTERVAL_MS)
      const lines = instanceConsoleLogStore.listLogs(instanceId, afterId)
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i]!
        if (line.stream !== 'stdout') {
          continue
        }
        if (line.shard != null && line.shard !== shard) {
          continue
        }
        const parsed = parseWorldStateLogLine(line.text)
        if (parsed) {
          return success({
            instanceId,
            available: true,
            cycles: parsed.cycles,
            season: parsed.season,
            daysInSeason: parsed.daysInSeason,
          }, request)
        }
      }
    }

    return success({
      instanceId,
      available: false,
      cycles: null,
      season: null,
      daysInSeason: null,
      message: '暂未获取到世界状态，请稍后重试',
    }, request)
  })
}
