import { withInstanceContentOperation } from '../../shared/instance-content/operation'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ApiErrorResponse, ApiSuccessResponse } from '../../../../shared/contracts/api'
import {
  clusterInstanceQuerySchema,
  clusterSavePayloadSchema,
} from '../../../../shared/contracts/cluster'
import type {
  ClusterConfigDto,
  ClusterOnlinePlayersDto,
  ClusterSavePayload,
  ClusterSaveResult,
} from '../../../../shared/contracts/cluster'
import { resolveLocalDstInstance } from '../../shared/dst/local-dst-instance'
import {
  getClusterConfig,
  saveClusterConfig,
} from '../../infra/game-adapter/dst/cluster-service'
import { injectRestartInstance } from '../instance/inject-restart'
import { queryInstanceOnlineRoster } from '../player'
import { businessError, success } from '../../shared/http/response'
import { authorizeInstance } from '../system/auth'

async function restartInstance(
  app: FastifyInstance,
  request: FastifyRequest,
  instanceId: string,
  options?: { autoAllocatePorts?: boolean },
): Promise<ApiErrorResponse | undefined> {
  return injectRestartInstance(app, request, instanceId, options)
}

const CLUSTER_RESOLVE_MESSAGES = {
  wrongNode: '当前仅支持本地节点实例房间配置',
  wrongGame: '当前仅支持 DST 实例房间配置',
  missingInstallPath: '实例安装目录不存在，请先在实例管理中完成安装',
  clusterDirFailed: '无法创建房间配置目录',
}

/**
 * cluster 模块：DST 房间（cluster.ini）结构化读写。
 */
export function registerClusterModule(app: FastifyInstance) {
  app.get('/app/instance/cluster', async (request): Promise<ApiSuccessResponse<ClusterConfigDto> | ApiErrorResponse> => {
    const query = clusterInstanceQuerySchema.safeParse(request.query ?? {})
    if (!query.success) {
      return businessError('请求参数无效', request)
    }
    const instanceId = query.data.instanceId
    // 权限点 + 实例授权：只要 room:read 的账号只能读，且只能读被授权的那几个实例
    const authorized = await authorizeInstance(request, instanceId, 'room:read')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveLocalDstInstance(instanceId, request, { messages: CLUSTER_RESOLVE_MESSAGES })
    if (!resolved.ok) {
      return resolved.error
    }
    try {
      const data = getClusterConfig(resolved.instance)
      return success(data, request)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : '读取房间配置失败'
      return businessError(message, request)
    }
  })

  app.get('/app/instance/cluster/online-players', async (request): Promise<ApiSuccessResponse<ClusterOnlinePlayersDto> | ApiErrorResponse> => {
    const query = clusterInstanceQuerySchema.safeParse(request.query ?? {})
    if (!query.success) {
      return businessError('请求参数无效', request)
    }
    const instanceId = query.data.instanceId
    // 在线玩家属于玩家视图，读名单与在线状态用 player:read；踢人与封禁另有更细的权限点
    const authorized = await authorizeInstance(request, instanceId, 'player:read')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveLocalDstInstance(instanceId, request, { messages: CLUSTER_RESOLVE_MESSAGES })
    if (!resolved.ok) {
      return resolved.error
    }
    try {
      /**
       * 与玩家管理页共用同一条查询路径（地上 + 洞穴）。
       *
       * 以前这里只查地上、且直接按游戏侧读数报人数：玩家走进洞穴时详情页会少算一个，
       * 而玩家管理页查两个分片——两个页面就此对不上。共用之后口径不会再分叉。
       */
      const roster = await queryInstanceOnlineRoster(resolved.instance)
      return success({
        instanceId,
        running: roster.running,
        onlinePlayerCount: roster.onlinePlayerCount,
        // 完全没取到时给 null（「不知道」），与空数组「确实没人」区分开
        players: roster.onlinePlayerCount === null
          ? null
          : roster.players.map(player => ({
              kuId: player.kuId,
              name: player.name,
              kleiAccount: player.kleiAccount,
              key: player.key,
            })),
        unlistedPlayerCount: roster.unlistedPlayerCount,
        partial: roster.partial,
        maxPlayers: roster.maxPlayers,
      }, request)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : '读取在线人数失败'
      return businessError(message, request)
    }
  })

  app.put('/app/instance/cluster', async (request): Promise<ApiSuccessResponse<ClusterSaveResult> | ApiErrorResponse> => {
    const body = clusterSavePayloadSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const payload: ClusterSavePayload = body.data
    const instanceId = payload.instanceId
    const authorized = await authorizeInstance(request, instanceId, 'room:write')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveLocalDstInstance(instanceId, request, { messages: CLUSTER_RESOLVE_MESSAGES })
    if (!resolved.ok) {
      return resolved.error
    }
    try {
      const result = await withInstanceContentOperation(instanceId, async () => saveClusterConfig(resolved.instance, payload))
      if (payload.restart) {
        /**
         * 「保存并重启」里的重启是**另一项能力**，不能借 `room:write` 顺带拿到。
         * 只给改房间配置权限的账号可以把配置存下去，但重启那一步会被拒——
         * 否则「能改房间配置」等于隐含「能重启实例」，细粒度就白拆了。
         */
        const restartAuth = await authorizeInstance(request, instanceId, 'instance:lifecycle')
        if (restartAuth.error) {
          return restartAuth.error
        }
        const restartError = await restartInstance(app, request, instanceId)
        if (restartError) {
          return restartError
        }
        result.restarted = true
      }
      return success(result, request)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : '保存房间配置失败'
      return businessError(message, request)
    }
  })
}
