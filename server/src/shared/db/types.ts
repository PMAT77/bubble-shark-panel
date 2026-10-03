import type { NotifyChannelType } from '../../../../shared/contracts/notify'

export interface SessionTokenBundle {
  accessToken: string
  refreshToken: string
  accessExpiresAt: string
  refreshExpiresAt: string
  accessExpiresInSec: number
  refreshExpiresInSec: number
}

export interface DbSystemNetworkConfig {
  mode: 'bootstrap_pending' | 'managed'
  httpPort: number
  domain: string
  tls: {
    enabled: boolean
    provider: 'none' | 'letsencrypt' | 'custom'
  }
}

export interface DbSystemPanelSettings {
  panelPort: number
  theme: 'light' | 'dark' | 'system'
  autoUpdate: boolean
  /** 启动实例前是否向 Steam 拉取 Build ID 并拦截有更新的启动 */
  checkUpdateBeforeStart: boolean
  /** Hub 镜像自动检查间隔（小时） */
  updateCheckIntervalHours: number
  /** 面板更新下载源：auto=优先 Release 离线镜像包、失败回退镜像仓库；offline=只用离线包；pull=只用镜像仓库 */
  updateSource: 'auto' | 'offline' | 'pull'
}

export interface DbSystemSteamcmdConfig {
  steamcmdPath: string
  installRoot: string
}

export interface DbSystemBackupSettings {
  /** 每实例存档备份保留上限（含自动钩子备份，0 = 不限制） */
  perInstanceRetention: number
  /** 数据库快照保留上限（0 = 不限制） */
  dbSnapshotRetention: number
  /** 更新服务端前自动备份 */
  autoBackupBeforeUpdate: boolean
  /** 删除实例前自动备份 */
  autoBackupBeforeDelete: boolean
}

export interface DbServerNode {
  id: string
  name: string
  host: string
  sshPort: number
  status: 'online' | 'offline'
  cpuUsage: number
  memoryUsage: number
  diskUsage: number
  lastHeartbeatAt: string | null
  createdAt: string
  updatedAt: string
}

export interface SaveServerNodeInput {
  id: string
  name: string
  host: string
  sshPort?: number
  status?: 'online' | 'offline'
  cpuUsage?: number
  memoryUsage?: number
  diskUsage?: number
  lastHeartbeatAt?: string | null
}

export type DbGameInstanceStatus = 'pending_install' | 'running' | 'stopped' | 'installing' | 'error'
export type DbInstallLogStatus = 'running' | 'success' | 'failed'
/**
 * 实例最近一次失败发生的环节。
 *
 * install = 安装/更新游戏服务端（含安装环境未就绪）；runtime = 启动或运行期。
 * 展示层用它拆分「安装失败 / 运行异常」，不再从 lastError 文案里判。
 */
export type DbInstanceErrorPhase = 'install' | 'runtime'

/**
 * 实例未就绪/启动失败的归因。
 *
 * memory = 有内存不足的证据（cgroup OOM 计数、systemd 的 oom-kill、反复重启且可用缓冲见底）；
 * not_ready = 其余未就绪情形（例如某个 Mod 报错）。前端据此决定要不要给出「增加缓存区」引导，
 * 所以必须是枚举而不是从告警文案里认。
 */
export type DbInstanceRuntimeFailureKind = 'memory' | 'not_ready'

export interface DbGameInstance {
  id: string
  nodeId: string
  name: string
  gameCode: string
  status: DbGameInstanceStatus
  containerId: string | null
  runtimePid: number | null
  runtimeStartedAt: string | null
  installPath: string | null
  configPath: string | null
  queryPort: number | null
  gamePort: number | null
  rconPort: number | null
  lastCommand: string | null
  lastExitCode: number | null
  lastError: string | null
  /** 最近一次失败的环节；与 lastError 同生命周期（lastError 清空时一并清空） */
  lastErrorPhase: DbInstanceErrorPhase | null
  /** 运行期警告（重启循环 / 退出原因 / 分片残留）；与 lastError 分开，停止实例不清空 */
  runtimeWarning: string | null
  /** 本轮启动出现世界就绪标记的时刻（ISO）；尚未就绪或未运行为 null */
  runtimeReadyAt: string | null
  /** 未就绪/启动失败的归因；无结论为 null（见 schema 注释） */
  runtimeFailureKind: DbInstanceRuntimeFailureKind | null
  /** 最近一次异常退出检测时间（ISO）；成功启动后清除 */
  unexpectedExitAt: string | null
  installLogStatus: DbInstallLogStatus | null
  installPercent: number | null
  installLogUpdatedAt: string | null
  updateAvailable: boolean
  localBuildId: string | null
  remoteBuildId: string | null
  updateCheckedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateGameInstanceInput {
  id?: string
  nodeId: string
  name: string
  gameCode: string
  status?: DbGameInstanceStatus
  containerId?: string | null
  runtimePid?: number | null
  installPath?: string | null
  configPath?: string | null
  queryPort?: number | null
  gamePort?: number | null
  rconPort?: number | null
  lastCommand?: string | null
  lastExitCode?: number | null
  lastError?: string | null
  lastErrorPhase?: DbInstanceErrorPhase | null
  runtimeWarning?: string | null
}

export interface UpdateGameInstanceRuntimeInput {
  status?: DbGameInstanceStatus
  /**
   * 前置状态守卫：仅当当前行 status 命中给定值时才执行更新（状态机竞态保护）。
   * 未命中时静默放弃写入（返回当前行），用于“安装完成/失败只允许覆盖 installing”这类约束。
   */
  whereStatus?: DbGameInstanceStatus | DbGameInstanceStatus[]
  containerId?: string | null
  runtimePid?: number | null
  runtimeStartedAt?: string | null
  gamePort?: number | null
  lastCommand?: string | null
  lastExitCode?: number | null
  lastError?: string | null
  /** 与 lastError 同一次写入给出；非空 lastError 不带环节时前端按 runtime 兜底 */
  lastErrorPhase?: DbInstanceErrorPhase | null
  runtimeWarning?: string | null
  /** 世界就绪时刻；启动实例时清空，就绪后写入 */
  runtimeReadyAt?: string | null
  /** 未就绪/启动失败的归因；重新启动或就绪后清空 */
  runtimeFailureKind?: DbInstanceRuntimeFailureKind | null
  unexpectedExitAt?: string | null
  installLogStatus?: DbInstallLogStatus | null
  installPercent?: number | null
  installLogUpdatedAt?: string | null
  updateAvailable?: boolean
  localBuildId?: string | null
  remoteBuildId?: string | null
  updateCheckedAt?: string | null
}

export interface DbInstanceMod {
  id: string
  instanceId: string
  workshopId: string
  name: string
  previewImage: string | null
  enabled: boolean
  loadOrder: number
  version: string | null
  contentSource?: 'steam' | 'local' | 'migration'
  installStatus: 'pending' | 'ready' | 'failed'
  installError: string | null
  /** 本机已下载内容对应的工坊版本时间（ISO）；未知为 null */
  localUpdatedAt: string | null
  /** 工坊上的最新版本时间（ISO）；未知为 null */
  remoteUpdatedAt: string | null
  /** 最近一次版本检查时间（ISO）；从未检查为 null */
  updateCheckedAt: string | null
  /** 游戏实际加载的副本（ugc_mods）比已下载内容旧：需要重新下载并重新落位 */
  loadedCopyStale: boolean
  /** JSON 序列化的 modoverrides.lua configuration_options；null = 未配置 */
  config: string | null
  /** 连续下载失败次数（队列指数退避用）；成功即清零 */
  retryCount: number
  /** 退避等待的下次可尝试时间（ISO）；null = 立即可尝试 */
  nextRetryAt: string | null
  createdAt: string
  updatedAt: string
}

export type DbMaintenancePushStatus = 'success' | 'failed'

export interface DbMaintenanceDraft {
  instanceId: string
  message: string
  updatedAt: string
}

export interface DbMaintenancePushLog {
  id: string
  instanceId: string
  message: string
  operatorAccount: string
  status: DbMaintenancePushStatus
  errorMessage: string | null
  pushedAt: string
}

export interface InsertMaintenancePushLogInput {
  instanceId: string
  message: string
  operatorAccount: string
  status: DbMaintenancePushStatus
  errorMessage?: string | null
}

export type DbBackupKind = 'manual' | 'scheduled' | 'pre_update' | 'pre_delete' | 'pre_restore' | 'pre_import' | 'pre_rollback' | 'pre_reset' | 'database'
export type DbBackupStatus = 'completed' | 'failed' | 'stale'

export interface DbBackup {
  id: string
  instanceId: string
  filePath: string
  sizeBytes: number
  note: string
  kind: DbBackupKind
  status: DbBackupStatus
  /** JSON 序列化的分片列表（如 ["master","caves"]），数据库快照为 null */
  shards: string | null
  createdBy: string
  createdAt: string
}

export interface CreateBackupInput {
  id: string
  instanceId: string
  filePath: string
  sizeBytes: number
  note?: string
  kind?: DbBackupKind
  status?: DbBackupStatus
  shards?: string | null
  createdBy?: string
}

/** 与共享契约同源，数据库层不再自写一份渠道类型列表 */
export type DbNotifyChannelType = NotifyChannelType
export type DbNotifyHealthStatus = 'healthy' | 'failing'

export interface DbNotifyChannel {
  id: string
  type: DbNotifyChannelType
  name: string
  /** JSON 序列化配置（webhookUrl/secret/sendKey） */
  config: string
  enabled: boolean
  healthStatus: DbNotifyHealthStatus
  lastErrorAt: string | null
  lastErrorMessage: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateNotifyChannelInput {
  id: string
  type: DbNotifyChannelType
  name: string
  config: string
  enabled?: boolean
}

export interface UpdateNotifyChannelInput {
  name?: string
  config?: string
  enabled?: boolean
  healthStatus?: DbNotifyHealthStatus
  lastErrorAt?: string | null
  lastErrorMessage?: string | null
}

export interface DbNotifySettings {
  /** 通知总开关（渠道级 enabled 之外） */
  enabled: boolean
  /** 同实例同事件类型的冷却窗口（分钟） */
  cooldownMinutes: number
  thresholds: {
    cpuPercent: number
    memPercent: number
    diskPercent: number
  }
}

export type DbScheduleTaskKind = 'restart' | 'backup' | 'update_check' | 'db_snapshot'
export type DbScheduleType = 'interval' | 'daily'
export type DbScheduleTimezone = 'beijing' | 'server'
export type DbScheduleRunStatus = 'running' | 'ok' | 'failed' | 'skipped'

export interface DbScheduledTask {
  id: string
  instanceId: string
  kind: DbScheduleTaskKind
  scheduleType: DbScheduleType
  /** interval 存小时数字符串（1-168）；daily 存 HH:MM */
  scheduleValue: string
  /** daily 任务时区；interval 忽略 */
  scheduleTz: DbScheduleTimezone
  enabled: boolean
  lastRunAt: string | null
  lastRunStatus: DbScheduleRunStatus | null
  lastRunMessage: string | null
  nextRunAt: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface CreateScheduleTaskInput {
  id: string
  instanceId: string
  kind: DbScheduleTaskKind
  scheduleType: DbScheduleType
  scheduleValue: string
  scheduleTz?: DbScheduleTimezone
  enabled?: boolean
  nextRunAt?: string | null
  createdBy?: string
}

export interface UpdateScheduleTaskInput {
  scheduleType?: DbScheduleType
  scheduleValue?: string
  scheduleTz?: DbScheduleTimezone
  enabled?: boolean
  lastRunAt?: string | null
  lastRunStatus?: DbScheduleRunStatus | null
  lastRunMessage?: string | null
  nextRunAt?: string | null
}

/** 面板侧玩家档案：Klei 用户 ID ↔ 游戏内名字（可含管理员手工备注） */
export interface DbPlayerProfile {
  instanceId: string
  kuId: string
  name: string
  note: string
  firstSeenAt: string
  lastSeenAt: string
  updatedAt: string
}

export interface UpsertPlayerProfileInput {
  kuId: string
  /** 空字符串表示这次没拿到名字，保留库里已有的名字 */
  name?: string
  /** 该名字的观测时间，默认取当前时间 */
  seenAt?: string
}
