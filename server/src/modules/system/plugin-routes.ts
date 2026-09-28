import type { FastifyInstance } from 'fastify'
import type { Readable } from 'node:stream'
import type { ApiErrorResponse, ApiSuccessResponse } from '../../../../shared/contracts/api'
import type {
  PluginAuditResult,
  PluginImportInspectResult,
  PluginImportResult,
  PluginListResult,
  PluginToggleRequest,
} from '../../../../shared/contracts/plugin'
import {
  pluginAuditQuerySchema,
  pluginImportRequestSchema,
  pluginToggleRequestSchema,
} from '../../../../shared/contracts/plugin'
import type { OperationAuditResult } from '../../../../shared/contracts/audit'
import { operationAuditQuerySchema } from '../../../../shared/contracts/audit'
import { businessError, success } from '../../shared/http/response'
import { scanPlugins, setPluginEnabled } from '../../plugins/registry'
import { mergePluginStore } from '../../plugins/store-merge'
import {
  installPluginPackage,
  receivePluginPackage,
  resolvePluginPackageLimitBytes,
} from '../../plugins/import-service'
import { readPluginAudit, resolvePluginAuditRoot } from '../../plugins/audit-store'
import { readOperationAudit, resolveOperationAuditRoot } from '../../shared/audit/operation-audit'
import type { PluginRuntime } from '../../plugins/host'
import { requirePermission } from './auth'

/**
 * 插件管理接口。
 *
 * 已交付：装载校验、启用状态、**插件进程的启动与停止**、能力授予、**商店目录与插件包导入**。
 * 未交付：插件与宿主之间的高层业务协议（例如插件如何注册自己的页面数据源），
 * 目前插件能通过能力服务读实例、指标与控制台日志。
 *
 * 现状对外口径：面板里没有随包发布的第三方插件，也没有随包发布的 Pro 插件；
 * 插件列表通常只显示管理员自己放进去的目录，外加官方目录里尚未安装的那些条目。
 *
 * **本页不是收银台**：没有下单、没有支付、没有自动下载。插件包由用户从面板之外拿到，
 * 这里只负责校验并把它放对位置；付款与合同都在面板之外完成。
 */
export function registerPluginRoutes(app: FastifyInstance, getRuntime: () => PluginRuntime | null): void {
  /**
   * 插件包上传用**专属内容类型**接收原始二进制体。
   *
   * 为什么不复用 `application/octet-stream`：它是 Fastify 的全局注册项，
   * 而 backup 模块已经注册过它。同一个内容类型注册两次会直接抛
   * `FST_ERR_CTP_ALREADY_PRESENT`，那会让**面板启动失败**——
   * 一个上传入口不值得拿启动风险去换。files 模块同样为此用了自己的内容类型。
   * 解析器只把流交给路由，落盘与校验都在 `receivePluginPackage` 里。
   */
  app.addContentTypeParser('application/x-gsh-plugin-package', (_request, payload, done) => {
    done(null, payload)
  })

  app.get('/app/system/plugins', async (request): Promise<ApiSuccessResponse<PluginListResult> | ApiErrorResponse> => {
    const authError = await requirePermission(request, 'plugin:read')
    if (authError) {
      return authError
    }
    const statuses = new Map((getRuntime()?.listStatus() ?? []).map(item => [item.pluginId, item]))
    const scanned = scanPlugins({
      runtimeStatus: pluginId => statuses.get(pluginId),
    })
    // 本地扫描结果 × 官方目录：未安装的插件也要出现在列表里，否则空目录时页面空无一物
    return success(mergePluginStore(scanned), request)
  })

  app.post('/app/system/plugins/toggle', async (request): Promise<ApiSuccessResponse<{ message: string }> | ApiErrorResponse> => {
    const authError = await requirePermission(request, 'plugin:manage')
    if (authError) {
      return authError
    }
    const parsed = pluginToggleRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      return businessError('请求参数无效', request)
    }
    const body: PluginToggleRequest = parsed.data
    const result = setPluginEnabled({
      pluginId: body.pluginId,
      enabled: body.enabled,
      acknowledgeDangerous: body.acknowledgeDangerous,
    })
    if (!result.ok) {
      return businessError(result.message, request)
    }
    /**
     * 状态落盘后同步进程：启用即拉起、停用即杀掉。
     * 同步是幂等的，失败也不会抛——插件起不来不该让「停用」这个动作失败，
     * 否则管理员会遇到"想停停不掉"。
     */
    try {
      getRuntime()?.sync()
    }
    catch (error) {
      app.log.warn({ error, pluginId: body.pluginId }, '同步插件进程失败')
    }
    app.log.info({ pluginId: body.pluginId, enabled: body.enabled }, '插件启用状态已变更')
    return success({ message: result.message }, request)
  })

  /**
   * 导入插件包第一步：接收上传、解压到临时目录、做一次装载校验，并把结论返回给用户确认。
   *
   * 这一步**不写插件目录**。用户要在这之后才决定是否导入——把「这是谁签的、
   * 装完还缺哪项授权」放在确认之前说清楚，比事后报错友好得多。
   *
   * 体积上限与 bodyLimit 对齐：插件是脚本与清单，64 MB 足够，
   * 不做成存档导入那样的 2 GB——留一个没人会用到的巨大入口，只会扩大攻击面。
   */
  app.post('/app/system/plugins/import/inspect', { bodyLimit: resolvePluginPackageLimitBytes() }, async (request): Promise<ApiSuccessResponse<PluginImportInspectResult> | ApiErrorResponse> => {
    const authError = await requirePermission(request, 'plugin:manage')
    if (authError) {
      return authError
    }
    const received = await receivePluginPackage(request.body as unknown as Readable)
    if (!received.ok) {
      return businessError(received.message, request)
    }
    app.log.info({ pluginId: received.analysis.pluginId }, '插件包已上传并通过校验，等待确认导入')
    /**
     * 必须把 `uploadId` 一起返回：第二步靠它认领这次上传，丢了这个字段，
     * 「确认导入」就永远拿不到自己刚才校验过的那个包——而前端只会看到一个
     * 校验通过、却导不进去的界面。类型上也用 `PluginImportInspectResult`
     * 声明，让契约与实现对不上时编译就失败，而不是等用户点按钮才发现。
     */
    return success({ uploadId: received.uploadId, analysis: received.analysis }, request)
  })

  /**
   * 导入插件包第二步：凭第一步的 uploadId 完成落位。
   *
   * 校验会在这一步重跑（见 `installPluginPackage` 的注释）：
   * 两阶段之间隔着用户思考的时间，真正写进插件目录的内容必须是刚刚校验过的那些字节。
   * 导入后**默认停用**——要不要让它跑起来由管理员决定，与启停开关保持同一套语义。
   */
  app.post('/app/system/plugins/import', async (request): Promise<ApiSuccessResponse<PluginImportResult> | ApiErrorResponse> => {
    const authError = await requirePermission(request, 'plugin:manage')
    if (authError) {
      return authError
    }
    const parsed = pluginImportRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      return businessError('请求参数无效', request)
    }
    const installed = installPluginPackage(parsed.data.uploadId)
    if (!installed.ok) {
      return businessError(installed.message, request)
    }
    /**
     * 落盘后同步一次运行时：新插件是停用状态，这里不会把它拉起来，
     * 但同步会让注册表与磁盘保持一致，避免出现「列表里有、宿主不知道」的中间态。
     */
    try {
      getRuntime()?.sync()
    }
    catch (error) {
      app.log.warn({ error, pluginId: installed.result.pluginId }, '同步插件进程失败')
    }
    app.log.info({
      pluginId: installed.result.pluginId,
      version: installed.result.version,
      signed: installed.result.signed,
      state: installed.result.state,
    }, '插件包已导入')
    return success(installed.result, request)
  })

  /**
   * 插件调用审计：管理员查看「哪个插件调用了什么、结果如何」。
   *
   * 这是插件可信度的唯一客观依据——插件自己的日志由它自己写，宿主侧的记录才不受它控制。
   */
  app.get('/app/system/plugins/audit', async (request): Promise<ApiSuccessResponse<PluginAuditResult> | ApiErrorResponse> => {
    const authError = await requirePermission(request, 'plugin:read')
    if (authError) {
      return authError
    }
    const parsed = pluginAuditQuerySchema.safeParse(request.query ?? {})
    if (!parsed.success) {
      return businessError('请求参数无效', request)
    }
    const runtime = getRuntime()
    const records = runtime
      ? runtime.readAudit({ pluginId: parsed.data.pluginId, limit: parsed.data.limit })
      : readPluginAudit({ pluginId: parsed.data.pluginId, limit: parsed.data.limit })
    return success({ auditRoot: resolvePluginAuditRoot(), records }, request)
  })

  /**
   * 用户操作审计：谁在什么时候对面板做了什么（含被拒的写操作）。
   * 这条能力此前只存在于「应用日志」里——README 长期写着「查不到谁在什么时候重启了世界」。
   */
  app.get('/app/system/audit/operations', async (request): Promise<ApiSuccessResponse<OperationAuditResult> | ApiErrorResponse> => {
    // 操作记录是独立的权限点：能读面板设置的人不一定该看到"谁改了什么"，
    // 而审计的价值恰恰在于它的可见范围更小
    const authError = await requirePermission(request, 'audit:read')
    if (authError) {
      return authError
    }
    const parsed = operationAuditQuerySchema.safeParse(request.query ?? {})
    if (!parsed.success) {
      return businessError('请求参数无效', request)
    }
    return success({
      auditRoot: resolveOperationAuditRoot(),
      records: readOperationAudit({ account: parsed.data.account, limit: parsed.data.limit }),
    }, request)
  })
}
