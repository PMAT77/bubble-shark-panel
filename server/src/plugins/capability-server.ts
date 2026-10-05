import type { FastifyInstance } from 'fastify'
import type { PluginAuditRecord, PluginCapability } from '../../../shared/contracts/plugin'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import Fastify from 'fastify'
import { getGameInstanceById, listGameInstances } from '../shared/db/index'
import { collectHostResourceSnapshot } from '../shared/host-metrics'
import { instanceConsoleLogStore } from '../shared/instance-runtime/console-log-store'
import { resolvePluginInstanceOps } from '../modules/instance/instance-plugin-ops'
import {
  createBackupForConsumer,
  deleteBackupForConsumer,
  isInsideBackupsRoot,
  listBackupsForConsumer,
} from '../modules/backup/backup-ops'
import { readOperationAudit, resolveOperationAuditRoot } from '../shared/audit/operation-audit'
import { appendPluginAudit, readPluginAudit, resolvePluginAuditRoot } from './audit-store'

/**
 * 插件能力服务：宿主向插件进程暴露的**唯一**入口。
 *
 * 为什么单独起一个只监听回环的服务，而不是复用面板自己的 HTTP 服务：
 * 1. 面板的接口用登录令牌鉴权，插件不该拿到、也不该复用管理员令牌；
 * 2. 插件只能看到明确暴露的能力，不能"顺路"访问面板的其它接口；
 * 3. 端口随机、只绑 127.0.0.1、进程退出即销毁，攻击面比面板主端口小得多。
 *
 * 鉴权方式是**每次宿主启动生成的一次性令牌**：插件从环境变量拿到它，
 * 通过请求头回传；令牌不出现在命令行（进程列表可见）里，也不落盘。
 *
 * 能力判定是双重的：插件必须（a）在清单里声明过该能力，且（b）宿主此刻确实授予了它。
 * 少任何一条都拒绝，并记一条 `denied` 审计——**越权尝试本身就是需要留痕的事件**。
 */

export interface CapabilityContext {
  /** 插件 ID → 宿主已授予的能力集合 */
  grantedCapabilities: Map<string, Set<PluginCapability>>
}

export interface CapabilityServerHandle {
  /** 插件连接用的基址，形如 http://127.0.0.1:51234 */
  baseUrl: string
  token: string
  /** 关闭服务（面板退出或插件全部停用时调用） */
  close: () => Promise<void>
}

type CapabilityOutcome = PluginAuditRecord['outcome']

interface CapabilityEnvelope {
  ok: boolean
  data?: unknown
  error?: string
}

interface CapabilityRequest {
  pluginId?: string
  [key: string]: unknown
}

/** 能力 API 的错误一律用同一种结构，插件侧解析简单 */
function capabilityError(message: string, outcome: CapabilityOutcome = 'error'): CapabilityEnvelope & { outcome: CapabilityOutcome } {
  return { ok: false, error: message, outcome }
}

/**
 * 把错误响应映射成正确的 HTTP 状态码。
 *
 * 为什么需要一个钩子：handler 直接 `return` 对象时 Fastify 一律回 200，
 * 插件按状态码判断成败就会把「能力未授予」当成成功。早先的实现用 `reply.status()`，
 * 改成统一包装后丢掉过一次；放在这里一次性兜住，比要求每个 handler 自己 `reply` 更不容易再漏。
 */
function resolveErrorStatus(body: unknown): number | undefined {
  if (!body || typeof body !== 'object' || (body as { ok?: unknown }).ok !== false) {
    return undefined
  }
  const outcome = (body as { outcome?: unknown }).outcome
  if (outcome === 'denied') {
    const message = String((body as { error?: unknown }).error ?? '')
    // 令牌错误是 401，能力未授予是 403：插件排错时需要区分这两件事
    return message.includes('令牌') ? 401 : 403
  }
  return 400
}

/** 常量时间比较，避免通过响应时间逐字节猜令牌 */
function isTokenValid(expected: string, provided: string | undefined): boolean {
  if (!provided || provided.length !== expected.length) {
    return false
  }
  return timingSafeEqual(Buffer.from(expected), Buffer.from(provided))
}

export interface StartCapabilityServerOptions {
  /** 审计写盘失败时的回调（宿主日志）：审计失败不能影响能力调用本身 */
  onAuditError?: (error: Error) => void
}

export async function startCapabilityServer(
  context: CapabilityContext,
  options: StartCapabilityServerOptions = {},
): Promise<CapabilityServerHandle> {
  const token = randomBytes(32).toString('hex')
  const app: FastifyInstance = Fastify({ logger: false, bodyLimit: 1024 * 1024 })

  app.addHook('onSend', async (_request, reply, payload) => {
    if (typeof payload === 'string' && reply.statusCode === 200) {
      try {
        const status = resolveErrorStatus(JSON.parse(payload))
        if (status) {
          reply.code(status)
        }
      }
      catch {
        // 非 JSON 响应（正常路径下不会出现）保持原状
      }
    }
    return payload
  })

  /**
   * 统一处理「鉴权 → 执行 → 审计」。
   *
   * 收在一处的原因：审计最容易出的问题是漏记。如果每个 handler 自己记，
   * 新加一个能力时就一定会漏掉某个分支（尤其是失败分支）。
   * 这里连"能力未授予被拒"也会记一条 `denied`。
   */
  async function withAudit<T extends CapabilityEnvelope>(input: {
    providedToken: string | undefined
    body: CapabilityRequest
    capability: PluginCapability
    action: string
    exec: () => Promise<T> | T
  }): Promise<T | (CapabilityEnvelope & { outcome: CapabilityOutcome })> {
    const startedAt = Date.now()
    const pluginId = typeof input.body.pluginId === 'string' ? input.body.pluginId.trim() : ''

    if (!isTokenValid(token, input.providedToken)) {
      return capabilityError('令牌无效：请使用宿主注入的 BSP_PLUGIN_TOKEN', 'denied')
    }
    if (!pluginId) {
      return capabilityError('缺少 pluginId')
    }
    const granted = context.grantedCapabilities.get(pluginId)
    if (!granted || !granted.has(input.capability)) {
      app.log.warn({ pluginId, capability: input.capability, action: input.action }, '插件请求了未授予的能力')
      appendPluginAudit({
        pluginId,
        capability: input.capability,
        action: input.action,
        params: input.body,
        outcome: 'denied',
        message: granted ? '未授予能力' : '插件未在运行或已被停用',
        durationMs: Date.now() - startedAt,
        onError: options.onAuditError,
      })
      return capabilityError(
        `未授予能力：${input.capability}。请在插件清单中声明并在面板中启用。`,
        'denied',
      )
    }

    try {
      const result = await input.exec()
      const outcome: CapabilityOutcome = result.ok ? 'ok' : 'error'
      appendPluginAudit({
        pluginId,
        capability: input.capability,
        action: input.action,
        params: input.body,
        outcome,
        message: result.ok ? null : (result.error ?? '执行失败'),
        durationMs: Date.now() - startedAt,
        onError: options.onAuditError,
      })
      return result
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      appendPluginAudit({
        pluginId,
        capability: input.capability,
        action: input.action,
        params: input.body,
        outcome: 'error',
        message,
        durationMs: Date.now() - startedAt,
        onError: options.onAuditError,
      })
      return capabilityError(message)
    }
  }

  const tokenOf = (request: { headers: Record<string, unknown> }) =>
    (request.headers['x-bsp-plugin-token'] ?? request.headers['x-gsh-plugin-token']) as string | undefined

  app.post('/capabilities/instances', async request => withAudit({
    providedToken: tokenOf(request),
    body: (request.body ?? {}) as CapabilityRequest,
    capability: 'instances:read',
    action: 'instances:list',
    exec: async () => {
      const instances = await listGameInstances()
      return {
        ok: true,
        data: instances.map(instance => ({
          id: instance.id,
          name: instance.name,
          gameCode: instance.gameCode,
          status: instance.status,
          gamePort: instance.gamePort ?? null,
          queryPort: instance.queryPort ?? null,
        })),
      }
    },
  }))

  app.post('/capabilities/metrics', async request => withAudit({
    providedToken: tokenOf(request),
    body: (request.body ?? {}) as CapabilityRequest,
    capability: 'metrics:read',
    action: 'metrics:host',
    exec: () => {
      const snapshot = collectHostResourceSnapshot()
      return {
        ok: true,
        data: {
          cpuUsageRate: snapshot.cpu.usageRate,
          cpuCores: snapshot.cpu.cores,
          memoryTotalGb: snapshot.memory.totalGb,
          memoryUsedGb: snapshot.memory.usedGb,
          diskTotalGb: snapshot.disk.totalGb,
          diskFreeGb: snapshot.disk.freeGb,
        },
      }
    },
  }))

  app.post('/capabilities/console', async request => withAudit({
    providedToken: tokenOf(request),
    body: (request.body ?? {}) as CapabilityRequest & { instanceId?: string, lines?: number },
    capability: 'console:read',
    action: 'console:recent',
    exec: async () => {
      const body = (request.body ?? {}) as CapabilityRequest & { instanceId?: string, lines?: number }
      const instanceId = typeof body.instanceId === 'string' ? body.instanceId.trim() : ''
      if (!instanceId) {
        return capabilityError('缺少 instanceId')
      }
      const instance = await getGameInstanceById(instanceId)
      if (!instance) {
        return capabilityError('实例不存在')
      }
      const requestedLines = Number.isFinite(body.lines) ? Math.min(Math.max(Number(body.lines), 1), 500) : 100
      /**
       * 用 afterId = 0 取最近的一批：插件的典型诉求是「给我最近的日志」。
       * 这里刻意不暴露全量历史，避免插件把面板的内存日志缓存整份拖走。
       */
      const rows = instanceConsoleLogStore.listLogs(instanceId, 0, requestedLines)
      return {
        ok: true,
        data: {
          instanceId,
          lines: rows.map(row => ({ stream: row.stream, at: row.at, text: row.text })),
        },
      }
    },
  }))

  /**
   * 实例生命周期：本服务里唯一的写类能力。
   *
   * 写操作与读操作的区别不在代码复杂度，而在**后果**：它会让线上玩家掉线。
   * 因此除了清单声明 + 宿主授予之外，还有一个额外的硬门槛——插件必须先声明
   * `instances:lifecycle`，面板启用时管理员要显式确认（见 registry 的危险能力检查），
   * 且每次调用都会在审计里留下一条记录。
   */
  app.post('/capabilities/lifecycle', async request => withAudit({
    providedToken: tokenOf(request),
    body: (request.body ?? {}) as CapabilityRequest & { instanceId?: string, operation?: string },
    capability: 'instances:lifecycle',
    action: 'lifecycle:execute',
    exec: async () => {
      const body = (request.body ?? {}) as CapabilityRequest & { instanceId?: string, operation?: string }
      const instanceId = typeof body.instanceId === 'string' ? body.instanceId.trim() : ''
      const operation = typeof body.operation === 'string' ? body.operation.trim() : ''
      if (!instanceId) {
        return capabilityError('缺少 instanceId')
      }
      if (!['start', 'stop', 'restart'].includes(operation)) {
        return capabilityError('operation 只能是 start、stop 或 restart')
      }
      const ops = resolvePluginInstanceOps()
      if (!ops) {
        return capabilityError('实例模块尚未就绪，无法执行实例操作')
      }
      /**
       * 操作名带在 action 里会出现两个 action 字段，这里让它保持通用，
       * 具体动作由 params.operation 记录（审计里一眼能看到 start/stop/restart）。
       */
      const result = await ops[operation as 'start' | 'stop' | 'restart'](app, instanceId)
      return result.ok
        ? { ok: true, data: { instanceId, operation, message: result.message ?? '操作已受理' } }
        : capabilityError(result.message ?? '实例操作失败')
    },
  }))

  /**
   * 备份：异地备份这类插件的核心输入。
   *
   * 只把**路径**交给插件而不是替它读文件内容：备份包动辄几百 MB，
   * 让宿主把内容喂给插件意味着整包过一次宿主内存；而插件与宿主在同一台机器上，
   * 它自己按需流式读取更合适。前提是路径必须落在备份根目录内（防记录被篡改后的穿越）。
   */
  app.post('/capabilities/backups', async request => withAudit({
    providedToken: tokenOf(request),
    body: (request.body ?? {}) as CapabilityRequest & { instanceId?: string },
    capability: 'backups:read',
    action: 'backups:list',
    exec: async () => {
      const body = (request.body ?? {}) as CapabilityRequest & { instanceId?: string }
      const instanceId = typeof body.instanceId === 'string' && body.instanceId.trim() ? body.instanceId.trim() : undefined
      const items = await listBackupsForConsumer(instanceId)
      return {
        ok: true,
        data: items.filter(item => isInsideBackupsRoot(item.filePath)),
      }
    },
  }))

  app.post('/capabilities/backups/create', async request => withAudit({
    providedToken: tokenOf(request),
    body: (request.body ?? {}) as CapabilityRequest & { instanceId?: string, note?: string },
    capability: 'backups:write',
    action: 'backups:create',
    exec: async () => {
      const body = (request.body ?? {}) as CapabilityRequest & { instanceId?: string, note?: string }
      const instanceId = typeof body.instanceId === 'string' ? body.instanceId.trim() : ''
      if (!instanceId) {
        return capabilityError('缺少 instanceId')
      }
      const instance = await getGameInstanceById(instanceId)
      if (!instance) {
        return capabilityError('实例不存在')
      }
      const note = typeof body.note === 'string' ? body.note.slice(0, 200) : undefined
      const result = await createBackupForConsumer({
        instanceId,
        note,
        // 审计里已经记了是哪个插件触发的，备份记录里也带上来源，便于人工对账
        createdBy: `plugin:${String(body.pluginId ?? 'unknown')}`,
      })
      return result.ok
        ? { ok: true, data: { backupId: result.backupId, fileName: result.fileName, sizeBytes: result.sizeBytes } }
        : capabilityError(result.message ?? '创建备份失败')
    },
  }))

  /** 删除备份：保留策略需要，属危险能力（管理员启用插件时需确认） */
  app.post('/capabilities/backups/delete', async request => withAudit({
    providedToken: tokenOf(request),
    body: (request.body ?? {}) as CapabilityRequest & { backupId?: string },
    capability: 'backups:delete',
    action: 'backups:delete',
    exec: async () => {
      const body = (request.body ?? {}) as CapabilityRequest & { backupId?: string }
      const backupId = typeof body.backupId === 'string' ? body.backupId.trim() : ''
      if (!backupId) {
        return capabilityError('缺少 backupId')
      }
      const result = await deleteBackupForConsumer(backupId)
      if (!result.ok) {
        return capabilityError(result.message ?? '删除备份失败')
      }
      return {
        ok: true,
        data: { backupId, fileRemoved: result.fileRemoved ?? false, message: result.message ?? null },
      }
    },
  }))

  /**
   * 用户操作审计：审计日志类插件的核心输入。
   *
   * 与插件调用审计的区别：这里记的是**面板操作者**（谁登录、谁点了重启），
   * 插件调用审计记的是插件自己。两者合起来才是一条完整的「谁动了什么」证据链。
   */
  app.post('/capabilities/operations', async request => withAudit({
    providedToken: tokenOf(request),
    body: (request.body ?? {}) as CapabilityRequest & { account?: string, limit?: number },
    capability: 'operations:read',
    action: 'operations:list',
    exec: () => {
      const body = (request.body ?? {}) as CapabilityRequest & { account?: string, limit?: number }
      const account = typeof body.account === 'string' && body.account.trim() ? body.account.trim() : undefined
      const limit = Number.isFinite(body.limit) ? Math.min(Math.max(Number(body.limit), 1), 500) : 100
      return {
        ok: true,
        data: {
          auditRoot: resolveOperationAuditRoot(),
          records: readOperationAudit({ account, limit }),
        },
      }
    },
  }))

  /** 插件查看自己的调用记录：便于插件自证行为，也让"宿主记了什么"对它是可见的 */
  app.post('/capabilities/audit', async request => withAudit({
    providedToken: tokenOf(request),
    body: (request.body ?? {}) as CapabilityRequest & { limit?: number },
    capability: 'instances:read',
    action: 'audit:self',
    exec: () => {
      const body = (request.body ?? {}) as CapabilityRequest & { limit?: number }
      const pluginId = typeof body.pluginId === 'string' ? body.pluginId.trim() : ''
      const limit = Number.isFinite(body.limit) ? Math.min(Math.max(Number(body.limit), 1), 200) : 50
      return {
        ok: true,
        data: {
          auditRoot: resolvePluginAuditRoot(),
          records: readPluginAudit({ pluginId, limit }),
        },
      }
    },
  }))

  /** 健康检查：插件可用它确认宿主能力服务还在，也便于排障 */
  app.get('/capabilities/ping', async () => ({ ok: true, host: 'bubblesharkpanel' }))

  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') {
    await app.close()
    throw new Error('插件能力服务启动失败：拿不到监听端口')
  }
  app.log.info({ port: address.port }, '插件能力服务已就绪')

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    token,
    close: () => app.close(),
  }
}
