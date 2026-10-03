import type { FastifyInstance, FastifyRequest } from 'fastify'
import { withInstanceContentActivity } from '../../shared/instance-content/operation'
import type { ApiErrorResponse, ApiSuccessResponse } from '../../../../shared/contracts/api'
import type {
  PlayerSummariesDto,
  RoomSummariesDto,
  WorldSummariesDto,
} from '../../../../shared/contracts/dst-summary'
import {
  createInstanceBodySchema,
  instanceActionBodySchema,
  instanceIdsBodySchema,
  instanceInstallLogQuerySchema,
  instanceListQuerySchema,
  instanceStatusCountsQuerySchema,
} from '../../../../shared/contracts/instance'
import type {
  InstanceInstallLogPayload,
  InstanceListQuery,
  InstanceStatusCounts,
  InstanceSummaryItem,
  InstallableGameItem,
} from '../../../../shared/contracts/instance'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {
  createGameInstance,
  deleteGameInstanceById,
  getGameInstanceById,
  getServerNodeById,
  getSystemSteamcmdConfig,
  listGameInstances,
  removePlayerProfilesByInstance,
  updateGameInstanceRuntime,
} from '../../shared/db/index'
import type { DbInstanceRuntimeFailureKind } from '../../shared/db/types'
import {
  deleteInstallLogFile,
  readInstallLogContent,
} from '../../shared/instance-install/log-store'
import { formatInstallLogContent } from '../../shared/instance-install/log-format'
import { isSteamcmdAppUpdateBusy } from '../../infra/container/steamcmd-app-update-queue'
import { isSteamcmdImagePresent } from '../../infra/container'
import { describeSystemdExitReason, readHostMemorySnapshot, resolveShardMemoryCapMb } from '../../infra/container/exit-reason'
import {
  buildDstStartBlockedMessage,
  diagnoseDstInstallReadiness,
} from '../../infra/game-adapter/dst/install-readiness'
import { DST_APP_ID } from '../../infra/game-adapter/dst/constants'
import { ensureDstLayout } from '../../infra/game-adapter/dst/cluster-config'
import { syncInstanceModFilesFromDb } from '../mod/mod-file-sync-service'
import { createInstanceBackup } from '../backup/backup-service'
import { addUserInstanceGrants, deleteInstanceGrantsByInstanceId, getSystemBackupSettings } from '../../shared/db/index'
import { allocateDstGamePort } from './dst-port-service'
import { registerDstContainerCommandPort } from '../../shared/instance/dst-container-command-port'
import { applyDstPortAutoAllocate, probeDstPortConflictForStart, resolveDstGamePortForStart } from './dst-port-sync'
import { ErrorCode } from '../../../../shared/constants/error-code'
import type { PermissionKey } from '../../../../shared/constants/permissions'
import type { ContainerInspect } from '../../infra/container/types'
import {
  ensureContainerRuntimeReady,
  ensureInstanceContainerLogFollow,
  hasMasterReadyMarker,
  inspectInstanceShardRuntime,
  isHealthyRuntimeForResurrect,
  isInstanceContainerRunning,
  removeInstanceContainer,
  resolveDefaultInstanceInstallPath,
  resolveInstanceContainerRef,
  resolveShardReadyWaitSec,
  readRecentInstanceContainerLogLines,
  sendInstanceContainerCommand,
  startInstanceContainer,
  stopInstanceContainer,
} from './container-lifecycle'
import {
  cancelInstallJob,
  clearInstallJobTracking,
  getInstallLogsDirPath,
  getSteamcmdLoginCredentials,
  getInstallHostMemoryPressure,
  isAnyInstallJobActive,
  isInstallJobActive,
  mapDbInstallLogStatusToResponse,
  reconcileOrphanedSteamcmdOnPanelReady,
  reconcileStaleInstallingInstances,
  shouldAllowInstallDespiteUpToDate,
  startInstallJob,
} from './install-service'
import { prepareInstallPathForRuntime, prepareInstallPathForSteamcmd } from './install-path'
import { buildRestartLoopWarning, shouldClearRuntimeWarning } from './runtime-warning'
import { resolveRuntimeReadiness, type InstanceRuntimeReadiness } from './runtime-readiness'
import { buildRuntimeFailureWarning, classifyRuntimeFailure } from './runtime-failure'
import { registerInstanceScheduledOps } from './scheduled-entry'
import { buildInternalInstanceRequest, registerPluginInstanceOps } from './instance-plugin-ops'
import { startInstanceExitWatch } from './exit-watch'
import { businessError, success, unauthorized } from '../../shared/http/response'
import { hostMemoryPressureError } from '../../shared/http/host-memory-pressure-error'
import { instanceConsoleLogStore } from '../../shared/instance-runtime/console-log-store'
import { registerInstanceMetricsRoute } from './metrics'
import { registerMigrationExportRoutes } from './migration-export-routes'
import { registerInstanceRoutes } from './instance-routes'
import { getPlayerSummaries, getRoomSummaries, getWorldSummaries, toInstanceSummaryItem } from './dst-summary'
import type { InstanceUpdateCheckJobStatus } from './update-check'
import { readLocalBuildId } from '../../shared/steam-update/build-id'
import {
  enqueueInstanceUpdateCheck,
  getInstanceUpdateCheckJobStatus,
  refreshInstanceUpdateStatus,
  resolveStartBlockedByPendingUpdate,
  resolveSteamcmdCommandForUpdateCheck,
  scheduleInstanceUpdateChecks,
} from './update-check'
import { authorizeInstance, requirePermission, resolveAnyReadPermission, resolveAuthorizedContext, resolveInstanceScope, resolveVisibleInstanceIds } from '../system/auth'
import { loadServerConfig } from '../../shared/config'

const LOCAL_NODE_ID = 'local-node'

/**
 * 实例级启动锁：同一实例的启动必须串行。
 * 并发调用（双击、多标签页、前端重试）会同时读到「容器未运行」，随后各自创建同名容器，
 * 第二个因重名失败并把实例误标成 error，而实例其实已在运行。
 */
const instanceStartLocks = new Set<string>()
const DANGEROUS_WINDOWS_PATHS = [
  'Windows',
  'Program Files',
  'Program Files (x86)',
  'ProgramData',
  'Users',
]
const INSTALLABLE_GAMES: InstallableGameItem[] = [
  {
    appId: '343050',
    name: '饥荒联机（Dedicated Server）',
    steamcmdLoginMode: 'anonymous',
  },
]

/**
 * 实例模块的鉴权入口（**不带实例维度**）。
 *
 * 默认 `instance:read`：列表、可安装游戏清单、状态计数这类「聚合读」用它。
 * **针对某个实例的操作不要用它**，改用 `authorizeInstance`——
 * 后者在权限点之外还会校验该账号对这个实例的授权，并拒绝游客角色的写操作。
 */
async function verifyAuthorized(
  request: FastifyRequest,
  permission: PermissionKey = 'instance:read',
): Promise<ApiErrorResponse | undefined> {
  return requirePermission(request, permission)
}

function normalizePort(value: number | undefined): number | null {
  if (typeof value === 'undefined') {
    return null
  }
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    return null
  }
  return value
}

function normalizeInstallPath(value: string | undefined): string {
  return value?.trim() ?? ''
}

function resolveInstallableGameByAppId(value: string | undefined): InstallableGameItem | undefined {
  const appId = value?.trim() ?? ''
  return INSTALLABLE_GAMES.find(game => game.appId === appId)
}

async function getDefaultSteamInstallPath(_gameCode: string, instanceId: string): Promise<string> {
  return resolveDefaultInstanceInstallPath(instanceId)
}

async function checkContainerInstallReady(): Promise<{ ok: boolean, message?: string }> {
  return ensureContainerRuntimeReady()
}

async function requireContainerRuntime(request: FastifyRequest): Promise<ApiErrorResponse | undefined> {
  const runtimeReady = await checkContainerInstallReady()
  if (!runtimeReady.ok) {
    return businessError(runtimeReady.message ?? '游戏运行时未就绪', request)
  }
}

/** Linux 系统目录黑名单：实例目录不得落入（对 POSIX 绝对路径生效） */
const DANGEROUS_POSIX_PREFIXES = [
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/boot',
  '/proc',
  '/sys',
  '/dev',
  '/run',
  '/root',
]

export interface InstallPathValidationOptions {
  /** 实例根目录（GSH_INSTANCES_ROOT） */
  instancesRoot?: string
  /** instances-root=必须位于实例根目录之下；缺省时仅做危险目录过滤（兼容既有实例的启动/删除） */
  policy?: 'instances-root' | 'any'
}

function validateInstallPath(rawPath: string, options: InstallPathValidationOptions = {}): string | undefined {
  if (!rawPath) {
    return '安装路径不能为空'
  }
  if (!path.isAbsolute(rawPath)) {
    return '安装路径必须为绝对路径'
  }
  if (/[\0`$;&|]/.test(rawPath)) {
    return '安装路径包含危险字符'
  }
  const normalized = path.normalize(rawPath)
  const segments = normalized.split(/[\\/]/).filter(Boolean)
  if (segments.includes('..')) {
    return '安装路径不能包含上级目录跳转'
  }
  const resolved = path.resolve(normalized)
  const root = path.parse(resolved).root
  if (resolved === root) {
    return '安装路径不能为磁盘根目录'
  }
  if (process.platform === 'win32') {
    const blocked = DANGEROUS_WINDOWS_PATHS.map((item) => {
      return path.resolve(root, item).toLowerCase()
    })
    const resolvedLower = resolved.toLowerCase()
    if (blocked.some(item => resolvedLower === item || resolvedLower.startsWith(`${item}\\`))) {
      return '安装路径命中过滤规则，请使用业务目录'
    }
  }
  // Linux 系统目录黑名单：防止实例目录（以及删除时的 rmSync -rf）触达 /etc、/usr 等。
  if (resolved.startsWith('/')) {
    const resolvedLower = resolved.toLowerCase()
    if (DANGEROUS_POSIX_PREFIXES.some(item => resolvedLower === item || resolvedLower.startsWith(`${item}/`))) {
      return '安装路径命中系统目录过滤规则，请使用实例数据目录'
    }
  }
  // 创建实例时强制收敛到实例根目录，杜绝"实例管理员≈宿主 root"的挂载提权路径。
  if (options.policy === 'instances-root' && options.instancesRoot) {
    const instancesRoot = path.resolve(options.instancesRoot)
    const relative = path.relative(instancesRoot, resolved)
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      return '安装路径必须位于实例数据目录（GSH_INSTANCES_ROOT）之下；如确需自定义目录，请设置 GSH_INSTALL_PATH_POLICY=any 并自行承担隔离风险'
    }
  }
}

/** 运行期告警要落库的实例字段：文案 + 归因（归因供前端决定是否给出扩容引导） */
type RuntimeWarningTarget = {
  id: string
  runtimeWarning: string | null
  runtimeFailureKind: DbInstanceRuntimeFailureKind | null
}

/**
 * 写运行期告警；文案与归因都没变就不写库。
 *
 * 对账跑在每个列表/详情请求上，而这个告警的文案会随重启次数、加载时长变化，
 * 无脑写库等于把每次轮询都变成一次 UPDATE。
 */
async function applyRuntimeWarning(
  app: FastifyInstance,
  instance: RuntimeWarningTarget,
  message: string | null,
  failureKind: DbInstanceRuntimeFailureKind | null,
): Promise<void> {
  if (instance.runtimeWarning === message && instance.runtimeFailureKind === failureKind) {
    return
  }
  await updateGameInstanceRuntime(instance.id, { runtimeWarning: message, runtimeFailureKind: failureKind })
  if (message) {
    app.log.warn({ instanceId: instance.id, failureKind }, '实例运行期告警已更新')
  }
}

/**
 * 崩溃循环告警。
 *
 * 进程能被运行时反复拉起时，实例状态一直显示「运行中」，服主会以为一切正常；
 * 实际上服务器可能从未加载完成，玩家连不上（大厅搜不到、直连报失去联系）。
 *
 * 写 runtimeWarning 而不是 lastError：lastError 会被「启动失败」「停止实例」
 * 与状态对账反复覆盖，实测出现过写入一秒后就被清空、服主永远看不到的情况。
 *
 * 措辞与判据都在 `runtime-warning.ts`：`restarts` 是累计值，只看它会把
 * 「启动时崩过一次、之后一直稳跑」也报成正在崩溃循环。
 */
async function warnInstanceRestartLoop(
  app: FastifyInstance,
  instance: RuntimeWarningTarget,
  snapshot: ContainerInspect,
): Promise<void> {
  const reason = describeSystemdExitReason(snapshot.exitResult, resolveShardMemoryCapMb(), readHostMemorySnapshot())
  const message = buildRestartLoopWarning({
    restarts: snapshot.restarts ?? 0,
    restarting: snapshot.restarting === true,
    ...(snapshot.uptimeSeconds !== undefined ? { uptimeSeconds: snapshot.uptimeSeconds } : {}),
    exitReason: reason,
  })
  await applyRuntimeWarning(app, instance, message, null)
}

/** 宿主机可用缓冲（可用内存 + 缓存区余量，MiB）；读不到任一项时为 null */
function readHostBufferMb(): number | null {
  const memory = readHostMemorySnapshot()
  if (memory.availableMb === null) {
    return null
  }
  return memory.availableMb + (memory.swapFreeMb ?? 0)
}

/**
 * 实例在跑但**世界还没就绪**时的结论。
 *
 * 先问「是不是内存问题」：这决定界面要不要给出「增加缓存区」的引导。不是内存问题就退回
 * 重启告警那套措辞——把 Mod 报错误判成缺内存，会让人白折腾一轮缓存区。
 */
async function reportRuntimeIssue(
  app: FastifyInstance,
  instance: RuntimeWarningTarget,
  snapshot: ContainerInspect,
  readiness: InstanceRuntimeReadiness,
): Promise<void> {
  const shardCapMb = resolveShardMemoryCapMb()
  const failure = classifyRuntimeFailure({
    readySeen: readiness.state === 'ready',
    restarts: snapshot.restarts ?? 0,
    restarting: snapshot.restarting === true,
    ...(snapshot.exitResult !== undefined ? { exitResult: snapshot.exitResult } : {}),
    ...(snapshot.memOomKillCount !== undefined ? { memOomKillCount: snapshot.memOomKillCount } : {}),
    ...(snapshot.memPeakMb !== undefined ? { memPeakMb: snapshot.memPeakMb } : {}),
    ...(shardCapMb !== undefined ? { shardCapMb } : {}),
    bufferMb: readHostBufferMb(),
    loadingSeconds: readiness.loadingSeconds,
    notReadyAfterSec: resolveShardReadyWaitSec(),
  })
  if (failure) {
    await applyRuntimeWarning(app, instance, buildRuntimeFailureWarning(failure), failure.kind)
    return
  }
  await warnInstanceRestartLoop(app, instance, snapshot)
}

/** 主世界已停、洞穴还在跑：只写运行期警告，不占用 lastError（它留给真正的启动失败） */
async function warnCavesLeftRunning(
  app: FastifyInstance,
  instance: RuntimeWarningTarget,
): Promise<void> {
  const message = '主世界分片已停止，但洞穴分片仍在运行。请在实例控制里重新启动或停止实例，避免洞穴单独占着内存。'
  await applyRuntimeWarning(app, instance, message, null)
}

/**
 * 服务重启后 DB 可能仍保留 running；与运行时实际状态对齐。
 *
 * 四种情况必须分开处理，压成一个布尔值正是实例状态在「运行中 / 已停止」之间来回跳的根源：
 * 运行中、崩溃后等待运行时拉起（同样算运行中）、运行时单元已不存在（真停了）、问不到运行时（保持现状）。
 */
async function reconcileStaleRunningInstances(app: FastifyInstance): Promise<number> {
  const instances = await listGameInstances({ status: 'running' })
  let reconciled = 0
  for (const instance of instances) {
    if (instance.nodeId !== LOCAL_NODE_ID) {
      continue
    }
    const probe = await inspectInstanceShardRuntime(instance.id)
    // 问不到运行时（systemd user bus 不可达等）：保持现状，不能把运行中的实例判成已停止
    if (probe.unitExists && !probe.snapshot) {
      app.log.debug({ instanceId: instance.id }, '实例运行时探测失败，保持当前状态')
      continue
    }
    const snapshot = probe.snapshot
    if (snapshot?.running) {
      if (!instance.runtimeStartedAt) {
        await updateGameInstanceRuntime(instance.id, {
          runtimeStartedAt: new Date().toISOString(),
        })
      }
      // 本轮的就绪标记只在尚未就绪时查一次：一旦就绪就不再读分片日志，列表轮询没有额外开销。
      // 「进程在跑」与「服务器能接客」是两件事，只报前者会让服主以为房间已经能被搜到。
      let runtimeReadyAt = instance.runtimeReadyAt
      if (!runtimeReadyAt && instance.installPath && hasMasterReadyMarker(instance.id, instance.installPath)) {
        runtimeReadyAt = new Date().toISOString()
        await updateGameInstanceRuntime(instance.id, { runtimeReadyAt, runtimeFailureKind: null })
      }
      const readiness = resolveRuntimeReadiness({
        status: instance.status,
        runtimeReadyAt,
        runtimeStartedAt: instance.runtimeStartedAt,
        notReadyAfterSec: resolveShardReadyWaitSec(),
      })
      // 崩溃循环后自己站稳、且已连续干净运行足够久的实例：旧警告自己消失，也不再写新的
      if (shouldClearRuntimeWarning(snapshot.uptimeSeconds)) {
        await applyRuntimeWarning(app, instance, null, null)
      }
      else {
        await reportRuntimeIssue(app, instance, snapshot, readiness)
      }
      await ensureInstanceContainerLogFollow(instance.id)
      continue
    }
    // master 不在运行：确认洞穴分片是否还在跑。两个分片生命周期本应一致，
    // 只剩洞穴在跑时既白占内存，又让服主以为「已经停了」，必须如实说出来。
    const cavesProbe = await inspectInstanceShardRuntime(instance.id, 'caves')
    const cavesStillRunning = cavesProbe.snapshot?.running === true
    await updateGameInstanceRuntime(instance.id, {
      status: 'stopped',
      containerId: null,
      runtimePid: null,
      runtimeStartedAt: null,
    })
    reconciled++
    if (cavesStillRunning) {
      await warnCavesLeftRunning(app, instance)
    }
    app.log.info({ instanceId: instance.id }, '实例运行时不存在，已同步状态为已停止')
  }
  return reconciled
}

/**
 * DB 为 stopped/error 但容器仍在运行时的对齐（如异常退出后面板重启）。
 *
 * 关键：正在被运行时自动拉起（systemd 的 auto-restart 窗口）或已经重启过的实例，
 * 属于崩溃循环而不是「容器还在跑」。此处若把状态翻回运行中，就会抹掉上一趟对账
 * 刚写入的崩溃告警——线上实测同一个请求里两趟对账互相覆盖，服主永远看不到原因。
 */
async function reconcileStoppedButContainerRunning(app: FastifyInstance): Promise<number> {
  const instances = await listGameInstances()
  let reconciled = 0
  for (const instance of instances) {
    if (instance.nodeId !== LOCAL_NODE_ID) {
      continue
    }
    if (instance.status !== 'stopped' && instance.status !== 'error') {
      continue
    }
    const probe = await inspectInstanceShardRuntime(instance.id)
    const snapshot = probe.snapshot
    if (!snapshot?.running) {
      continue
    }
    if (!isHealthyRuntimeForResurrect(snapshot)) {
      await warnInstanceRestartLoop(app, instance, snapshot)
      continue
    }
    const ref = await resolveInstanceContainerRef(instance.id)
    await updateGameInstanceRuntime(instance.id, {
      status: 'running',
      containerId: ref?.id ?? instance.containerId,
      runtimeStartedAt: instance.runtimeStartedAt ?? new Date().toISOString(),
      runtimeWarning: null,
      // 这一轮到底就绪没有无法确认：清空让下一趟对账重新判定，而不是沿用上一次的结论
      runtimeReadyAt: null,
      runtimeFailureKind: null,
    })
    await ensureInstanceContainerLogFollow(instance.id)
    reconciled++
    app.log.info({ instanceId: instance.id }, '实例运行时仍在运行，已同步状态为运行中')
  }
  return reconciled
}

async function reconcileInstanceRuntimeState(app: FastifyInstance): Promise<void> {
  await reconcileStaleRunningInstances(app)
  await reconcileStoppedButContainerRunning(app)
  await reconcileStaleInstallingInstances(app)
}

/**
 * 列表类路由的公共前半段：**判这张列表自己的读权限** + 按实例授权过滤 + 把运行态同步到最新。
 *
 * `permission` 是这张列表自己的读权限点（房间列表 `room:read`、世界列表 `world:read`、
 * 玩家列表 `player:read`），**不是** `instance:read`——那正是这次解耦的关键：
 * 一个模块的列表只需要它自己的读权限，否则"看房间"会被迫等于"能看实例管理"。
 */
async function resolveVisibleInstances(
  app: FastifyInstance,
  request: FastifyRequest,
  permission: PermissionKey,
  payload: InstanceListQuery,
): Promise<{ error?: ApiErrorResponse, instances?: Awaited<ReturnType<typeof listGameInstances>> }> {
  const scope = await resolveInstanceScope(request, permission)
  if (scope.error || !scope.instanceIds) {
    return { error: scope.error ?? businessError('无法确定可见实例范围', request) }
  }
  await reconcileInstanceRuntimeState(app)
  const instances = await listGameInstances({
    nodeId: payload.nodeId?.trim() || undefined,
    status: payload.status,
    keyword: payload.keyword?.trim() || undefined,
  })
  // 可见范围是**过滤条件**而不是提示：没被授权的实例，连"存在过"都不该出现
  const visible = new Set(scope.instanceIds)
  return { instances: instances.filter(item => visible.has(item.id)) }
}

async function handleListInstances(
  app: FastifyInstance,
  request: FastifyRequest,
  payload: InstanceListQuery,
): Promise<ApiSuccessResponse<Awaited<ReturnType<typeof listGameInstances>>> | ApiErrorResponse> {
  const resolved = await resolveVisibleInstances(app, request, 'instance:read', payload)
  if (resolved.error || !resolved.instances) {
    return resolved.error ?? businessError('无法确定可见实例范围', request)
  }
  return success(resolved.instances, request)
}

/** 单次遍历统计各状态实例数（全量口径，供统计卡使用） */
function countInstanceStatus(
  instances: Awaited<ReturnType<typeof listGameInstances>>,
): InstanceStatusCounts {
  const counts: InstanceStatusCounts = {
    total: 0,
    pendingInstall: 0,
    running: 0,
    stopped: 0,
    installing: 0,
    error: 0,
  }
  for (const item of instances) {
    counts.total++
    switch (item.status) {
      case 'pending_install':
        counts.pendingInstall++
        break
      case 'running':
        counts.running++
        break
      case 'stopped':
        counts.stopped++
        break
      case 'installing':
        counts.installing++
        break
      case 'error':
        counts.error++
        break
    }
  }
  return counts
}

/**
 * instance 模块注册入口
 * 负责游戏实例生命周期管理（创建、启动、停止、重启、删除）。
 */
export function registerInstanceModule(app: FastifyInstance) {
  registerInstanceRoutes(app, registerInstanceRouteHandlers)
}

function registerInstanceRouteHandlers(app: FastifyInstance) {
  registerDstContainerCommandPort({
    isInstanceContainerRunning,
    readRecentInstanceContainerLogLines,
    sendInstanceContainerCommand,
  })
  registerInstanceMetricsRoute(app)
  // 迁移包导出：把实例存档整理成另一台机器可直接导入的包（报告与打包共用集群迁移模块）
  registerMigrationExportRoutes(app)
  app.post('/app/instance/list', async (request) => {
    const body = instanceListQuerySchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    return handleListInstances(app, request, body.data)
  })

  // 统计卡计数：跟随节点/关键词范围，不受 status 筛选影响，前端切换状态标签时数字保持稳定
  app.post('/app/instance/status-counts', async (request): Promise<ApiSuccessResponse<InstanceStatusCounts> | ApiErrorResponse> => {
    const body = instanceStatusCountsQuerySchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const scope = await resolveInstanceScope(request, 'instance:read')
    if (scope.error || !scope.instanceIds) {
      return scope.error ?? businessError('无法确定可见实例范围', request)
    }
    await reconcileInstanceRuntimeState(app)
    const instances = await listGameInstances({
      nodeId: body.data.nodeId?.trim() || undefined,
      keyword: body.data.keyword?.trim() || undefined,
    })
    // 计数也要过滤：否则无权账号能从"共 5 个实例"这类数字里推断出别的实例存在
    const visible = new Set(scope.instanceIds)
    return success(countInstanceStatus(instances.filter(item => visible.has(item.id))), request)
  })

  /**
   * 三个「按模块投影」的列表接口：房间 / 世界 / 玩家。
   *
   * 为什么不是一个共用接口：菜单可见性的唯一判据是**读权限点**，而这些列表页各有自己的
   * 读权限。共用一个要求 `instance:read` 的接口，就会逼出"取消「查看实例」把房间/世界/玩家
   * （以及 Mod/备份/计划任务/成员管理）的菜单一起收走"这种耦合。拆开之后，每个模块自己的
   * 读权限就够用，返回的数据也只剩这一页要用的字段。
   */
  app.post('/app/instance/room-summaries', async (request): Promise<ApiSuccessResponse<RoomSummariesDto> | ApiErrorResponse> => {
    const body = instanceListQuerySchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const resolved = await resolveVisibleInstances(app, request, 'room:read', body.data)
    if (resolved.error || !resolved.instances) {
      return resolved.error ?? businessError('无法确定可见实例范围', request)
    }
    return success(await getRoomSummaries(resolved.instances), request)
  })

  app.post('/app/instance/world-summaries', async (request): Promise<ApiSuccessResponse<WorldSummariesDto> | ApiErrorResponse> => {
    const body = instanceListQuerySchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const resolved = await resolveVisibleInstances(app, request, 'world:read', body.data)
    if (resolved.error || !resolved.instances) {
      return resolved.error ?? businessError('无法确定可见实例范围', request)
    }
    return success(await getWorldSummaries(resolved.instances), request)
  })

  app.post('/app/instance/player-summaries', async (request): Promise<ApiSuccessResponse<PlayerSummariesDto> | ApiErrorResponse> => {
    const body = instanceListQuerySchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const resolved = await resolveVisibleInstances(app, request, 'player:read', body.data)
    if (resolved.error || !resolved.instances) {
      return resolved.error ?? businessError('无法确定可见实例范围', request)
    }
    return success(await getPlayerSummaries(resolved.instances), request)
  })

  /**
   * 实例标识选项：给「要在界面上选一个实例」的模块用——Mod 订阅、建存档备份、
   * 建计划任务、给成员分配实例。
   *
   * 只返回 `instanceSummaryItemSchema`（id / 名称 / 游戏 / 状态 / 最近错误），
   * **不含安装路径、端口与节点**；范围照旧按实例授权过滤。
   * 权限是"任一能在界面上看到实例的读权限点"，所以这些模块的菜单只需要自己的那个读权限。
   */
  app.post('/app/instance/options', async (request): Promise<ApiSuccessResponse<InstanceSummaryItem[]> | ApiErrorResponse> => {
    const body = instanceListQuerySchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const auth = await resolveAnyReadPermission(request, [
      'instance:read',
      'mod:read',
      'backup:read',
      'schedule:read',
      'member:read',
      'player:read',
    ])
    if (auth.error || !auth.context) {
      return auth.error ?? businessError('无法确定可见实例范围', request)
    }
    const visible = new Set(await resolveVisibleInstanceIds(request, auth.context.user.id))
    await reconcileInstanceRuntimeState(app)
    const instances = await listGameInstances({
      nodeId: body.data.nodeId?.trim() || undefined,
      status: body.data.status,
      keyword: body.data.keyword?.trim() || undefined,
    })
    return success(
      instances.filter(item => visible.has(item.id)).map(toInstanceSummaryItem),
      request,
    )
  })

  app.get('/app/instance/games', async (request): Promise<ApiSuccessResponse<InstallableGameItem[]> | ApiErrorResponse> => {
    const authError = await verifyAuthorized(request)
    if (authError) {
      return authError
    }
    return success(INSTALLABLE_GAMES, request)
  })

  app.get('/app/instance/install-log', async (request): Promise<ApiSuccessResponse<InstanceInstallLogPayload> | ApiErrorResponse> => {
    const query = instanceInstallLogQuerySchema.safeParse(request.query ?? {})
    if (!query.success) {
      return businessError('请求参数无效', request)
    }
    const id = query.data.id
    if (!id) {
      return businessError('实例 ID 不能为空', request)
    }
    const authorized = await authorizeInstance(request, id, 'instance.install-log:read')
    if (authorized.error) {
      return authorized.error
    }
    const instance = await getGameInstanceById(id)
    if (!instance) {
      return businessError('实例不存在', request)
    }
    const fileContent = readInstallLogContent(getInstallLogsDirPath(), id)
    if (fileContent) {
      return success<InstanceInstallLogPayload>({
        content: formatInstallLogContent(fileContent),
        status: mapDbInstallLogStatusToResponse(instance.installLogStatus, instance.status),
        updatedAt: instance.installLogUpdatedAt ?? instance.updatedAt,
        source: 'install_log',
      }, request)
    }
    if (isInstallJobActive(id)) {
      return success<InstanceInstallLogPayload>({
        content: '安装任务已启动，等待 SteamCMD 输出...',
        status: 'running',
        updatedAt: instance.installLogUpdatedAt ?? instance.updatedAt,
        source: 'install_log',
      }, request)
    }
    const summaryLines = [instance.lastCommand, instance.lastError]
      .filter(Boolean)
      .join('\n')
      .trim()
    if (!summaryLines) {
      return success<InstanceInstallLogPayload>({
        content: '暂无 SteamCMD 安装输出。',
        status: 'unknown',
        updatedAt: instance.updatedAt,
        source: 'empty',
      }, request)
    }
    return success<InstanceInstallLogPayload>({
      content: formatInstallLogContent([
        '【最近状态摘要，非完整 SteamCMD 输出】',
        '',
        summaryLines,
      ].join('\n')),
      status: mapDbInstallLogStatusToResponse(instance.installLogStatus, instance.status),
      updatedAt: instance.installLogUpdatedAt ?? instance.updatedAt,
      source: 'status_summary',
    }, request)
  })

  app.post('/app/instance/create', async (request): Promise<ApiSuccessResponse<Awaited<ReturnType<typeof createGameInstance>>> | ApiErrorResponse> => {
    // 创建不针对已有实例，所以不需要实例授权；但要用到创建者身份去补授权，因此取完整上下文
    const createAuth = await resolveAuthorizedContext(request, { permissions: 'instance:create' })
    if (createAuth.error || !createAuth.context) {
      return createAuth.error ?? unauthorized(request)
    }
    const creatorUserId = createAuth.context.user.id
    const parsed = createInstanceBodySchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      return businessError('请求参数无效', request)
    }
    const body = parsed.data
    const nodeId = body.nodeId
    const name = body.name
    const gameCode = body.gameCode
    const manualInstallPath = normalizeInstallPath(body.installPath)
    if (!nodeId) {
      return businessError('请选择节点', request)
    }
    if (nodeId !== LOCAL_NODE_ID) {
      return businessError('当前仅支持在本地节点创建实例', request)
    }
    if (!name) {
      return businessError('实例名称不能为空', request)
    }
    if (!gameCode) {
      return businessError('请选择游戏 AppID', request)
    }
    const selectedGame = resolveInstallableGameByAppId(gameCode)
    if (!selectedGame) {
      return businessError('游戏 AppID 不在可安装列表中', request)
    }
    const steamcmdCredentials = getSteamcmdLoginCredentials()
    const steamcmdConfig = await getSystemSteamcmdConfig()
    const steamcmdCommand = steamcmdConfig?.steamcmdPath?.trim() || (process.platform === 'win32' ? 'steamcmd.exe' : 'steamcmd')
    const runtimeReady = await checkContainerInstallReady()
    if (!runtimeReady.ok) {
      return businessError(runtimeReady.message ?? '游戏运行时未就绪', request)
    }
    const instanceId = randomUUID()
    const installPath = manualInstallPath || await getDefaultSteamInstallPath(gameCode, instanceId)
    const pathPolicy = loadServerConfig()
    const installPathError = validateInstallPath(installPath, {
      instancesRoot: pathPolicy.instancesRoot,
      policy: pathPolicy.installPathPolicy,
    })
    if (installPathError) {
      return businessError(installPathError, request)
    }
    const node = await getServerNodeById(nodeId)
    if (!node) {
      return businessError('节点不存在', request)
    }
    const ensureDirError = prepareInstallPathForSteamcmd(installPath)
    if (ensureDirError) {
      return businessError(`安装目录创建失败: ${ensureDirError}`, request)
    }
    if (!manualInstallPath) {
      app.log.info({
        nodeId,
        gameCode: selectedGame.appId,
        installPath,
      }, '创建实例未填写安装目录，已回退到默认实例数据目录')
    }
    let gamePort = normalizePort(body.gamePort)
    if (gameCode === DST_APP_ID && gamePort === null) {
      try {
        gamePort = await allocateDstGamePort(nodeId)
      }
      catch (error) {
        const message = error instanceof Error ? error.message : '无法分配游戏端口'
        return businessError(message, request)
      }
    }
    app.log.info({
      instanceId,
      gameCode,
      installPath,
      gamePort,
      steamcmdCommand,
    }, '实例已创建，后台开始执行 SteamCMD 安装')
    // 内存检查必须在写库之前：先创建记录再失败会留下一条 pending_install 的孤儿实例，
    // 它没有对应的安装任务，也不在 reconcileStaleInstallingInstances 的处理范围内（只认 installing）。
    const memoryPressure = getInstallHostMemoryPressure()
    if (memoryPressure) {
      return hostMemoryPressureError(memoryPressure, request)
    }
    const instance = await createGameInstance({
      id: instanceId,
      nodeId,
      name,
      gameCode,
      status: 'pending_install',
      installPath,
      configPath: body.configPath?.trim() || null,
      queryPort: normalizePort(body.queryPort),
      gamePort,
      rconPort: normalizePort(body.rconPort),
      lastExitCode: null,
      lastCommand: '等待安装任务启动',
      lastError: null,
    })
    const started = startInstallJob(app, {
      instanceId,
      appId: gameCode,
      instanceName: name,
      gamePort,
      installPath,
      steamcmdCommand,
      steamcmdCredentials,
    })
    if (started !== 'started') {
      // 兜底回收：安装任务没能起来就不要留下这条记录，
      // 否则用户看到「创建成功」而实例永远停在等待安装。
      await deleteGameInstanceById(instanceId)
      if (started === 'busy') {
        return businessError('该实例已有安装任务进行中', request)
      }
      const blockedPressure = getInstallHostMemoryPressure()
      if (blockedPressure) {
        return hostMemoryPressureError(blockedPressure, request)
      }
      return businessError('宿主机内存不足，无法启动安装', request)
    }
    /**
     * 创建者自动获得这个实例的授权。
     *
     * 少了这一步，新建的实例**连创建它的人都看不到**——实例授权是唯一的可见性判据，
     * 它不会因为「这个实例是我建的」而自动成立。放在安装任务起来之后：
     * 上面几个失败分支都会回收实例记录，授权也跟着没必要存在。
     */
    await addUserInstanceGrants(creatorUserId, [instance.id], creatorUserId)
    return success(instance, request)
  })

  app.post('/app/instance/check-updates', async (request): Promise<ApiSuccessResponse<InstanceUpdateCheckJobStatus> | ApiErrorResponse> => {
    const body = instanceIdsBodySchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const scope = await resolveInstanceScope(request, 'instance:update')
    if (scope.error || !scope.instanceIds) {
      return scope.error ?? businessError('无法确定可见实例范围', request)
    }
    const requested = body.data.ids
    if (requested && requested.length > 0) {
      // 批量接口不做部分执行：只更新其中几个会让用户以为漏选了实例
      const visible = new Set(scope.instanceIds)
      if (requested.some(id => !visible.has(id))) {
        return businessError('没有该实例的访问权限', request, ErrorCode.FORBIDDEN)
      }
    }
    const steamcmdCommand = await resolveSteamcmdCommandForUpdateCheck()
    /**
     * 缺省（不传 ids）此前表示「**全部实例**」——对一个只能看到两个实例的账号来说，
     * 那等于让它批量更新别人机器上的实例。现在缺省是「全部**可见**实例」。
     */
    const instanceIds = requested && requested.length > 0 ? requested : [...scope.instanceIds]
    const status = enqueueInstanceUpdateCheck({
      steamcmdCommand,
      instanceIds,
      force: true,
      validateRuntime: checkContainerInstallReady,
    })
    return success(status, request)
  })

  app.get('/app/instance/check-updates/status', async (request): Promise<ApiSuccessResponse<InstanceUpdateCheckJobStatus> | ApiErrorResponse> => {
    const scope = await resolveInstanceScope(request, 'instance:read')
    if (scope.error || !scope.instanceIds) {
      return scope.error ?? businessError('无法确定可见实例范围', request)
    }
    const status = getInstanceUpdateCheckJobStatus()
    if (!status.result) {
      return success(status, request)
    }
    // 结果里逐条带实例名与版本，不过滤就等于把别人的实例清单一并交了
    const visible = new Set(scope.instanceIds)
    const items = status.result.items.filter(item => visible.has(item.id))
    return success({
      ...status,
      result: {
        ...status.result,
        items,
        updateAvailableCount: items.filter(item => item.updateAvailable).length,
      },
    }, request)
  })

  app.post('/app/instance/update', async (request): Promise<ApiSuccessResponse<{ isSuccess: boolean }> | ApiErrorResponse> => {
    const body = instanceActionBodySchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const id = body.data.id
    if (!id) {
      return businessError('实例 ID 不能为空', request)
    }
    const authorized = await authorizeInstance(request, id, 'instance:update')
    if (authorized.error) {
      return authorized.error
    }
    const runtimeError = await requireContainerRuntime(request)
    if (runtimeError) {
      return runtimeError
    }
    const current = await getGameInstanceById(id)
    if (!current) {
      return businessError('实例不存在', request)
    }
    if (current.nodeId !== LOCAL_NODE_ID) {
      return businessError('当前仅支持本地节点执行实例命令', request)
    }
    if (current.status === 'running') {
      return businessError('请先停止实例后再更新服务端', request)
    }
    if (current.status === 'pending_install' || current.status === 'installing') {
      return businessError('实例正在安装中，请稍后再试', request)
    }
    if (isInstallJobActive(id)) {
      return businessError('该实例已有安装任务进行中', request)
    }
    const installPath = normalizeInstallPath(current.installPath ?? undefined)
      || await getDefaultSteamInstallPath(current.gameCode, current.id)
    const installPathError = validateInstallPath(installPath)
    if (installPathError) {
      return businessError(installPathError, request)
    }
    const ensureDirError = prepareInstallPathForSteamcmd(installPath)
    if (ensureDirError) {
      return businessError(`安装目录创建失败: ${ensureDirError}`, request)
    }
    const steamcmdCredentials = getSteamcmdLoginCredentials()
    const steamcmdConfig = await getSystemSteamcmdConfig()
    const steamcmdCommand = steamcmdConfig?.steamcmdPath?.trim() || (process.platform === 'win32' ? 'steamcmd.exe' : 'steamcmd')
    const forceReinstall = shouldAllowInstallDespiteUpToDate({
      status: current.status,
      gameCode: current.gameCode,
      updateAvailable: current.updateAvailable,
    }, installPath, body.data.force)
    const localBuildId = readLocalBuildId(installPath, current.gameCode)
    if (!forceReinstall) {
      const checked = await refreshInstanceUpdateStatus(current, {
        steamcmdCommand,
        forceRemote: true,
      })
      if (
        checked.localBuildId
        && checked.remoteBuildId
        && checked.localBuildId === checked.remoteBuildId
        && !checked.updateAvailable
      ) {
        return businessError(
          `当前已是最新版本（Build ${checked.localBuildId}），无需更新`,
          request,
        )
      }
    }
    const memoryPressure = getInstallHostMemoryPressure()
    if (memoryPressure) {
      return hostMemoryPressureError(memoryPressure, request)
    }
    // 更新前自动备份存档（系统设置可关闭；失败仅告警，不阻断更新）
    const backupSettings = await getSystemBackupSettings()
    if (backupSettings.autoBackupBeforeUpdate && fs.existsSync(path.join(installPath, 'klei-storage'))) {
      const backupResult = await createInstanceBackup({
        app,
        instanceId: id,
        kind: 'pre_update',
        note: `更新服务端前自动备份（Build ${localBuildId ?? '未知'}）`,
        saveBeforeArchive: false,
      })
      if (backupResult.ok) {
        app.log.info({ instanceId: id, backupId: backupResult.backup?.id }, '更新前自动备份完成')
      }
      else {
        app.log.warn({ instanceId: id, message: backupResult.message }, '更新前自动备份失败，继续执行更新')
      }
    }
    // 须在 startInstallJob 之前写入 installing：本地复制可在数百毫秒内完成，
    // 若后置写入会覆盖 finalize 已设置的 stopped，重启后面板会误判为安装中断。
    await updateGameInstanceRuntime(id, {
      status: 'installing',
      lastCommand: '正在准备更新服务端...',
      lastError: null,
      installPercent: null,
      installLogStatus: 'running',
    })
    const started = startInstallJob(app, {
      instanceId: id,
      appId: current.gameCode,
      instanceName: current.name,
      gamePort: current.gamePort,
      installPath,
      steamcmdCommand,
      steamcmdCredentials,
      forceSteamcmd: true,
    })
    if (started === 'busy' || started === 'blocked') {
      // 状态已经写成 installing 而任务没起来：必须写回原状态，否则实例卡在「安装中」，
      // 启动与再次更新都会被拒绝，只能等刷新列表时由 reconcile 改成 error。
      await updateGameInstanceRuntime(id, {
        status: current.status,
        installLogStatus: null,
        installPercent: null,
      })
    }
    if (started === 'busy') {
      return businessError('该实例已有安装任务进行中', request)
    }
    if (started === 'blocked') {
      const blockedPressure = getInstallHostMemoryPressure()
      if (blockedPressure) {
        return hostMemoryPressureError(blockedPressure, request)
      }
      return businessError('宿主机内存不足，无法启动安装', request)
    }
    app.log.info({
      instanceId: id,
      gameCode: current.gameCode,
      installPath,
      forceReinstall,
    }, '实例开始执行 SteamCMD 手动更新')
    return success({ isSuccess: true }, request)
  })

  app.post('/app/instance/allocate-ports', async (request): Promise<ApiSuccessResponse<{ gamePort: number }> | ApiErrorResponse> => {
    const body = instanceActionBodySchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const id = body.data.id
    if (!id) {
      return businessError('实例 ID 不能为空', request)
    }
    const authorized = await authorizeInstance(request, id, 'instance:ports')
    if (authorized.error) {
      return authorized.error
    }
    const current = await getGameInstanceById(id)
    if (!current) {
      return businessError('实例不存在', request)
    }
    if (current.nodeId !== LOCAL_NODE_ID) {
      return businessError('当前仅支持本地节点执行实例命令', request)
    }
    if (current.gameCode.trim() !== DST_APP_ID) {
      return businessError('当前仅支持饥荒（343050）实例自动分配端口', request)
    }
    const installPath = normalizeInstallPath(current.installPath ?? undefined) || await getDefaultSteamInstallPath(current.gameCode, current.id)
    const installPathError = validateInstallPath(installPath)
    if (installPathError) {
      return businessError(installPathError, request)
    }
    const probe = await probeDstPortConflictForStart({
      instanceId: id,
      nodeId: current.nodeId,
      gameCode: current.gameCode,
      installPath,
      gamePort: current.gamePort,
    })
    const applied = await applyDstPortAutoAllocate({
      instanceId: id,
      nodeId: current.nodeId,
      installPath,
      gamePort: current.gamePort,
      suggestedGamePort: probe.suggestedGamePort,
    })
    if (!applied.ok) {
      return businessError(applied.message, request)
    }
    return success({ gamePort: applied.gamePort }, request)
  })

  app.post('/app/instance/start', async (request): Promise<ApiSuccessResponse<{ isSuccess: boolean }> | ApiErrorResponse> => {
    try {
      return await handleInstanceStart(request)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : '启动实例失败'
      request.log.error({ err: error }, '启动实例时发生未处理异常')
      return businessError(message, request)
    }
  })

  async function handleInstanceStart(request: FastifyRequest, options?: { skipAuth?: boolean }): Promise<ApiSuccessResponse<{ isSuccess: boolean }> | ApiErrorResponse> {
    const id = (request.body as { id?: string } | undefined)?.id
    if (!id) return handleInstanceStartUnlocked(request, options)
    try { return await withInstanceContentActivity(id, () => handleInstanceStartUnlocked(request, options)) }
    catch (error) { return businessError(error instanceof Error ? error.message : '启动实例失败', request) }
  }

  async function handleInstanceStartUnlocked(request: FastifyRequest, options?: { skipAuth?: boolean }): Promise<ApiSuccessResponse<{ isSuccess: boolean }> | ApiErrorResponse> {
    const body = instanceActionBodySchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const id = body.data.id
    // skipAuth 是**内部调用**通道（计划任务、插件生命周期）：它们的授权由调用方保证，
    // 不走用户鉴权。这条分支的存在正是为什么它需要被显式写出来，而不是靠请求头绕。
    if (!options?.skipAuth) {
      const authorized = await authorizeInstance(request, id, 'instance:lifecycle')
      if (authorized.error) {
        return authorized.error
      }
    }
    if (!id) {
      return businessError('实例 ID 不能为空', request)
    }
    const runtimeError = await requireContainerRuntime(request)
    if (runtimeError) {
      return runtimeError
    }
    const current = await getGameInstanceById(id)
    if (!current) {
      return businessError('实例不存在', request)
    }
    if (current.nodeId !== LOCAL_NODE_ID) {
      return businessError('当前仅支持本地节点执行实例命令', request)
    }
    if (current.status === 'pending_install' || current.status === 'installing') {
      return businessError('实例正在安装中，请稍后重试启动', request)
    }
    if (isInstallJobActive(id) || isAnyInstallJobActive() || isSteamcmdAppUpdateBusy()) {
      return businessError('当前有实例正在安装或更新游戏文件（SteamCMD），请等待完成后再启动', request)
    }
    const installPath = normalizeInstallPath(current.installPath ?? undefined) || await getDefaultSteamInstallPath(current.gameCode, current.id)
    const installPathError = validateInstallPath(installPath)
    if (installPathError) {
      await updateGameInstanceRuntime(id, {
        status: 'error',
        lastError: installPathError,
        lastErrorPhase: 'install',
      })
      return businessError(installPathError, request)
    }
    const ensureDirError = prepareInstallPathForRuntime(installPath)
    if (ensureDirError) {
      const errorMessage = `安装目录创建失败: ${ensureDirError}`
      await updateGameInstanceRuntime(id, {
        status: 'error',
        lastError: errorMessage,
        lastErrorPhase: 'install',
      })
      return businessError(errorMessage, request)
    }
    if (!fs.existsSync(installPath)) {
      const errorMessage = '安装路径不存在，请重新执行实例安装'
      await updateGameInstanceRuntime(id, {
        status: 'error',
        lastError: errorMessage,
        lastErrorPhase: 'install',
      })
      return businessError(errorMessage, request)
    }
    let installPathStat: fs.Stats
    try {
      installPathStat = fs.statSync(installPath)
    }
    catch {
      const errorMessage = `安装路径不存在或不可访问: ${installPath}`
      await updateGameInstanceRuntime(id, {
        status: 'error',
        lastError: errorMessage,
        lastErrorPhase: 'install',
      })
      return businessError(errorMessage, request)
    }
    if (!installPathStat.isDirectory()) {
      const errorMessage = `安装路径不是目录: ${installPath}`
      await updateGameInstanceRuntime(id, {
        status: 'error',
        lastError: errorMessage,
        lastErrorPhase: 'install',
      })
      return businessError(errorMessage, request)
    }
    const steamcmdImageReady = await isSteamcmdImagePresent()
    const installReadiness = current.gameCode.trim() === DST_APP_ID
      ? diagnoseDstInstallReadiness(installPath)
      : {
        ready: false,
        code: 'missing_game_files' as const,
        message: '当前仅支持饥荒（343050）实例启动',
      }
    if (!installReadiness.ready) {
      const errorMessage = buildDstStartBlockedMessage(installReadiness, steamcmdImageReady, {
        installLogStatus: current.installLogStatus,
        instanceStatus: current.status,
        lastError: current.lastError,
        lastErrorPhase: current.lastErrorPhase,
      })
      await updateGameInstanceRuntime(id, {
        status: 'error',
        lastError: errorMessage,
        lastErrorPhase: 'install',
      })
      return businessError(errorMessage, request)
    }
    let gamePort = current.gamePort
    if (current.gameCode.trim() === DST_APP_ID) {
      const portResult = await resolveDstGamePortForStart({
        instanceId: id,
        nodeId: current.nodeId,
        gameCode: current.gameCode,
        installPath,
        gamePort: current.gamePort,
        autoAllocatePorts: body.data.autoAllocatePorts === true,
      })
      if (!portResult.ok) {
        if (portResult.kind === 'port_conflict') {
          return businessError(
            portResult.probe.userMessage,
            request,
            ErrorCode.INSTANCE_PORT_CONFLICT,
            {
              conflictingPorts: portResult.probe.conflictingPorts,
              suggestedGamePort: portResult.probe.suggestedGamePort,
              currentGamePort: portResult.probe.currentGamePort,
            },
          )
        }
        await updateGameInstanceRuntime(id, {
          status: 'error',
          lastError: portResult.message,
          lastErrorPhase: 'runtime',
        })
        return businessError(portResult.message, request)
      }
      gamePort = portResult.gamePort
    }
    const layoutResult = current.gameCode.trim() === DST_APP_ID
      ? ensureDstLayout(installPath, {
        instanceName: current.name,
        gamePort,
      })
      : { ok: false, message: '当前仅支持饥荒（343050）实例启动' }
    if (!layoutResult.ok) {
      const layoutReadiness = diagnoseDstInstallReadiness(installPath)
      const errorMessage = buildDstStartBlockedMessage(
        layoutReadiness.ready ? installReadiness : layoutReadiness,
        steamcmdImageReady,
        {
          installLogStatus: current.installLogStatus,
          instanceStatus: current.status,
          lastError: current.lastError,
          lastErrorPhase: current.lastErrorPhase,
        },
      )
      await updateGameInstanceRuntime(id, {
        status: 'error',
        lastError: errorMessage,
        lastErrorPhase: 'install',
      })
      return businessError(errorMessage, request)
    }
    if (current.gameCode.trim() === DST_APP_ID) {
      try {
        await syncInstanceModFilesFromDb(id, installPath)
      }
      catch (error) {
        const message = error instanceof Error ? error.message : '同步 Mod 配置失败'
        await updateGameInstanceRuntime(id, {
          status: 'error',
          lastError: message,
          lastErrorPhase: 'runtime',
        })
        return businessError(message, request)
      }
    }
    const updateBlockMessage = await resolveStartBlockedByPendingUpdate(current)
    if (updateBlockMessage) {
      return businessError(updateBlockMessage, request)
    }
    if (instanceStartLocks.has(id)) {
      return businessError('该实例正在启动中，请稍后再试', request)
    }
    instanceStartLocks.add(id)
    try {
      if (await isInstanceContainerRunning(id)) {
        if (current.status !== 'running') {
          const ref = await resolveInstanceContainerRef(id)
          await updateGameInstanceRuntime(id, {
            status: 'running',
            containerId: ref?.id ?? current.containerId,
            runtimeStartedAt: current.runtimeStartedAt ?? new Date().toISOString(),
            lastError: null,
          })
        }
        return success({ isSuccess: true }, request)
      }
      if (current.status === 'running') {
        await updateGameInstanceRuntime(id, {
          status: 'stopped',
          containerId: null,
          runtimePid: null,
          runtimeStartedAt: null,
        })
      }
      await updateGameInstanceRuntime(id, {
        lastCommand: '正在准备 DST 运行镜像（若本地缺失将自动拉取）…',
        lastError: null,
      })
      const started = await startInstanceContainer(app, {
        instanceId: id,
        gameCode: current.gameCode,
        installPath,
        instanceName: current.name,
        gamePort,
      })
      if (!started.ok) {
        await updateGameInstanceRuntime(id, {
          status: 'error',
          lastError: started.message,
          lastErrorPhase: 'runtime',
        })
        if (started.hostMemoryPressure) {
          return hostMemoryPressureError(started.hostMemoryPressure, request)
        }
        return businessError(started.message, request)
      }
      await updateGameInstanceRuntime(id, {
        status: 'running',
        containerId: started.ref.id,
        runtimePid: null,
        runtimeStartedAt: new Date().toISOString(),
        lastCommand: started.displayCommand,
        lastExitCode: null,
        lastError: null,
        runtimeWarning: null,
        // 就绪与归因都属于「本轮启动」：不清空就会沿用上一轮的就绪状态
        runtimeReadyAt: null,
        runtimeFailureKind: null,
        unexpectedExitAt: null,
      })
      return success({ isSuccess: true }, request)
    }
    finally {
      instanceStartLocks.delete(id)
    }
  }

  app.post('/app/instance/stop', async (request): Promise<ApiSuccessResponse<{ isSuccess: boolean }> | ApiErrorResponse> => {
    const body = instanceActionBodySchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const id = body.data.id
    if (!id) {
      return businessError('实例 ID 不能为空', request)
    }
    const authorized = await authorizeInstance(request, id, 'instance:lifecycle')
    if (authorized.error) {
      return authorized.error
    }
    const current = await getGameInstanceById(id)
    if (!current) {
      return businessError('实例不存在', request)
    }
    if (current.nodeId !== LOCAL_NODE_ID) {
      return businessError('当前仅支持本地节点执行实例命令', request)
    }
    if (current.status === 'stopped') {
      return success({ isSuccess: true }, request)
    }
    const runtimeError = await requireContainerRuntime(request)
    if (runtimeError) {
      return runtimeError
    }
    if (current.status === 'pending_install' || current.status === 'installing') {
      await cancelInstallJob(id)
      // cancelInstallJob 内部按「安装意外中断」语义写成 error，但用户是主动停止，
      // 不该看到异常态：这里按停止结果落状态。
      await updateGameInstanceRuntime(id, {
        status: 'stopped',
        containerId: null,
        runtimePid: null,
        runtimeStartedAt: null,
        installLogStatus: null,
        installPercent: null,
        lastError: null,
      })
      app.log.info({ instanceId: id }, '实例安装已取消')
      return success({ isSuccess: true }, request)
    }
    try {
      app.log.info({ instanceId: id }, '实例停止命令已发送')
      await stopInstanceContainer(id)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : '停止实例失败'
      app.log.error({
        instanceId: id,
        error: message,
      }, '实例停止失败')
      await updateGameInstanceRuntime(id, {
        status: 'error',
        lastError: message,
        lastErrorPhase: 'runtime',
      })
      return businessError(message, request)
    }
    return success({ isSuccess: true }, request)
  })

  app.post('/app/instance/restart', async (request): Promise<ApiSuccessResponse<{ isSuccess: boolean }> | ApiErrorResponse> => {
    const body = instanceActionBodySchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const id = body.data.id
    const authorized = await authorizeInstance(request, id, 'instance:lifecycle')
    if (authorized.error) {
      return authorized.error
    }
    const { restartInstanceCore } = await import('./restart-instance-core.ts')
    return restartInstanceCore(app, request, id, {
      autoAllocatePorts: body.data.autoAllocatePorts === true,
    })
  })

  // 崩溃感知轮询：DB=running 但运行时无进程时标记异常退出并发布事件（单元测试环境不启动）
  startInstanceExitWatch(app)

  // 计划任务内部通道：schedule 模块经注册表调用重启，无需构造带用户 token 的 HTTP 请求
  async function performScheduledRestart(_app: FastifyInstance, instanceId: string): Promise<{ ok: boolean, message?: string }> {
    const current = await getGameInstanceById(instanceId)
    if (!current) {
      return { ok: false, message: '实例不存在' }
    }
    if (current.nodeId !== LOCAL_NODE_ID) {
      return { ok: false, message: '当前仅支持本地节点执行实例命令' }
    }
    if (current.status === 'pending_install' || current.status === 'installing' || isInstallJobActive(instanceId)) {
      return { ok: false, message: '实例正在安装中，无法按计划重启' }
    }
    const runtimeReady = await ensureContainerRuntimeReady()
    if (!runtimeReady.ok) {
      return { ok: false, message: runtimeReady.message ?? '游戏运行时未就绪' }
    }
    if (current.status === 'running' || current.containerId) {
      try {
        await stopInstanceContainer(instanceId)
      }
      catch (error) {
        const message = error instanceof Error ? error.message : '计划重启时停止实例失败'
        await updateGameInstanceRuntime(instanceId, { status: 'error', lastError: message, lastErrorPhase: 'runtime' })
        return { ok: false, message }
      }
    }
    const syntheticRequest = {
      id: 'schedule-internal',
      url: '/internal/schedule/restart',
      headers: {},
      body: { id: instanceId },
    } as unknown as FastifyRequest
    const result = await handleInstanceStart(syntheticRequest, { skipAuth: true })
    if ('error' in result && result.error) {
      return { ok: false, message: result.error }
    }
    return { ok: true }
  }

  registerInstanceScheduledOps({
    restart: performScheduledRestart,
  })

  /**
   * 插件实例操作通道：能力服务经此执行 start / stop / restart。
   *
   * 三个动作都复用面板自身的内部逻辑（启动走 `handleInstanceStart`，停止走
   * `stopInstanceContainer` + 状态回写，重启复用计划任务那条已验证的路径），
   * 而不是另写一份"给插件用的"实现——两份实现迟早会在状态回写或安装互斥上出现分歧。
   * 权限由能力服务把关（清单声明 + 宿主授予 + 每次调用记审计），
   * 因此这里按内部请求处理，不需要登录令牌。
   */
  registerPluginInstanceOps({
    start: async (currentApp, instanceId) => {
      const syntheticRequest = buildInternalInstanceRequest(instanceId, 'start')
      const result = await handleInstanceStart(syntheticRequest, { skipAuth: true })
      if ('error' in result && result.error) {
        return { ok: false, message: result.error }
      }
      currentApp.log.info({ instanceId, source: 'plugin' }, '插件请求启动实例')
      return { ok: true, message: '启动命令已受理' }
    },
    stop: async (currentApp, instanceId) => {
      const current = await getGameInstanceById(instanceId)
      if (!current) {
        return { ok: false, message: '实例不存在' }
      }
      if (current.nodeId !== LOCAL_NODE_ID) {
        return { ok: false, message: '当前仅支持本地节点执行实例命令' }
      }
      if (current.status === 'stopped') {
        return { ok: true, message: '实例本就处于停止状态' }
      }
      if (current.status === 'pending_install' || current.status === 'installing') {
        return { ok: false, message: '实例正在安装中，请先取消安装再停止' }
      }
      try {
        await stopInstanceContainer(instanceId)
      }
      catch (error) {
        const message = error instanceof Error ? error.message : '停止实例失败'
        await updateGameInstanceRuntime(instanceId, { status: 'error', lastError: message, lastErrorPhase: 'runtime' })
        return { ok: false, message }
      }
      currentApp.log.info({ instanceId, source: 'plugin' }, '插件请求停止实例')
      return { ok: true, message: '已发送停止命令' }
    },
    restart: async (currentApp, instanceId) => {
      const result = await performScheduledRestart(currentApp, instanceId)
      if (result.ok) {
        currentApp.log.info({ instanceId, source: 'plugin' }, '插件请求重启实例')
        return { ok: true, message: '重启已完成' }
      }
      return result
    },
  })

  app.post('/app/instance/delete', async (request): Promise<ApiSuccessResponse<{ isSuccess: boolean }> | ApiErrorResponse> => {
    const body = instanceActionBodySchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const id = body.data.id
    if (!id) {
      return businessError('实例 ID 不能为空', request)
    }
    const authorized = await authorizeInstance(request, id, 'instance:delete')
    if (authorized.error) {
      return authorized.error
    }
    const current = await getGameInstanceById(id)
    if (!current) {
      return businessError('实例不存在', request)
    }
    if (current.nodeId !== LOCAL_NODE_ID) {
      return businessError('当前仅支持本地节点执行实例命令', request)
    }
    const runtimeError = await requireContainerRuntime(request)
    if (runtimeError) {
      return runtimeError
    }
    if (current.status === 'pending_install' || current.status === 'installing' || isInstallJobActive(id)) {
      await cancelInstallJob(id)
    }
    if (current.status === 'running' || current.containerId) {
      try {
        app.log.info({ instanceId: id }, '删除实例前自动停止运行中的容器')
        await stopInstanceContainer(id)
        await removeInstanceContainer(id)
      }
      catch (error) {
        const message = error instanceof Error ? error.message : '删除前停止实例失败'
        return businessError(message, request)
      }
    }
    else {
      await removeInstanceContainer(id)
    }
    clearInstallJobTracking(id)
    deleteInstallLogFile(getInstallLogsDirPath(), id)
    const installPath = normalizeInstallPath(current.installPath ?? undefined)
      || await getDefaultSteamInstallPath(current.gameCode, current.id)
    const installPathError = validateInstallPath(installPath)
    if (installPathError) {
      return businessError(installPathError, request)
    }
    // 删除前自动备份存档（系统设置可关闭；失败仅告警，不阻断删除）
    const backupSettings = await getSystemBackupSettings()
    if (backupSettings.autoBackupBeforeDelete && fs.existsSync(path.join(installPath, 'klei-storage'))) {
      const backupResult = await createInstanceBackup({
        app,
        instanceId: id,
        kind: 'pre_delete',
        note: `删除实例前自动备份（${current.name}）`,
        saveBeforeArchive: false,
      })
      if (backupResult.ok) {
        app.log.info({ instanceId: id, backupId: backupResult.backup?.id }, '删除前自动备份完成')
      }
      else {
        app.log.warn({ instanceId: id, message: backupResult.message }, '删除前自动备份失败，继续执行删除')
      }
    }
    // 先删数据库记录，再删磁盘目录：目录清理失败时最多留下孤儿文件，
    // 不会出现"记录还在、游戏文件已没"的无法自洽状态。
    const deleted = await deleteGameInstanceById(id)
    if (!deleted) {
      return businessError('实例不存在', request)
    }
    if (fs.existsSync(installPath)) {
      try {
        fs.rmSync(installPath, {
          recursive: true,
          force: true,
          maxRetries: 2,
          retryDelay: 200,
        })
      }
      catch (error) {
        const message = error instanceof Error ? error.message : '删除实例目录失败'
        app.log.warn({ instanceId: id, installPath, error: message }, '实例记录已删除，但实例目录清理失败，请手动处理')
      }
    }
    instanceConsoleLogStore.removeInstance(id)
    // 玩家档案属于这个实例：实例没了就一起清掉，免得面板里留下一堆再也用不到的名字
    await removePlayerProfilesByInstance(id).catch((error) => {
      app.log.warn({ instanceId: id, error }, '清理实例玩家档案失败')
    })
    // 实例授权同理：实例没了，指向它的授权行就是孤儿。留着不会造成越权
    // （鉴权是先查实例再查授权，或反过来都查不到），但成员管理页会显示一个不存在的实例
    await deleteInstanceGrantsByInstanceId(id).catch((error) => {
      app.log.warn({ instanceId: id, error }, '清理实例授权失败')
    })
    return success({ isSuccess: true }, request)
  })

  app.addHook('onReady', async () => {
    try {
      await reconcileOrphanedSteamcmdOnPanelReady(app)
      await reconcileInstanceRuntimeState(app)
    }
    catch (error) {
      app.log.warn({ error }, '实例运行时对齐跳过（运行时不可用或连接失败）')
    }
    scheduleInstanceUpdateChecks(app)
  })
}
