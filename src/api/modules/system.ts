import type {
  DirectoryItem,
  NetworkConfigPayload,
  NetworkRealtime,
  PanelPortSync,
  PanelSettingsPayload,
  PanelSettingsResponse,
  PanelSettingsSaveResponse,
  PanelUpdateApplyRequest,
  PanelUpdateApplyResponse,
  PanelUpdateStatus,
  SteamcmdConfigResponse,
  SelfCheckItem,
  SelfCheckReport,
  SelfCheckStatus,
} from '../../../shared/contracts/system'
import type { CommercialSupport } from '../../../shared/contracts/commercial'
import type { OperationAuditResult } from '../../../shared/contracts/audit'
import type {
  PluginAuditResult,
  PluginImportInspectResult,
  PluginImportRequest,
  PluginImportResult,
  PluginListItem,
  PluginListResult,
  PluginToggleRequest,
} from '../../../shared/contracts/plugin'
import api from '../index'

export type {
  CommercialSupport,
  DirectoryItem,
  NetworkConfigPayload,
  NetworkRealtime,
  OperationAuditResult,
  PanelPortSync,
  PanelSettingsPayload,
  PanelSettingsResponse,
  PanelSettingsSaveResponse,
  PanelUpdateApplyRequest,
  PanelUpdateApplyResponse,
  PanelUpdateStatus,
  PluginAuditResult,
  PluginImportInspectResult,
  PluginImportRequest,
  PluginImportResult,
  PluginListItem,
  PluginListResult,
  PluginToggleRequest,
  SelfCheckItem,
  SelfCheckReport,
  SelfCheckStatus,
  SteamcmdConfigResponse,
}

export default {
  getSettings: () => api.get('app/system/settings') as Promise<{ data: PanelSettingsResponse }>,
  saveSettings: (data: PanelSettingsPayload) => api.post('app/system/settings', data) as Promise<{
    data: PanelSettingsSaveResponse
  }>,
  getSystemInfo: () => api.get('app/system/info'),
  getNetworkRealtime: () => api.get('app/system/network/realtime') as Promise<{ data: NetworkRealtime }>,
  getDirectoryList: (directoryPath?: string) => api.get('app/system/filesystem/directories', {
    params: directoryPath ? { path: directoryPath } : undefined,
  }) as Promise<{ data: DirectoryItem[] }>,
  searchDirectoryList: (keyword: string) => api.get('app/system/filesystem/search', {
    params: { keyword },
  }) as Promise<{ data: DirectoryItem[] }>,
  getSteamcmdConfig: () => api.get('app/system/steamcmd/config') as Promise<{ data: SteamcmdConfigResponse }>,
  // 没有 saveSteamcmdConfig：`POST app/system/steamcmd/config` 会用服务端配置覆盖请求体里的
  // steamcmdPath 与 installRoot（见 server/src/modules/system/index.ts），从这里发出去只会得到
  // 「保存成功但数值不变」。SteamCMD 面板内配置保持只读，要让它可写需先改后端不再覆盖请求体。
  installSteamcmd: () => api.post('app/system/steamcmd/install'),
  installGameDstImage: () => api.post('app/system/game-dst/install'),
  getPanelUpdateStatus: () => api.get('app/system/panel-update/status') as Promise<{ data: PanelUpdateStatus }>,
  getSelfCheck: () => api.get('app/system/self-check') as Promise<{ data: SelfCheckReport }>,
  getCommercialSupport: () => api.get('app/system/commercial') as Promise<{ data: CommercialSupport }>,
  /** 插件列表：本机已装的 + 官方目录里尚未安装的（用 installed 区分） */
  getPluginList: () => api.get('app/system/plugins') as Promise<{ data: PluginListResult }>,
  /** 启用或停用插件；启用声明了危险能力的插件需要 acknowledgeDangerous */
  togglePlugin: (payload: PluginToggleRequest) => api.post('app/system/plugins/toggle', payload) as Promise<{ data: { message: string } }>,
  /** 插件调用审计（最近的在前）；不传 pluginId 则返回全部插件 */
  getPluginAudit: (params?: { pluginId?: string, limit?: number }) => api.get('app/system/plugins/audit', { params }) as Promise<{ data: PluginAuditResult }>,
  /**
   * 插件包导入第一步：上传原始字节并换回校验结论（此步不写插件目录）。
   *
   * 内容类型必须是这个专属值：服务端按它把原始流交给导入服务，
   * 而 `application/octet-stream` 已被存档导入占用（同一个内容类型注册两次会让面板起不来）。
   * 与实例文件上传同一套做法。
   */
  inspectPluginPackage: (file: File) => api.post(
    `app/system/plugins/import/inspect?fileName=${encodeURIComponent(file.name)}`,
    file,
    {
      headers: { 'Content-Type': 'application/x-bsp-plugin-package' },
      timeout: 0,
    },
  ) as Promise<{ data: PluginImportInspectResult }>,
  /** 插件包导入第二步：凭 uploadId 落位；导入后插件默认停用 */
  importPluginPackage: (payload: PluginImportRequest) => api.post('app/system/plugins/import', payload) as Promise<{ data: PluginImportResult }>,
  /** 用户操作审计：谁在什么时候对面板做了什么（含被拒的写操作） */
  getOperationAudit: (params?: { account?: string, limit?: number }) => api.get('app/system/audit/operations', { params }) as Promise<{ data: OperationAuditResult }>,
  checkPanelUpdate: () => api.post('app/system/panel-update/check') as Promise<{ data: PanelUpdateStatus }>,
  applyPanelUpdate: (data?: PanelUpdateApplyRequest) => api.post('app/system/panel-update/apply', data ?? {}) as Promise<{
    data: PanelUpdateApplyResponse
  }>,
}
