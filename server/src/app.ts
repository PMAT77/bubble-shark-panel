import { registerInstanceContentRouteGuards } from './shared/instance-content/routes'
import type { FastifyInstance } from 'fastify'
import type { ServerConfig } from './shared/config'
import path from 'node:path'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { registerAuthModule } from './modules/auth'
import { registerClusterModule } from './modules/cluster'
import { registerPlayerModule } from './modules/player'
import { registerFilesModule } from './modules/files'
import { registerShardModule } from './modules/shard'
import { registerMapModule } from './modules/map'
import { registerModModule } from './modules/mod'
import { registerConsoleModule } from './modules/console'
import { registerInstanceModule } from './modules/instance'
import { registerNodeModule } from './modules/node'
import { registerSystemModule } from './modules/system'
import { registerBackupModule } from './modules/backup'
import { registerScheduleModule } from './modules/schedule'
import { registerNotifyModule } from './modules/notify'
import { getCachedDockerStatus } from './infra/docker'
import { getCachedRuntimeStatus, isSteamcmdRuntimeReady } from './infra/runtime'
import { success } from './shared/http/response'
import { sanitizeRequestUrlForLog } from './shared/http/request-url'
import { registerOperationAudit } from './shared/audit/operation-audit'
import { resolveRepoRoot } from './shared/repo-root'
import { registerFrontendStatic } from './shared/http/frontend-static'

/**
 * 创建 Fastify 服务实例。
 * 当前只提供最小可运行能力，后续在此处扩展模块注册与插件。
 */
export async function createServerApp(config: Pick<ServerConfig, 'mode' | 'logLevel' | 'port' | 'corsOrigin' | 'runtimeMode' | 'releaseVersion' | 'buildSha'>): Promise<FastifyInstance> {
  const logHttpRequests = config.logLevel === 'debug' || config.logLevel === 'trace'

  const app = Fastify({
    logger: {
      level: config.logLevel,
      base: {
        service: 'bubblesharkpanel-backend',
        env: config.mode,
      },
    },
    // dev:compose 默认 info，避免终端被每条 API 请求刷屏；需排查时设 LOG_LEVEL=debug
    disableRequestLogging: true,
  })

  await app.register(cors, {
    origin: config.corsOrigin,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'token', 'Token', 'Accept-Language'],
    // 反射任意 Origin（CORS_ORIGIN=true/*）时必须禁用凭据，
    // 否则等于允许任意站点携带凭据跨域调用全部 API。
    credentials: config.corsOrigin !== true,
  })

  // 最小健康检查接口，用于联调与部署探活。
  app.get('/health', async () => {
    const dockerStatus = config.runtimeMode === 'docker' ? getCachedDockerStatus() : 'stopped'
    const runtimeStatus = getCachedRuntimeStatus()
    return {
      status: 'ok',
      service: 'bubblesharkpanel-backend',
      runtime: {
        mode: config.runtimeMode,
        status: runtimeStatus,
      },
      // release.version 供 Native 更新执行器确认「新版本真的起来了」，而不是只看进程活着。
      release: {
        version: config.releaseVersion || '',
        buildSha: config.buildSha || '',
      },
      // 保留旧字段，避免 v0.1.4 监控与安装脚本在升级时失效。
      docker: dockerStatus,
      timestamp: new Date().toISOString(),
    }
  })

  // 最小 API 示例接口，后续模块路由统一挂到 /api 前缀下。
  app.get('/api/ping', async () => {
    return success({
      message: 'pong',
    })
  })

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error, '未捕获异常')
    reply.status(500).send({
      status: 1,
      error: '服务内部错误，请稍后重试',
      code: 'COMMON_INTERNAL_ERROR',
      data: {},
      requestId: request.id,
    })
  })

  if (config.mode !== 'development' || logHttpRequests) {
    app.addHook('onResponse', (request, reply, done) => {
      request.log.info({
        requestId: request.id,
        statusCode: reply.statusCode,
        method: request.method,
        url: sanitizeRequestUrlForLog(request.url),
        durationMs: reply.elapsedTime,
      }, 'request completed')
      done()
    })
  }

  /**
   * 用户操作审计：写操作留痕（含被拒的写操作）。
   * 只在生产路径注册；测试可以单独调用 registerOperationAudit，避免每条测试请求都写盘。
   */
  registerOperationAudit(app)

  app.get('/api/meta/runtime', async () => {
    const dockerStatus = config.runtimeMode === 'docker' ? getCachedDockerStatus() : 'stopped'
    const runtimeStatus = getCachedRuntimeStatus()
    const steamcmdReady = runtimeStatus === 'running' ? await isSteamcmdRuntimeReady() : false
    return success({
      server: {
        env: config.mode,
        logLevel: config.logLevel,
      },
      runtimeMode: config.runtimeMode,
      runtimeStatus,
      dockerStatus,
      steamcmdReady,
      // 兼容旧前端字段；Native 模式下表示 SteamCMD 原生运行时是否就绪。
      steamcmdImageReady: steamcmdReady,
    })
  })

  // 注册业务模块路由（仅 config 模块仍为占位，未实现因而未注册；files 等其余模块均已实现）
  registerInstanceContentRouteGuards(app)
  registerAuthModule(app)
  registerSystemModule(app)
  registerNodeModule(app)
  registerInstanceModule(app)
  registerClusterModule(app)
  registerPlayerModule(app)
  registerFilesModule(app)
  registerShardModule(app)
  registerMapModule(app)
  registerModModule(app)
  registerConsoleModule(app)
  registerBackupModule(app)
  registerScheduleModule(app)
  registerNotifyModule(app)

  if (config.mode === 'production') {
    // 打包后 bundle 位于 dist-server/，改从仓库根定位前端产物
    const distDir = path.resolve(resolveRepoRoot(), 'dist')
    registerFrontendStatic(app, distDir)
  }

  return app
}
