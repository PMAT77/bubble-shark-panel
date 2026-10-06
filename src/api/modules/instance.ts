import { resolveApiBaseUrl, withTrailingSlash } from '../base-url'
import api from '../index'
import type {
  ConsoleLogHistoryDto,
  InstanceConnectInfoDto,
  InstanceConsoleCommandShard,
  InstanceConsoleLogFilter,
  InstanceConsoleLogLineDto,
  InstanceConsoleLogShard,
  InstanceConsoleLogsPayload,
  InstanceConsoleLogStream,
  InstanceConsoleShardStatus,
  InstanceConsoleStreamTicketDto,
} from '../../../shared/contracts/console'
import type {
  CreateInstancePayload,
  InstanceAllocatePortsPayload,
  InstanceCheckUpdatesPayload,
  InstanceInstallLogPayload,
  InstanceInstallLogSource,
  InstanceItem,
  InstanceListQuery,
  InstanceMetricsPayload,
  InstancePortConflictData,
  InstanceRuntimeMetrics,
  InstanceStatus,
  InstanceStatusCounts,
  InstanceStatusCountsQuery,
  InstanceSummaryItem,
  InstanceUpdateCheckJobPayload,
  InstanceWorldStateDto,
  InstallableGameItem,
} from '../../../shared/contracts/instance'
import type {
  InstanceMaintenanceAnnounceStateDto,
  InstanceMaintenanceDraftDto,
  InstanceMaintenancePushLogDto,
  InstanceMaintenancePushResultDto,
} from '../../../shared/contracts/maintenance'

export type {
  ConsoleLogHistoryDto,
  CreateInstancePayload,
  InstanceAllocatePortsPayload,
  InstanceCheckUpdatesPayload,
  InstanceConsoleCommandShard,
  InstanceConsoleLogFilter,
  InstanceConsoleLogShard,
  InstanceConsoleLogsPayload,
  InstanceConsoleLogStream,
  InstanceConsoleShardStatus,
  InstanceInstallLogPayload,
  InstanceInstallLogSource,
  InstanceItem,
  InstanceListQuery,
  InstanceMetricsPayload,
  InstancePortConflictData,
  InstanceRuntimeMetrics,
  InstanceStatus,
  InstanceStatusCounts,
  InstanceStatusCountsQuery,
  InstanceSummaryItem,
  InstanceUpdateCheckJobPayload,
  InstallableGameItem,
}

export type InstanceConnectInfo = InstanceConnectInfoDto
export type InstanceConsoleLogLine = InstanceConsoleLogLineDto
export type InstanceConsoleStreamTicket = InstanceConsoleStreamTicketDto
export type InstanceMaintenanceDraft = InstanceMaintenanceDraftDto
export type InstanceMaintenancePushLog = InstanceMaintenancePushLogDto
export type InstanceMaintenanceAnnounceState = InstanceMaintenanceAnnounceStateDto
export type InstanceMaintenancePushResult = InstanceMaintenancePushResultDto

export default {
  getInstanceList: (data?: InstanceListQuery) => api.post('app/instance/list', data),
  /**
   * 实例标识选项：给"要在界面上选一个实例"的模块用（Mod、备份、计划任务、成员授权）。
   *
   * 与 `getInstanceList` 的区别：只回 id/名称/游戏/状态/最近错误，**不含安装路径与端口**，
   * 且只要求调用方有自己模块的读权限点（`mod:read` / `backup:read` / `schedule:read` /
   * `member:read` / `instance:read` 任一），所以这些页面的菜单不必依赖「查看实例」。
   */
  getInstanceOptions: (data?: InstanceListQuery) => api.post('app/instance/options', data) as Promise<{ data: InstanceSummaryItem[] }>,
  getInstanceStatusCounts: (data?: InstanceStatusCountsQuery) => api.post('app/instance/status-counts', data) as Promise<{ data: InstanceStatusCounts }>,
  getInstanceMetrics: (ids?: string[], options?: { signal?: AbortSignal }) => api.post('app/instance/metrics', ids?.length ? { ids } : {}, options) as Promise<{ data: InstanceMetricsPayload }>,
  getInstallableGames: () => api.get('app/instance/games') as Promise<{ data: InstallableGameItem[] }>,
  getInstanceInstallLog: (id: string) => api.get('app/instance/install-log', {
    params: { id },
  }) as Promise<{ data: InstanceInstallLogPayload }>,
  createInstance: (data: CreateInstancePayload) => api.post('app/instance/create', data),
  updateInstance: (id: string, options?: { force?: boolean }) => api.post('app/instance/update', { id, force: options?.force }),
  checkInstanceUpdates: (ids?: string[], options?: { signal?: AbortSignal }) => api.post('app/instance/check-updates', ids?.length ? { ids } : {}, options) as Promise<{ data: InstanceUpdateCheckJobPayload }>,
  getInstanceUpdateCheckStatus: (options?: { signal?: AbortSignal }) => api.get('app/instance/check-updates/status', options) as Promise<{ data: InstanceUpdateCheckJobPayload }>,
  allocateInstancePorts: (id: string) => api.post('app/instance/allocate-ports', { id }) as Promise<{ data: InstanceAllocatePortsPayload }>,
  startInstance: (id: string, options?: { autoAllocatePorts?: boolean }) => api.post('app/instance/start', {
    id,
    ...(options?.autoAllocatePorts ? { autoAllocatePorts: true } : {}),
  }),
  stopInstance: (id: string) => api.post('app/instance/stop', { id }),
  restartInstance: (id: string, options?: { autoAllocatePorts?: boolean }) => api.post('app/instance/restart', {
    id,
    ...(options?.autoAllocatePorts ? { autoAllocatePorts: true } : {}),
  }),
  deleteInstance: (id: string) => api.post('app/instance/delete', { id }),
  getInstanceConnectInfo: (instanceId: string) => api.get('app/instance/connect-info', {
    params: { instanceId },
  }) as Promise<{ data: InstanceConnectInfo }>,
  getInstanceWorldState: (instanceId: string, shard: 'master' | 'caves' = 'master') => api.get('app/instance/world-state', {
    params: { instanceId, shard },
  }) as Promise<{ data: InstanceWorldStateDto }>,
  getInstanceConsoleLogs: (instanceId: string, afterId = 0, stream: InstanceConsoleLogFilter = 'all') => api.get('app/instance/console/logs', {
    params: { instanceId, afterId, stream: stream === 'all' ? undefined : stream },
  }) as Promise<{ data: InstanceConsoleLogsPayload }>,
  clearInstanceConsoleLogs: (instanceId: string) => api.post('app/instance/console/logs/clear', { instanceId }),
  getInstanceConsoleLogHistory: (instanceId: string) => api.get('app/instance/console/logs/history', {
    params: { instanceId },
  }) as Promise<{ data: ConsoleLogHistoryDto }>,
  downloadInstanceConsoleLog: (instanceId: string) => api.get('app/instance/console/logs/download', {
    params: { instanceId },
    responseType: 'blob',
  }) as Promise<{ data: Blob }>,
  sendInstanceConsoleCommand: (
    instanceId: string,
    command: string,
    shard: InstanceConsoleCommandShard = 'master',
  ) => api.post('app/instance/console/command', {
    instanceId,
    command,
    shard,
  }),
  createInstanceConsoleStreamTicket: (instanceId: string) => api.post('app/instance/console/stream-ticket', {
    instanceId,
  }) as Promise<{ data: InstanceConsoleStreamTicket }>,
  getInstanceMaintenanceAnnounce: (instanceId: string) => api.get('app/instance/maintenance/announce', {
    params: { instanceId },
  }) as Promise<{ data: InstanceMaintenanceAnnounceState }>,
  saveInstanceMaintenanceAnnounceDraft: (instanceId: string, message: string) => api.put('app/instance/maintenance/announce', {
    instanceId,
    message,
  }) as Promise<{ data: InstanceMaintenanceAnnounceState }>,
  pushInstanceMaintenanceAnnounce: (instanceId: string, message?: string) => api.post('app/instance/maintenance/announce/push', {
    instanceId,
    ...(message !== undefined ? { message } : {}),
  }) as Promise<{ data: InstanceMaintenancePushResult }>,
  buildInstanceConsoleStreamUrl(instanceId: string, streamTicket: string) {
    const base = withTrailingSlash(resolveApiBaseUrl({
      dev: import.meta.env.DEV,
      proxyEnabled: import.meta.env.VITE_ENABLE_PROXY,
      configured: import.meta.env.VITE_APP_API_BASEURL,
    }))
    const params = new URLSearchParams({ instanceId, streamTicket })
    return `${base}app/instance/console/stream?${params.toString()}`
  },
}
