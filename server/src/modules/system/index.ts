import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ApiErrorResponse, ApiSuccessResponse } from '../../../../shared/contracts/api'
import type {
  DirectoryItem,
  NetworkConfigRequest,
  PanelSettingsRequest,
  PanelSettingsSaveResponse,
  SelfCheckReport,
  SteamcmdConfigRequest,
} from '../../../../shared/contracts/system'
import {
  directoryListQuerySchema,
  directorySearchQuerySchema,
  networkConfigRequestSchema,
  panelSettingsRequestSchema,
  panelUpdateApplyRequestSchema,
  steamcmdConfigRequestSchema,
} from '../../../../shared/contracts/system'
import type { DbSystemSteamcmdConfig } from '../../shared/db/index'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { buildHostMemoryGuidance } from '../../../../shared/host-memory-guidance.ts'
import {
  readHostMemoryAvailableMb,
  readHostMemoryTotalMb,
  readProcMeminfoKb,
} from '../../shared/proc-meminfo'
import {
  isAllowedBrowsePath,
  isReadableDirectoryPath,
  listChildEntries,
  listRootDirectories,
  normalizeDirectoryPath,
  searchFilesystemEntries,
} from '../../infra/filesystem-browse'
import {
  ensureSteamcmdImage,
  isGameDstImagePresent,
  pullGameDstImage,
} from '../../infra/container'
import { resolveDockerStatus } from '../../infra/docker'
import {
  isSteamcmdRuntimeReady,
  resolveRuntimeStatus,
} from '../../infra/runtime'
import { buildSteamcmdImageReadyMessage } from '../../infra/steamcmd'
import { runSteamcmdDiagnostics } from '../../infra/container/steamcmd-diagnostics'
import { loadServerConfig } from '../../shared/config'
import { loadSteamcmdRuntimeConfig } from '../../shared/config/steamcmd'
import { getServerContainerConfig } from '../../shared/config/container'
import {
  getSystemNetworkConfig,
  getSystemPanelSettings,
  getSystemSteamcmdConfig,
  findRoleKindByUserId,
  saveSystemNetworkConfig,
  saveSystemPanelSettings,
  saveSystemSteamcmdConfig,
} from '../../shared/db/index'
import { businessError, success } from '../../shared/http/response'
import { requireAnyReadPermission, requirePermission, resolveAuthorizedContext } from './auth'
import {
  getDefaultNetworkConfig,
  getDefaultPanelSettings,
  getDefaultSteamcmdConfig,

  normalizeSteamcmdConfigBody,

  validateInstallRootPath,
} from './defaults'
import {
  clampPercent,
  ensureNetworkSamplerStarted,
  getCachedDockerStatusForSystem,
  getCachedNetworkRealtime,
  getCachedPanelVersion,
  getCachedWindowsQueueMetrics,
  getCpuUsageRate,
  getDiskUsage,
  resolveMemoryUsage,
  resolveSwapUsage,
  warmSystemMetricsCaches,
} from './metrics'
import {
  applyPanelUpdate,
  getCachedPanelUpdateStatus,
  refreshPanelUpdateStatus,
  resolveApplySupport,
  schedulePanelUpdateChecks,
} from './panel-update'
import { applyPanelPortToDeployment, resolveActualPanelPortFromRequest } from './panel-port'
import { syncDevComposeWebPort } from './dev-compose-env'
import type { PanelPortSyncResult } from './panel-port-deploy'
import { registerDatabaseBackupRoutes } from './db-backup-routes'
import { registerCommercialSupportRoutes } from './commercial'
import { registerPluginRoutes } from './plugin-routes'
import { registerRbacRoutes } from './rbac-routes'
import { collectSelfCheckReport } from './self-check'
import { createPluginRuntime } from '../../plugins/host'
import type { PluginRuntime } from '../../plugins/host'
import { PLUGIN_HOST_API_VERSION } from '../../../../shared/contracts/plugin'

/**
 * 这个请求是不是来自游客（只读预览）账号。
 *
 * 用于把「公开预览不该看到」的字段从响应里摘掉，而不是把整个接口拒掉——
 * 游客看监控台的价值全在指标本身，摘掉主机指纹不影响它。
 * 鉴权已经在调用方做过，这里只补一次角色查询（一次单表查询，且请求级已有缓存）。
 */
async function requestComesFromGuest(request: FastifyRequest): Promise<boolean> {
  const auth = await resolveAuthorizedContext(request)
  if (!auth.context) {
    return false
  }
  return await findRoleKindByUserId(auth.context.user.id) === 'guest'
}

/**
 * system 模块注册入口
 */
export function registerSystemModule(app: FastifyInstance) {
  setImmediate(warmSystemMetricsCaches)

  /**
   * 插件运行时：在面板启动后拉起已启用的插件，退出时全部停掉。
   *
   * 顺序上刻意放在 `onReady` 之后：能力服务要监听回环端口，插件进程需要拿到它的地址；
   * 面板本身不必等插件启动完成——插件起不来只影响它自己。
   */
  let pluginRuntime: PluginRuntime | null = null
  let pluginRuntimeReady: Promise<void> | null = null

  app.addHook('onReady', async () => {
    schedulePanelUpdateChecks(app)
    pluginRuntimeReady = createPluginRuntime({
      hostApiVersion: PLUGIN_HOST_API_VERSION,
      onLog: ({ pluginId, message }) => app.log.info({ pluginId }, message),
    })
      .then((runtime) => {
        pluginRuntime = runtime
        try {
          runtime.sync()
        }
        catch (error) {
          app.log.warn({ error }, '插件同步失败')
        }
      })
      .catch((error) => {
        app.log.warn({ error }, '插件运行时初始化失败，插件将被跳过')
      })
  })

  app.addHook('onClose', async () => {
    await pluginRuntimeReady
    await pluginRuntime?.shutdown()
  })

  app.get('/app/system/settings', async (request): Promise<ApiSuccessResponse<ReturnType<typeof getDefaultPanelSettings> & {
    apiPort: number
    isProduction: boolean
  }> | ApiErrorResponse> => {
    const authError = await requirePermission(request, 'settings:read')
    if (authError) {
      return authError
    }
    const config = loadServerConfig()
    const settings = await getSystemPanelSettings() ?? getDefaultPanelSettings()
    const actualPanelPort = resolveActualPanelPortFromRequest(config.port, request)
    return success({
      ...settings,
      apiPort: actualPanelPort,
      isProduction: config.mode === 'production',
    }, request)
  })

  app.post('/app/system/settings', async (request): Promise<ApiSuccessResponse<PanelSettingsSaveResponse> | ApiErrorResponse> => {
    const authError = await requirePermission(request, 'settings:write')
    if (authError) {
      return authError
    }
    const parsedBody = panelSettingsRequestSchema.safeParse(request.body ?? {})
    if (!parsedBody.success) {
      return businessError('请求参数无效', request)
    }
    const body: PanelSettingsRequest = parsedBody.data
    const panelPort = body.panelPort ?? getDefaultPanelSettings().panelPort
    const theme = body.theme ?? 'system'
    const autoUpdate = body.autoUpdate ?? true
    const checkUpdateBeforeStart = body.checkUpdateBeforeStart ?? false
    const updateCheckIntervalHours = body.updateCheckIntervalHours ?? 3
    const updateSource = body.updateSource ?? 'auto'
    if (!Number.isInteger(panelPort) || panelPort <= 0 || panelPort > 65535) {
      return businessError('面板端口不合法', request)
    }
    if (!Number.isInteger(updateCheckIntervalHours) || updateCheckIntervalHours < 1 || updateCheckIntervalHours > 168) {
      return businessError('更新检查间隔应为 1-168 小时', request)
    }
    if (!['light', 'dark', 'system'].includes(theme)) {
      return businessError('主题配置不合法', request)
    }
    if (!['auto', 'offline', 'pull'].includes(updateSource)) {
      return businessError('更新下载源不合法', request)
    }
    await saveSystemPanelSettings({
      panelPort,
      theme,
      autoUpdate,
      checkUpdateBeforeStart,
      updateCheckIntervalHours,
      updateSource,
    })
    try {
      syncDevComposeWebPort(panelPort)
    }
    catch (error) {
      app.log.warn({ error }, '同步开发环境前端端口到 panel.env 失败')
    }

    // 把端口真正写进部署配置：数据库里的 panelPort 只是记录，实际端口由部署配置决定，
    // 不写文件的话「重启后生效」永远不会发生。任何失败都不影响设置保存本身。
    let portSync: PanelPortSyncResult | null = null
    try {
      portSync = await applyPanelPortToDeployment({ port: panelPort, request })
    }
    catch (error) {
      app.log.warn({ error }, '同步面板端口到部署配置失败')
      portSync = {
        status: 'manual',
        envKey: null,
        port: panelPort,
        message: '自动同步端口配置失败，请在服务器上手动修改后重启面板，并放行新端口。',
        manualCommand: null,
      }
    }
    return success({
      isSuccess: true,
      portSync,
    }, request)
  })

  app.get('/app/system/self-check', async (request): Promise<ApiSuccessResponse<SelfCheckReport> | ApiErrorResponse> => {
    const authError = await requirePermission(request, 'settings:read')
    if (authError) {
      return authError
    }
    try {
      const report = await collectSelfCheckReport(loadServerConfig().releaseVersion)
      return success(report, request)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : '环境自检失败'
      return businessError(message, request)
    }
  })

  app.get('/app/system/filesystem/directories', async (request): Promise<ApiSuccessResponse<DirectoryItem[]> | ApiErrorResponse> => {
    const authError = await requirePermission(request, 'settings:write')
    if (authError) {
      return authError
    }
    const parsedQuery = directoryListQuerySchema.safeParse(request.query ?? {})
    if (!parsedQuery.success) {
      return businessError('请求参数无效', request)
    }
    const query = parsedQuery.data
    const rawPath = query.path?.trim()
    if (!rawPath) {
      return success(listRootDirectories(), request)
    }
    if (!path.isAbsolute(rawPath)) {
      return businessError('目录路径必须是绝对路径', request)
    }
    if (/[\0`$;&|]/.test(rawPath)) {
      return businessError('目录路径包含危险字符', request)
    }
    const normalizedPath = normalizeDirectoryPath(rawPath)
    if (!isAllowedBrowsePath(normalizedPath)) {
      return businessError('目录路径不在允许访问范围内', request)
    }
    if (!isReadableDirectoryPath(normalizedPath)) {
      return businessError('目录不存在或不可访问', request)
    }
    return success(listChildEntries(normalizedPath), request)
  })

  app.get('/app/system/filesystem/search', async (request): Promise<ApiSuccessResponse<DirectoryItem[]> | ApiErrorResponse> => {
    const authError = await requirePermission(request, 'settings:write')
    if (authError) {
      return authError
    }
    const parsedQuery = directorySearchQuerySchema.safeParse(request.query ?? {})
    if (!parsedQuery.success) {
      return businessError('请求参数无效', request)
    }
    const query = parsedQuery.data
    const keyword = query.keyword?.trim() ?? ''
    if (!keyword) {
      return success([], request)
    }
    if (keyword.length > 64) {
      return businessError('搜索关键词过长，请控制在 64 字符以内', request)
    }
    if (/[\0`$;&|]/.test(keyword)) {
      return businessError('搜索关键词包含危险字符', request)
    }
    return success(searchFilesystemEntries(keyword), request)
  })

  app.get('/app/system/steamcmd/config', async (request): Promise<ApiSuccessResponse<DbSystemSteamcmdConfig & {
    runtimeMode: 'docker' | 'native'
    runtimeStatus: 'running' | 'stopped'
    steamcmdImage: string
    gameDstImage: string
    isDockerAvailable: boolean
    isSteamcmdInstalled: boolean
    isGameDstImageInstalled: boolean
    detectedSteamcmdPath: string
    downloadRegion: string
    networkMode: string
    installMaxAttempts: number
    httpProxyConfigured: boolean
    httpsProxyConfigured: boolean
  }> | ApiErrorResponse> => {
    /**
     * 这一份配置同时服务两个页面：「系统设置」（`settings:read`）与「实例管理」里的
     * 运行环境面板（`instance:read`，安装 SteamCMD 与游戏服务端）。只给实例权限的账号
     * 此前拿到 403，界面上表现为"运行环境未就绪"——于是它连"创建实例"都被禁用。
     * 改配置仍然只认 `settings:write`。
     */
    const authError = await requireAnyReadPermission(request, ['settings:read', 'instance:read'])
    if (authError) {
      return authError
    }
    const containerConfig = getServerContainerConfig()
    const config = await getSystemSteamcmdConfig() ?? getDefaultSteamcmdConfig()
    const installRoot = containerConfig.instancesRoot
    const runtimeStatus = await resolveRuntimeStatus()
    const dockerStatus = containerConfig.runtimeMode === 'docker'
      ? await resolveDockerStatus()
      : 'stopped'
    const isDockerAvailable = dockerStatus === 'running'
    const isSteamcmdInstalled = runtimeStatus === 'running' && await isSteamcmdRuntimeReady()
    const isGameDstImageInstalled = containerConfig.runtimeMode === 'native'
      ? runtimeStatus === 'running'
      : isDockerAvailable && await isGameDstImagePresent()
    const steamcmdImage = containerConfig.steamcmdImage
    const gameDstImage = containerConfig.gameDstImage
    const steamcmdRuntime = loadSteamcmdRuntimeConfig()
    return success({
      ...config,
      steamcmdPath: containerConfig.runtimeMode === 'native'
        ? containerConfig.nativeSteamcmdPath
        : steamcmdImage,
      installRoot,
      runtimeMode: containerConfig.runtimeMode,
      runtimeStatus,
      steamcmdImage,
      gameDstImage,
      isDockerAvailable,
      isSteamcmdInstalled,
      isGameDstImageInstalled,
      detectedSteamcmdPath: isSteamcmdInstalled
        ? (containerConfig.runtimeMode === 'native' ? containerConfig.nativeSteamcmdPath : steamcmdImage)
        : '',
      downloadRegion: steamcmdRuntime.downloadRegion,
      networkMode: steamcmdRuntime.networkMode,
      installMaxAttempts: steamcmdRuntime.installMaxAttempts,
      httpProxyConfigured: Boolean(steamcmdRuntime.httpProxy),
      httpsProxyConfigured: Boolean(steamcmdRuntime.httpsProxy),
    }, request)
  })

  app.get('/app/system/steamcmd/diagnostics', async (request): Promise<ApiSuccessResponse<Awaited<ReturnType<typeof runSteamcmdDiagnostics>>> | ApiErrorResponse> => {
    const authError = await requirePermission(request, 'settings:read')
    if (authError) {
      return authError
    }
    const result = await runSteamcmdDiagnostics()
    return success(result, request)
  })

  app.post('/app/system/steamcmd/config', async (request): Promise<ApiSuccessResponse<{
    isSuccess: boolean
  }> | ApiErrorResponse> => {
    const authError = await requirePermission(request, 'settings:write')
    if (authError) {
      return authError
    }
    const parsedBody = steamcmdConfigRequestSchema.safeParse(request.body ?? {})
    if (!parsedBody.success) {
      return businessError('请求参数无效', request)
    }
    const body: SteamcmdConfigRequest = parsedBody.data
    const containerConfig = getServerContainerConfig()
    const config = {
      ...normalizeSteamcmdConfigBody(body),
      steamcmdPath: containerConfig.runtimeMode === 'native'
        ? containerConfig.nativeSteamcmdPath
        : containerConfig.steamcmdImage,
      installRoot: containerConfig.instancesRoot,
    }
    const installRootError = validateInstallRootPath(config.installRoot)
    if (installRootError) {
      return businessError(installRootError, request)
    }
    try {
      fs.mkdirSync(config.installRoot, { recursive: true })
    }
    catch (error) {
      const message = error instanceof Error ? error.message : '创建实例安装根目录失败'
      return businessError(message, request)
    }
    await saveSystemSteamcmdConfig(config)
    app.log.info({
      steamcmdPath: config.steamcmdPath,
      installRoot: config.installRoot,
    }, 'SteamCMD 配置已保存')
    return success({
      isSuccess: true,
    }, request)
  })

  app.post('/app/system/steamcmd/install', async (request): Promise<ApiSuccessResponse<{
    isSuccess: boolean
    message: string
  }> | ApiErrorResponse> => {
    const authError = await requirePermission(request, 'settings:write')
    if (authError) {
      return authError
    }
    const runtimeMode = getServerContainerConfig().runtimeMode
    if ((await resolveRuntimeStatus(true)) !== 'running') {
      return businessError(
        runtimeMode === 'native'
          ? '无法连接 systemd 用户服务管理器，请检查 gsh 用户 linger 和 user bus'
          : '无法连接 Docker，请确认面板已挂载 docker.sock（或 Windows 下 Docker Desktop 已启动）',
        request,
      )
    }
    const pullResult = await ensureSteamcmdImage()
    if (!pullResult.ok) {
      app.log.error({ error: pullResult.error }, 'SteamCMD 镜像拉取失败')
      return businessError(pullResult.error, request)
    }
    const runtimeConfig = getServerContainerConfig()
    const message = runtimeConfig.runtimeMode === 'native'
      ? `Native SteamCMD 已就绪：${runtimeConfig.nativeSteamcmdPath}`
      : buildSteamcmdImageReadyMessage(runtimeConfig.steamcmdImage)
    app.log.info({ runtimeMode, steamcmdPath: runtimeConfig.nativeSteamcmdPath, steamcmdImage: runtimeConfig.steamcmdImage }, 'SteamCMD 运行时已就绪')
    return success({
      isSuccess: true,
      message,
    }, request)
  })

  app.post('/app/system/game-dst/install', async (request): Promise<ApiSuccessResponse<{
    isSuccess: boolean
    message: string
  }> | ApiErrorResponse> => {
    const authError = await requirePermission(request, 'settings:write')
    if (authError) {
      return authError
    }
    const runtimeConfig = getServerContainerConfig()
    if ((await resolveRuntimeStatus(true)) !== 'running') {
      return businessError(
        runtimeConfig.runtimeMode === 'native'
          ? '无法连接 systemd 用户服务管理器'
          : '无法连接 Docker，请确认面板已挂载 docker.sock（或 Windows 下 Docker Desktop 已启动）',
        request,
      )
    }
    if (runtimeConfig.runtimeMode === 'native') {
      return success({
        isSuccess: true,
        message: 'Native 模式直接运行实例目录中的 DST 服务端，不需要运行镜像。',
      }, request)
    }
    const pullResult = await pullGameDstImage()
    if (!pullResult.ok) {
      app.log.error({ error: pullResult.error }, 'DST 运行镜像拉取失败')
      return businessError(pullResult.error, request)
    }
    const { gameDstImage } = getServerContainerConfig()
    const message = `DST 运行镜像已就绪：${gameDstImage}。现在可以启动已安装完成的实例。`
    app.log.info({ gameDstImage }, 'DST 运行镜像已就绪')
    return success({
      isSuccess: true,
      message,
    }, request)
  })

  app.get('/app/system/panel-update/status', async (request): Promise<ApiSuccessResponse<ReturnType<typeof getCachedPanelUpdateStatus>> | ApiErrorResponse> => {
    const authError = await requirePermission(request, 'settings:read')
    if (authError) {
      return authError
    }
    return success(getCachedPanelUpdateStatus(), request)
  })

  app.post('/app/system/panel-update/check', async (request): Promise<ApiSuccessResponse<ReturnType<typeof getCachedPanelUpdateStatus>> | ApiErrorResponse> => {
    const authError = await requirePermission(request, 'settings:write')
    if (authError) {
      return authError
    }
    if (loadServerConfig().runtimeMode === 'docker' && (await resolveDockerStatus(true)) !== 'running') {
      return businessError('无法连接 Docker，暂不能检查 Hub 镜像更新', request)
    }
    const status = await refreshPanelUpdateStatus()
    return success(status, request)
  })

  app.post('/app/system/panel-update/apply', async (request): Promise<ApiSuccessResponse<{
    status: 'updating' | 'completed' | 'ready'
    message: string
  }> | ApiErrorResponse> => {
    const authError = await requirePermission(request, 'settings:write')
    if (authError) {
      return authError
    }
    const runtimeConfig = loadServerConfig()
    if (runtimeConfig.runtimeMode === 'native') {
      // Native 不用容器镜像：只有安装器布置过特权更新组件时才能在面板内更新。
      // 老安装（未重跑过安装脚本）退回「去服务器执行命令」，而不是假装按钮能用。
      if (!resolveApplySupport(runtimeConfig).nativeSupported) {
        return businessError(
          '当前安装还没有面板内更新组件，请在服务器上执行版本状态中给出的安装命令；重跑一次安装脚本后即可在面板里一键更新。',
          request,
        )
      }
    }
    else if ((await resolveDockerStatus(true)) !== 'running') {
      return businessError('无法连接 Docker，暂不能更新 Hub 镜像', request)
    }
    const parsedBody = panelUpdateApplyRequestSchema.safeParse(request.body ?? {})
    if (!parsedBody.success) {
      return businessError('请求参数无效', request)
    }
    try {
      // download 只下载更新内容（镜像 / Native 更新包），install 才真正安装；
      // 不带 action 为旧前端的「下载并安装」
      const result = await applyPanelUpdate(parsedBody.data.action ?? 'auto')
      return success(result, request)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return businessError(message, request)
    }
  })

  app.get('/app/system/info', async (request): Promise<ApiSuccessResponse<{
    cpu: {
      cores: number
      model: string
      usageRate: number
    }
    load: {
      oneMinute: number
      fiveMinutes: number
      fifteenMinutes: number
      usageRate: number
      isSynthetic: boolean
      cpuQueueLength: number | null
      diskQueueLength: number | null
    }
    memory: {
      totalGb: number
      usedGb: number
      freeGb: number
      usageRate: number
      availableGb: number | null
      /** 未配置缓存区时为 null —— 与「配置了但已用满」必须能区分开 */
      swap: {
        totalGb: number
        usedGb: number
        freeGb: number
        usageRate: number
      } | null
    }
    memoryGuidance: import('../../../../shared/contracts/host-memory-guidance.ts').HostMemoryGuidancePayload
    disk: {
      totalGb: number
      usedGb: number
      freeGb: number
    }
    os: {
      platform: string
      release: string
      arch: string
      hostname: string
    }
    panelVersion: string
    runtimeMode: 'docker' | 'native'
    runtimeStatus: 'running' | 'stopped'
    dockerStatus: 'running' | 'stopped'
  }> | ApiErrorResponse> => {
    /**
     * 主机指标的消费方是「监控台」：它的权限点就是 `console.monitor:read`，说明里写的是
     * "查看主机 CPU / 内存 / 磁盘 / 网络与运行环境信息"，而这里返回的正是这些东西。
     * 此前只要求 `settings:read`，于是"只看监控"的角色一进监控台就是 403——
     * 监控权限点等于形同虚设。系统设置页同样消费它，所以两个权限点任一即可。
     */
    const authError = await requireAnyReadPermission(request, ['settings:read', 'console.monitor:read'])
    if (authError) {
      return authError
    }
    /**
     * 主机指纹对"只读预览"没有价值，对"找目标"很有价值。
     *
     * 游客拿到的这份数据里，`hostname` / 内核版本 / CPU 型号是最典型的"这台机器长什么样"，
     * 而预览真正需要的是 CPU / 内存 / 磁盘 / 网络这些**相对量**——它们照常返回。
     * 所以这里只对游客收敛指纹字段，不改变任何指标的数值。
     */
    const isGuest = await requestComesFromGuest(request)
    const cpuInfo = os.cpus()
    const cpuCores = Math.max(1, cpuInfo.length)
    const cpuUsageRate = getCpuUsageRate()
    const loadAvg = os.loadavg()
    const totalMem = os.totalmem()
    // 与节点卡片、通知阈值、启动守卫同口径：已用 = 总量 − MemAvailable
    const memory = resolveMemoryUsage(totalMem, readProcMeminfoKb('MemAvailable'))
    const memoryUsageRate = memory.usageRate
    const swap = resolveSwapUsage(readProcMeminfoKb('SwapTotal'), readProcMeminfoKb('SwapFree'))
    const hostTotalMb = readHostMemoryTotalMb()
    const hostAvailableMb = readHostMemoryAvailableMb()
    const memoryGuidance = buildHostMemoryGuidance({
      totalMb: hostTotalMb ?? Math.round(totalMem / 1024 / 1024),
      availableMb: hostAvailableMb,
    })
    const availableGb = hostAvailableMb !== null
      ? Number((hostAvailableMb / 1024).toFixed(2))
      : null
    const diskUsage = getDiskUsage()
    const diskUsageRate = diskUsage.totalGb > 0
      ? clampPercent((diskUsage.usedGb / diskUsage.totalGb) * 100)
      : 0

    const load = process.platform === 'win32'
      ? (() => {
        const queueMetrics = getCachedWindowsQueueMetrics()
        const cpuQueueNorm = queueMetrics.cpuQueueLength !== null
          ? clampPercent((queueMetrics.cpuQueueLength / cpuCores) * 100)
          : cpuUsageRate
        const diskQueueNorm = queueMetrics.diskQueueLength !== null
          ? clampPercent((queueMetrics.diskQueueLength / 2) * 100)
          : diskUsageRate
        const pressureRate = Number(clampPercent(
          (cpuQueueNorm * 0.55)
          + (diskQueueNorm * 0.30)
          + (memoryUsageRate * 0.15),
        ).toFixed(2))
        const equivalentOneMinute = Number(((pressureRate / 100) * cpuCores).toFixed(2))
        return {
          oneMinute: equivalentOneMinute,
          fiveMinutes: equivalentOneMinute,
          fifteenMinutes: equivalentOneMinute,
          usageRate: pressureRate,
          isSynthetic: true,
          cpuQueueLength: queueMetrics.cpuQueueLength,
          diskQueueLength: queueMetrics.diskQueueLength,
        }
      })()
      : {
        oneMinute: Number(loadAvg[0].toFixed(2)),
        fiveMinutes: Number(loadAvg[1].toFixed(2)),
        fifteenMinutes: Number(loadAvg[2].toFixed(2)),
        usageRate: Number(clampPercent((loadAvg[0] / cpuCores) * 100).toFixed(2)),
        isSynthetic: false,
        cpuQueueLength: null,
        diskQueueLength: null,
      }

    return success({
      cpu: {
        cores: cpuCores,
        model: isGuest ? '' : (cpuInfo[0]?.model ?? 'unknown'),
        usageRate: cpuUsageRate,
      },
      load,
      memory: {
        totalGb: memory.totalGb,
        usedGb: memory.usedGb,
        freeGb: memory.freeGb,
        usageRate: memory.usageRate,
        availableGb,
        swap,
      },
      memoryGuidance,
      disk: diskUsage,
      os: {
        platform: os.platform(),
        release: isGuest ? '' : os.release(),
        arch: os.arch(),
        hostname: isGuest ? '' : os.hostname(),
      },
      panelVersion: getCachedPanelVersion(),
      runtimeMode: loadServerConfig().runtimeMode,
      runtimeStatus: await resolveRuntimeStatus(),
      dockerStatus: loadServerConfig().runtimeMode === 'docker'
        ? getCachedDockerStatusForSystem()
        : 'stopped',
    }, request)
  })

  app.get('/app/system/network/realtime', async (request): Promise<ApiSuccessResponse<{
    timestamp: number
    interfaces: Array<{
      name: string
      upBps: number
      downBps: number
      totalSentBytes: number
      totalReceivedBytes: number
    }>
  }> | ApiErrorResponse> => {
    // 实时网卡流量也是监控台的一屏：与 `/app/system/info` 同一条口径（任一读权限即可）
    const authError = await requireAnyReadPermission(request, ['settings:read', 'console.monitor:read'])
    if (authError) {
      return authError
    }

    ensureNetworkSamplerStarted()
    return success(getCachedNetworkRealtime(), request)
  })

  app.get('/app/system/network/config', async (request): Promise<ApiSuccessResponse<ReturnType<typeof getDefaultNetworkConfig>> | ApiErrorResponse> => {
    const authError = await requirePermission(request, 'settings:read')
    if (authError) {
      return authError
    }

    const config = await getSystemNetworkConfig()
    return success(config ?? getDefaultNetworkConfig(), request)
  })

  app.post('/app/system/network/config', async (request): Promise<ApiSuccessResponse<{
    isSuccess: boolean
  }> | ApiErrorResponse> => {
    const authError = await requirePermission(request, 'settings:write')
    if (authError) {
      return authError
    }

    const parsedBody = networkConfigRequestSchema.safeParse(request.body ?? {})
    if (!parsedBody.success) {
      return businessError('请求参数无效', request)
    }
    const body: NetworkConfigRequest = parsedBody.data
    const networkConfig = {
      mode: body.mode ?? 'bootstrap_pending',
      httpPort: body.httpPort ?? 80,
      domain: body.domain ?? '',
      tls: {
        enabled: body.tls?.enabled ?? false,
        provider: body.tls?.provider ?? 'none',
      },
    }
    if (!Number.isInteger(networkConfig.httpPort) || networkConfig.httpPort <= 0 || networkConfig.httpPort > 65535) {
      return businessError('端口号不合法', request)
    }
    await saveSystemNetworkConfig(networkConfig)
    return success({
      isSuccess: true,
    }, request)
  })

  app.post('/app/system/network/validate', async (request): Promise<ApiSuccessResponse<{
    isValid: boolean
    message: string
  }> | ApiErrorResponse> => {
    const authError = await requirePermission(request, 'settings:read')
    if (authError) {
      return authError
    }

    const parsedBody = networkConfigRequestSchema.safeParse(request.body ?? {})
    if (!parsedBody.success) {
      return success({
        isValid: false,
        message: '请求参数无效',
      }, request)
    }
    const body: NetworkConfigRequest = parsedBody.data
    const httpPort = body.httpPort ?? 80
    if (!Number.isInteger(httpPort) || httpPort <= 0 || httpPort > 65535) {
      return success({
        isValid: false,
        message: '端口号不合法',
      }, request)
    }
    return success({
      isValid: true,
      message: '配置校验通过',
    }, request)
  })

  // 这里原本有一个 POST /app/system/network/apply：它不产生任何副作用，
  // 只回一句「配置已受理，等待网关编排模块接入」。对外暴露一个自称没实现的接口，
  // 比不提供它更容易误导集成方，因此移除；网络暴露方式（反向代理、TLS）
  // 在文档中给出，面板自身不做网关编排。
  registerDatabaseBackupRoutes(app)
  registerCommercialSupportRoutes(app)
  // 成员与角色：和系统设置同属"面板怎么运行"，但权限点独立（member:*/role:*）
  registerRbacRoutes(app)
  // 运行时对象在 onReady 里才创建，因此传一个读取函数而不是实例本身
  registerPluginRoutes(app, () => pluginRuntime)
}
