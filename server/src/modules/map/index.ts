import fs from 'node:fs'
import type { FastifyInstance } from 'fastify'
import type { ApiErrorResponse, ApiSuccessResponse } from '../../../../shared/contracts/api'
import {
  mapImageQuerySchema,
  mapQuerySchema,
  mapRefreshPayloadSchema,
  type MapDto,
} from '../../../../shared/contracts/map'
import type { ShardId } from '../../../../shared/contracts/shard'
import { resolveLocalDstInstance } from '../../shared/dst/local-dst-instance'
import { loadServerConfig } from '../../shared/config'
import { instanceConsoleLogStore } from '../../shared/instance-runtime/console-log-store'
import { businessError, success } from '../../shared/http/response'
import { authorizeInstance } from '../system/auth'
import {
  ensureContainerRuntimeReady,
  isCavesContainerRunning,
  isInstanceContainerRunning,
  sendInstanceContainerCommand,
} from '../instance/container-lifecycle'
import { MapService } from './map-service'
import { resolveMapImagePath } from './map-store'

/**
 * 地图模块：把当前世界的地形导出并渲染成一张图。
 *
 * 与「按种子试算」那版最大的不同：**它不依赖任何未验证的上游能力**。世界已经生成好了，
 * 面板只是让正在运行的游戏把地形写进一个文件，再自己画图。
 */

const RESOLVE_MESSAGES = {
  wrongNode: '当前仅支持本地节点实例地形导出',
  wrongGame: '当前仅支持 DST 实例地形导出',
  missingInstallPath: '实例安装目录不存在，请先在实例管理中完成安装',
}

/** 面板数据目录：地图产物与数据库同级，**绝不写进实例目录** */
function resolvePanelDbPath(): string {
  return loadServerConfig().dbPath
}

async function isShardRunning(instanceId: string, shard: ShardId): Promise<boolean> {
  return shard === 'caves'
    ? isCavesContainerRunning(instanceId)
    : isInstanceContainerRunning(instanceId)
}

/**
 * 构造服务。
 *
 * 不需要实例安装目录：地形是从控制台日志里分块收回来的，不落地文件。
 * 这条链路因此**不依赖面板与游戏的路径关系**，Docker / Native 两种部署完全一致。
 */
function createMapService(): MapService {
  return new MapService({
    dbPath: resolvePanelDbPath(),
    isShardRunning,
    // silent：这不是用户发的命令，不该每隔一会儿就往控制台里塞一条命令行回显
    sendCommand: (instanceId, shard, command) =>
      sendInstanceContainerCommand(instanceId, command, shard, { silent: true }),
    readLogLines: (instanceId, afterId) => instanceConsoleLogStore
      .listLogs(instanceId, afterId)
      .map(line => line.text),
    currentLogId: instanceId => instanceConsoleLogStore.listLogs(instanceId).at(-1)?.id ?? 0,
  })
}

export function registerMapModule(app: FastifyInstance, deps: {
  createService?: () => MapService
  isShardRunning?: typeof isShardRunning
  ensureRuntimeReady?: typeof ensureContainerRuntimeReady
} = {}) {
  let service: MapService | undefined
  const getService = () => service ??= (deps.createService ?? createMapService)()
  app.get('/app/instance/map', async (request): Promise<ApiSuccessResponse<MapDto> | ApiErrorResponse> => {
    const query = mapQuerySchema.safeParse(request.query ?? {})
    if (!query.success) {
      return businessError('请求参数无效', request)
    }
    const authorized = await authorizeInstance(request, query.data.instanceId, 'world.map:read')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveLocalDstInstance(query.data.instanceId, request, { messages: RESOLVE_MESSAGES })
    if (!resolved.ok) {
      return resolved.error
    }
    return success(getService().getState(query.data.instanceId, query.data.shard), request)
  })

  app.post('/app/instance/map/refresh', async (request): Promise<ApiSuccessResponse<MapDto> | ApiErrorResponse> => {
    const body = mapRefreshPayloadSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const { instanceId, shard, force } = body.data
    // 生成地图会向运行中的世界下发导出命令（游戏要跑一遍 RLE 编码），属于写操作
    const authorized = await authorizeInstance(request, instanceId, 'world.map:generate')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveLocalDstInstance(instanceId, request, { messages: RESOLVE_MESSAGES })
    if (!resolved.ok) {
      return resolved.error
    }

    /**
     * 实例是否在运行**在这里先判**，而不是丢给后台任务。
     *
     * 地形只能从活着的世界读：未运行时直接告诉用户"先启动实例"，比先返回 200、
     * 再让前端从"生成中"跳到"失败"诚实得多。
     *
     * 判断顺序也不能反：**先看实例在不在跑，再看运行时与镜像**。实例没跑时，
     * 用户该看到的就是"实例未运行"这一句——"镜像未就绪"是面板的内部实现细节，
     * 拿它没法行动；而且实例都没跑，根本没到需要镜像的那一步。
     * （这个顺序是发布当天暴露的：版本号一 bump，新 tag 在镜像仓库上还不存在，
     *   凡是先做镜像检查的路径都会先撞 404，把真正的原因盖掉。）
     */
    if (!await (deps.isShardRunning ?? isShardRunning)(instanceId, shard)) {
      return businessError(
        shard === 'caves' ? '洞穴分片未运行，无法导出地形' : '实例未运行，无法导出地形',
        request,
      )
    }
    const runtimeReady = await (deps.ensureRuntimeReady ?? ensureContainerRuntimeReady)()
    if (!runtimeReady.ok) {
      return businessError(runtimeReady.message ?? '容器运行时未就绪，无法导出地形', request)
    }
    const service = getService()
    const result = service.refresh({ instanceId, shard, force: force ?? false })
    if (!result.accepted) {
      return businessError(result.message, request)
    }
    return success(service.getState(instanceId, shard), request)
  })

  app.get('/app/instance/map/image', async (request, reply): Promise<void | ApiErrorResponse> => {
    /**
     * 取图走 `allowQueryToken`：这张图是给 `<img src>` 用的，浏览器不会给图片请求带自定义头，
     * 只能把令牌放在查询参数里。授权逻辑与其余接口共用同一套，没有额外放宽。
     */
    const query = mapImageQuerySchema.safeParse(request.query ?? {})
    if (!query.success) {
      return reply.status(400).send({ status: 1, error: '请求参数无效' })
    }
    const authorized = await authorizeInstance(request, query.data.instanceId, 'world.map:read', {
      allowQueryToken: true,
    })
    if (authorized.error) {
      return reply.send(authorized.error)
    }
    const resolved = await resolveLocalDstInstance(query.data.instanceId, request, { messages: RESOLVE_MESSAGES })
    if (!resolved.ok) {
      return reply.send(resolved.error)
    }
    const imagePath = resolveMapImagePath(resolvePanelDbPath(), query.data.instanceId, query.data.shard)
    if (!fs.existsSync(imagePath)) {
      return reply.status(404).send({ status: 1, error: '还没有这个分片的地形图' })
    }
    // 世界在变、图就会变：不让中间层缓存，避免用户看到上一张图却以为没刷新
    reply.header('Cache-Control', 'no-store')
    return reply.type('image/png').send(fs.createReadStream(imagePath) as unknown as Buffer)
  })
}
