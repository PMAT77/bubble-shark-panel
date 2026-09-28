import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ApiErrorResponse, ApiSuccessResponse } from '../../../../shared/contracts/api'
import {
  shardInstanceQuerySchema,
  shardReadWorldSeedPayloadSchema,
  shardResetWorldPayloadSchema,
  shardResetWorldWithSeedPayloadSchema,
  shardRollbackPayloadSchema,
  shardSavePayloadSchema,
  shardSnapshotsQuerySchema,
} from '../../../../shared/contracts/shard'
import type {
  ShardInitCavesResult,
  ShardListDto,
  ShardMaintenanceResult,
  ShardResetWorldWithSeedResult,
  ShardSavePayload,
  ShardSaveResult,
  ShardSnapshotsDto,
  ShardWorldSeedProbe,
} from '../../../../shared/contracts/shard'
import { resolveLocalDstInstance } from '../../shared/dst/local-dst-instance'
import {
  getShardList,
  initCavesShard,
  saveShardConfig,
} from '../../infra/game-adapter/dst/shard-service'
import { listShardSnapshots, readMaxSnapshots } from '../../infra/game-adapter/dst/world-maintenance'
import { probeWorldSeed, scheduleWorldSeedProbes } from '../console/world-seed-probe'
import { syncInstanceModFilesFromDb } from '../mod/mod-file-sync-service'
import { resetShardWorld, resetShardWorldWithSeed, rollbackShard } from './world-maintenance-service'
import { injectRestartInstance } from '../instance/inject-restart'
import { isInstanceContainerRunning } from '../instance/container-lifecycle'
import { businessError, success } from '../../shared/http/response'
import { authorizeInstance } from '../system/auth'

const SHARD_RESOLVE_MESSAGES = {
  wrongNode: '当前仅支持本地节点实例世界配置',
  wrongGame: '当前仅支持 DST 实例世界配置',
  missingInstallPath: '实例安装目录不存在，请先在实例管理中完成安装',
  clusterDirFailed: '无法创建房间配置目录',
}

async function restartInstance(
  app: FastifyInstance,
  request: FastifyRequest,
  instanceId: string,
  options?: { autoAllocatePorts?: boolean },
): Promise<ApiErrorResponse | undefined> {
  return injectRestartInstance(app, request, instanceId, options)
}

/**
 * shard 模块：DST 世界（Master/Caves server.ini、worldgen）与分片状态。
 */
export function registerShardModule(app: FastifyInstance) {
  app.get('/app/instance/shards', async (request): Promise<ApiSuccessResponse<ShardListDto> | ApiErrorResponse> => {
    const query = shardInstanceQuerySchema.safeParse(request.query ?? {})
    if (!query.success) {
      return businessError('请求参数无效', request)
    }
    const instanceId = query.data.instanceId
    const authorized = await authorizeInstance(request, instanceId, 'world:read')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveLocalDstInstance(instanceId, request, { messages: SHARD_RESOLVE_MESSAGES })
    if (!resolved.ok) {
      return resolved.error
    }
    try {
      const data = await getShardList(resolved.instance)
      // 世界种子只能在实例运行期间从游戏里读到：拿到实例状态时顺带在后台补读一次
      // （不阻塞本次响应）。这样"跑过一次"的世界即使之后停服，也能显示它真实的种子。
      scheduleWorldSeedProbes(
        resolved.instance,
        data.clusterShardEnabled ? ['master', 'caves'] : ['master'],
      )
      return success(data, request)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : '读取世界配置失败'
      return businessError(message, request)
    }
  })

  app.post('/app/instance/shards/init-caves', async (request): Promise<ApiSuccessResponse<ShardInitCavesResult> | ApiErrorResponse> => {
    const query = shardInstanceQuerySchema.safeParse(request.query ?? {})
    if (!query.success) {
      return businessError('请求参数无效', request)
    }
    const instanceId = query.data.instanceId
    const authorized = await authorizeInstance(request, instanceId, 'world:write')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveLocalDstInstance(instanceId, request, { messages: SHARD_RESOLVE_MESSAGES })
    if (!resolved.ok) {
      return resolved.error
    }
    try {
      const data = initCavesShard(resolved.instance, resolved.instance.gamePort)
      return success(data, request)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : '初始化洞穴世界失败'
      return businessError(message, request)
    }
  })

  app.put('/app/instance/shards', async (request): Promise<ApiSuccessResponse<ShardSaveResult> | ApiErrorResponse> => {
    const body = shardSavePayloadSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const payload: ShardSavePayload = body.data
    const instanceId = payload.instanceId
    const authorized = await authorizeInstance(request, instanceId, 'world:write')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveLocalDstInstance(instanceId, request, { messages: SHARD_RESOLVE_MESSAGES })
    if (!resolved.ok) {
      return resolved.error
    }
    try {
      const result = saveShardConfig(resolved.instance, payload)
      // 世界种子由面板内置的 Mod 承载：保存后立刻同步一次 Mod 文件，让内置 Mod 内容与
      // 服务器 Mod 清单反映最新种子。失败只记日志——种子已落在面板元数据里，
      // 实例启动前的同步会再来一次，不会丢。
      if (payload.worldSeed !== undefined) {
        try {
          await syncInstanceModFilesFromDb(resolved.instance.id, resolved.instance.installPath)
        }
        catch (error) {
          app.log.warn({ instanceId, error }, '保存世界种子后同步 Mod 文件失败，将在实例启动时重试')
        }
      }
      if (payload.restart) {
        const restartError = await restartInstance(app, request, instanceId)
        if (restartError) {
          return restartError
        }
        result.restarted = true
      }
      return success(result, request)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : '保存世界配置失败'
      return businessError(message, request)
    }
  })

  /**
   * 读取当前世界的真实种子。
   *
   * 种子由游戏生成并记在存档里，只能向正在运行的分片询问（TheWorld.meta.seed）；
   * 读到后写进面板元数据，因此实例停服后页面依然显示得到。
   */
  app.post('/app/instance/shards/read-world-seed', async (request): Promise<ApiSuccessResponse<ShardWorldSeedProbe> | ApiErrorResponse> => {
    const body = shardReadWorldSeedPayloadSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const authorized = await authorizeInstance(request, body.data.instanceId, 'world:read')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveLocalDstInstance(body.data.instanceId, request, { messages: SHARD_RESOLVE_MESSAGES })
    if (!resolved.ok) {
      return resolved.error
    }
    try {
      const probe = await probeWorldSeed({
        instanceId: resolved.instance.id,
        shard: body.data.shard,
        installPath: resolved.instance.installPath,
      })
      return success(probe, request)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : '读取当前世界种子失败'
      return businessError(message, request)
    }
  })

  app.get('/app/instance/shards/snapshots', async (request): Promise<ApiSuccessResponse<ShardSnapshotsDto> | ApiErrorResponse> => {
    const query = shardSnapshotsQuerySchema.safeParse(request.query ?? {})
    if (!query.success) {
      return businessError('请求参数无效', request)
    }
    const authorized = await authorizeInstance(request, query.data.instanceId, 'world:read')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveLocalDstInstance(query.data.instanceId, request, { messages: SHARD_RESOLVE_MESSAGES })
    if (!resolved.ok) {
      return resolved.error
    }
    try {
      const snapshots = listShardSnapshots(resolved.instance.installPath, query.data.shard)
      const maxSnapshots = readMaxSnapshots(resolved.instance.installPath)
      const running = resolved.instance.status === 'running'
        && await isInstanceContainerRunning(resolved.instance.id)
      const warnings: string[] = []
      if (snapshots.length === 0) {
        warnings.push('没有读到可用的存档点：世界首次启动后才会产生存档点')
      }
      return success({
        instanceId: resolved.instance.id,
        shard: query.data.shard,
        running,
        maxSnapshots,
        snapshots,
        warnings,
      }, request)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : '读取存档点失败'
      return businessError(message, request)
    }
  })

  app.post('/app/instance/shards/rollback', async (request): Promise<ApiSuccessResponse<ShardMaintenanceResult> | ApiErrorResponse> => {
    const body = shardRollbackPayloadSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const payload = body.data
    const authorized = await authorizeInstance(request, payload.instanceId, 'world:rollback')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveLocalDstInstance(payload.instanceId, request, { messages: SHARD_RESOLVE_MESSAGES })
    if (!resolved.ok) {
      return resolved.error
    }
    const outcome = await rollbackShard({
      app,
      instance: resolved.instance,
      shard: payload.shard,
      steps: payload.steps,
      backupBeforeRollback: payload.backupBeforeRollback,
    })
    if (!outcome.ok) {
      return businessError(outcome.message, request)
    }
    for (const warning of outcome.warnings) {
      app.log.warn({ instanceId: resolved.instance.id, shard: payload.shard, warning }, '世界回档提示')
    }
    return success(outcome.result, request)
  })

  /**
   * 按填写的种子重置世界并重新启动实例。
   *
   * 与下面的「重置世界」（发给运行中的游戏）不同：这条路径要求实例已停止，
   * 由面板清掉该分片存档，再启动实例让游戏按新种子生成地图。
   */
  app.post('/app/instance/shards/reset-world-with-seed', async (request): Promise<ApiSuccessResponse<ShardResetWorldWithSeedResult> | ApiErrorResponse> => {
    const body = shardResetWorldWithSeedPayloadSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const authorized = await authorizeInstance(request, body.data.instanceId, 'world:reset')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveLocalDstInstance(body.data.instanceId, request, { messages: SHARD_RESOLVE_MESSAGES })
    if (!resolved.ok) {
      return resolved.error
    }
    const outcome = await resetShardWorldWithSeed({
      app,
      request,
      instance: resolved.instance,
      shard: body.data.shard,
      worldSeed: body.data.worldSeed ?? null,
    })
    if (!outcome.ok) {
      return businessError(outcome.message, request)
    }
    for (const warning of outcome.warnings) {
      app.log.warn(
        { instanceId: body.data.instanceId, shard: body.data.shard, warning },
        '按种子重置世界提示',
      )
    }
    return success(outcome.result, request)
  })

  app.post('/app/instance/shards/reset-world', async (request): Promise<ApiSuccessResponse<ShardMaintenanceResult> | ApiErrorResponse> => {
    const body = shardResetWorldPayloadSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const payload = body.data
    const authorized = await authorizeInstance(request, payload.instanceId, 'world:reset')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveLocalDstInstance(payload.instanceId, request, { messages: SHARD_RESOLVE_MESSAGES })
    if (!resolved.ok) {
      return resolved.error
    }
    const outcome = await resetShardWorld({
      app,
      instance: resolved.instance,
      shard: payload.shard,
      confirmName: payload.confirmName,
    })
    if (!outcome.ok) {
      return businessError(outcome.message, request)
    }
    for (const warning of outcome.warnings) {
      app.log.warn({ instanceId: resolved.instance.id, shard: payload.shard, warning }, '重置世界提示')
    }
    return success(outcome.result, request)
  })
}
