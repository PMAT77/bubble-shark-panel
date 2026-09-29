import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fs from 'node:fs'
import type { ApiErrorResponse, ApiSuccessResponse } from '../../../../shared/contracts/api'
import type {
  ConsoleLogHistoryDto,
  InstanceConnectInfoDto,
  InstanceConsoleLogsPayload,
  InstanceConsoleLogFilter,
  InstanceConsoleStreamTicketDto,
} from '../../../../shared/contracts/console'
import {
  consoleCommandBodySchema,
  consoleInstanceQuerySchema,
  consoleLogsQuerySchema,
  consoleStreamQuerySchema,
  consoleStreamTicketRequestSchema,
} from '../../../../shared/contracts/console'
import type { ConsoleLogLine } from '../../shared/instance-runtime/console-log-store'
import type { DbGameInstance } from '../../shared/db/index'
import { getGameInstanceById } from '../../shared/db/index'
import { DST_APP_ID } from '../../infra/game-adapter/dst/constants'
import { buildDstConnectInfo } from '../../infra/game-adapter/dst/direct-connect'
import { resolveInstanceInstallPath } from '../../infra/game-adapter/dst/cluster-service'
import { instanceConsoleLogStore } from '../../shared/instance-runtime/console-log-store'
import { getActiveConsoleLogFile } from '../../shared/instance-runtime/console-log-file'
import {
  ensureContainerRuntimeReady,
  isCavesContainerRunning,
  isInstanceContainerRunning,
  sendInstanceContainerCommand,
} from '../instance/container-lifecycle'
import { isCavesShardConfigured, readClusterShardEnabledFromInstall } from '../../infra/game-adapter/dst/shard-service'
import { sendFileDownload } from '../../shared/http/file-download'
import { businessError, success } from '../../shared/http/response'
import { authorizeInstance } from '../system/auth'
import { consoleStreamTicketStore } from './stream-ticket'

const LOCAL_NODE_ID = 'local-node'

type ResolveLocalInstanceResult =
  | { ok: false; error: ApiErrorResponse }
  | { ok: true; instance: DbGameInstance }

async function resolveLocalInstance(
  instanceId: string,
  request: FastifyRequest,
): Promise<ResolveLocalInstanceResult> {
  if (!instanceId) {
    return { ok: false, error: businessError('实例 ID 不能为空', request) }
  }
  const instance = await getGameInstanceById(instanceId)
  if (!instance) {
    return { ok: false, error: businessError('实例不存在', request) }
  }
  if (instance.nodeId !== LOCAL_NODE_ID) {
    return { ok: false, error: businessError('当前仅支持本地节点实例控制台', request) }
  }
  return { ok: true, instance }
}

function writeSse(reply: FastifyReply, event: string, data: unknown) {
  reply.raw.write(`event: ${event}\n`)
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)
}

function filterConsoleLines(lines: ConsoleLogLine[], filter: InstanceConsoleLogFilter): ConsoleLogLine[] {
  if (filter === 'all') {
    return lines
  }
  if (filter === 'game') {
    return lines.filter(line => line.stream === 'stdout' || line.stream === 'stderr')
  }
  return lines.filter(line => line.stream === 'system')
}

import { registerMaintenanceAnnounceRoutes } from './maintenance-routes'
import { registerWorldStateRoutes } from './world-state-routes'

/**
 * console 模块：游戏实例运行时控制台（日志流 + 命令下发）。
 * 与「主机监控台」`/console/monitor` 区分，API 统一挂在 `/app/instance/console/*`。
 */
export function registerConsoleModule(app: FastifyInstance) {
  app.get('/app/instance/connect-info', async (request): Promise<ApiSuccessResponse<InstanceConnectInfoDto> | ApiErrorResponse> => {
    const query = consoleInstanceQuerySchema.safeParse(request.query)
    if (!query.success) {
      return businessError('请求参数无效', request)
    }
    const instanceId = query.data.instanceId
    const authorized = await authorizeInstance(request, instanceId, 'instance.console:read')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveLocalInstance(instanceId, request)
    if (!resolved.ok) {
      return resolved.error
    }
    const instance = resolved.instance
    if (instance.gameCode.trim() !== DST_APP_ID) {
      return businessError('当前仅支持饥荒（343050）连接信息', request)
    }
    const installPath = resolveInstanceInstallPath(instance)
    const masterRunning = await isInstanceContainerRunning(instanceId)
    const shardEnabled = readClusterShardEnabledFromInstall(installPath)
    const cavesConfigured = shardEnabled && isCavesShardConfigured(installPath)
    const cavesRunning = cavesConfigured ? await isCavesContainerRunning(instanceId) : false
    const info = await buildDstConnectInfo(installPath, {
      gamePort: instance.gamePort,
      running: masterRunning,
    })
    return success({
      ...info,
      consoleShards: {
        masterRunning,
        cavesConfigured,
        cavesRunning,
      },
    }, request)
  })

  app.get('/app/instance/console/logs', async (request): Promise<ApiSuccessResponse<InstanceConsoleLogsPayload> | ApiErrorResponse> => {
    const query = consoleLogsQuerySchema.safeParse(request.query)
    if (!query.success) {
      return businessError('请求参数无效', request)
    }
    const instanceId = query.data.instanceId
    const authorized = await authorizeInstance(request, instanceId, 'instance.console:read')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveLocalInstance(instanceId, request)
    if (!resolved.ok) {
      return resolved.error
    }
    const running = await isInstanceContainerRunning(instanceId)
    const lines = filterConsoleLines(
      instanceConsoleLogStore.listLogs(instanceId, query.data.afterId),
      query.data.stream,
    )
    return success({
      lines,
      running,
    }, request)
  })

  app.get('/app/instance/console/logs/history', async (request): Promise<ApiSuccessResponse<ConsoleLogHistoryDto> | ApiErrorResponse> => {
    const query = consoleInstanceQuerySchema.safeParse(request.query ?? {})
    if (!query.success) {
      return businessError('请求参数无效', request)
    }
    const authorized = await authorizeInstance(request, query.data.instanceId, 'instance.console:read')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveLocalInstance(query.data.instanceId, request)
    if (!resolved.ok) {
      return resolved.error
    }
    const content = getActiveConsoleLogFile()?.readTail(resolved.instance.id) ?? null
    return success({
      instanceId: resolved.instance.id,
      available: content !== null,
      content: content ?? '',
    }, request)
  })

  app.get('/app/instance/console/logs/download', async (request, reply): Promise<void | FastifyReply> => {
    const query = consoleInstanceQuerySchema.safeParse(request.query ?? {})
    if (!query.success) {
      reply.status(400).send(businessError('请求参数无效', request))
      return
    }
    const authorized = await authorizeInstance(request, query.data.instanceId, 'instance.console:read')
    if (authorized.error) {
      reply.status(403).send(authorized.error)
      return
    }
    const resolved = await resolveLocalInstance(query.data.instanceId, request)
    if (!resolved.ok) {
      reply.status(400).send(resolved.error)
      return
    }
    const filePath = getActiveConsoleLogFile()?.resolveFilePath(resolved.instance.id)
    if (!filePath || !fs.existsSync(filePath)) {
      reply.status(404).send(businessError('还没有可下载的日志，实例启动过一次后才会生成', request))
      return
    }
    return sendFileDownload(reply, {
      filePath,
      contentType: 'text/plain; charset=utf-8',
      fileName: `${resolved.instance.id}-console.log`,
    })
  })

  app.post('/app/instance/console/logs/clear', async (request): Promise<ApiSuccessResponse<{ isSuccess: boolean }> | ApiErrorResponse> => {
    const body = consoleInstanceQuerySchema.safeParse(request.body)
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const instanceId = body.data.instanceId
    const authorized = await authorizeInstance(request, instanceId, 'console:clear')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveLocalInstance(instanceId, request)
    if (!resolved.ok) {
      return resolved.error
    }
    instanceConsoleLogStore.clearLogs(instanceId)
    return success({ isSuccess: true }, request)
  })

  app.post('/app/instance/console/command', async (request): Promise<ApiSuccessResponse<{ isSuccess: boolean }> | ApiErrorResponse> => {
    const body = consoleCommandBodySchema.safeParse(request.body)
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const { instanceId, command, shard } = body.data
    const authorized = await authorizeInstance(request, instanceId, 'console:command')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveLocalInstance(instanceId, request)
    if (!resolved.ok) {
      return resolved.error
    }
    if (resolved.instance.status !== 'running') {
      return businessError('实例未运行，无法发送控制台命令', request)
    }
    const runtimeReady = await ensureContainerRuntimeReady()
    if (!runtimeReady.ok) {
      return businessError(runtimeReady.message ?? '容器运行时未就绪', request)
    }
    const result = await sendInstanceContainerCommand(instanceId, command, shard)
    if (!result.ok) {
      return businessError(result.message ?? '命令发送失败', request)
    }
    return success({ isSuccess: true }, request)
  })

  app.post('/app/instance/console/stream-ticket', async (request): Promise<ApiSuccessResponse<InstanceConsoleStreamTicketDto> | ApiErrorResponse> => {
    const body = consoleStreamTicketRequestSchema.safeParse(request.body)
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const instanceId = body.data.instanceId
    /**
     * 鉴权在这一步完成：签出去的票据只绑定 instanceId，`/stream` 那边不再校验权限
     * （票据是一次性的、60 秒过期）。所以这里是唯一的关口。
     */
    const auth = await authorizeInstance(request, instanceId, 'instance.console:read')
    if (auth.error || !auth.context) {
      return auth.error ?? businessError('Unable to issue console stream authorization', request)
    }
    const resolved = await resolveLocalInstance(instanceId, request)
    if (!resolved.ok) {
      return resolved.error
    }
    const issued = consoleStreamTicketStore.issue({
      instanceId,
      userId: auth.context.user.id,
    })
    return success({
      ticket: issued.ticket,
      expiresAt: new Date(issued.expiresAt).toISOString(),
    }, request)
  })

  app.get('/app/instance/console/stream', async (request, reply) => {
    const query = consoleStreamQuerySchema.safeParse(request.query)
    if (!query.success) {
      reply.status(401).send(businessError('Console stream authorization expired or is invalid', request))
      return
    }
    const { instanceId, streamTicket } = query.data
    const ticketRecord = consoleStreamTicketStore.consume(streamTicket, instanceId)
    if (!ticketRecord) {
      reply.status(401).send(businessError('Console stream authorization expired or is invalid', request))
      return
    }

    /**
     * 同一账号的并发流上限。
     *
     * 票据是一次性的，但账号可以反复签票——所以票据制不构成任何并发上限。
     * 没有这道闸门时，一个已登录的游客就能挂着一串 SSE 长连接，每条都在服务端留一个
     * 订阅回调与一个 15 秒心跳。上限的取值与理由见 `stream-ticket.ts`。
     */
    const streamOwner = consoleStreamTicketStore.openStream(ticketRecord.userId)
    if (!streamOwner) {
      reply.status(429).send(businessError(
        `同时打开的日志流过多（上限 ${consoleStreamTicketStore.maxStreamsPerUser} 条），请关闭其它控制台页面后重试`,
        request,
      ))
      return
    }

    /**
     * 从这里开始"名额已占用"，**每条出口都必须释放**。
     *
     * 下面所有提前 return 与异常都走 `releaseStream()`；正式建立流之后交给
     * `request.raw` 的 `close` 事件释放。少释放一次的后果不是"少一条日志"，
     * 而是那个账号的名额被永久占住——重启面板才能恢复。
     */
    let streamReleased = false
    const releaseStream = () => {
      if (streamReleased) {
        return
      }
      streamReleased = true
      consoleStreamTicketStore.closeStream(streamOwner)
    }

    let resolved: Awaited<ReturnType<typeof resolveLocalInstance>>
    try {
      resolved = await resolveLocalInstance(instanceId, request)
    }
    catch (error) {
      releaseStream()
      throw error
    }
    if (!resolved.ok) {
      releaseStream()
      reply.status(400).send(resolved.error)
      return
    }

    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    })

    const running = await isInstanceContainerRunning(instanceId)
    writeSse(reply, 'ready', {
      instanceId,
      running,
    })
    for (const line of instanceConsoleLogStore.listLogs(instanceId)) {
      writeSse(reply, 'log', line)
    }

    const unsubscribe = instanceConsoleLogStore.subscribe(instanceId, (line) => {
      writeSse(reply, 'log', line)
    })

    const heartbeat = setInterval(() => {
      reply.raw.write(': heartbeat\n\n')
    }, 15000)

    request.raw.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
      // 名额释放必须和 openStream 配对：漏掉一处，那个账号就再也开不了日志流
      releaseStream()
      reply.raw.end()
    })
  })

  registerMaintenanceAnnounceRoutes(app)
  registerWorldStateRoutes(app)
}
