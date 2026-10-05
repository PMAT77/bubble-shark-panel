import { z } from 'zod'

const portSchema = z.number().int().min(1).max(65535)
const trimmedTextSchema = z.string().trim()
const successResultSchema = z.object({
  isSuccess: z.literal(true),
})

export const panelThemeSchema = z.enum(['light', 'dark', 'system'])
/** 面板更新下载源：auto=优先 Release 离线镜像包、失败回退镜像仓库；offline=只用离线包；pull=只用镜像仓库 */
export const panelUpdateSourceSchema = z.enum(['auto', 'offline', 'pull'])
export const panelSettingsPayloadSchema = z.object({
  panelPort: portSchema,
  theme: panelThemeSchema,
  autoUpdate: z.boolean(),
  checkUpdateBeforeStart: z.boolean(),
  updateCheckIntervalHours: z.number().int().min(1).max(168),
  updateSource: panelUpdateSourceSchema,
})
export type PanelSettingsPayload = z.infer<typeof panelSettingsPayloadSchema>

export const panelSettingsRequestSchema = panelSettingsPayloadSchema.partial()
export type PanelSettingsRequest = z.infer<typeof panelSettingsRequestSchema>

/** 保存设置时把端口写进部署配置的结果：written=已写入；unchanged=与当前一致；skipped=该环境无需处理；manual=需用户手动执行命令 */
export const panelPortSyncStatusSchema = z.enum(['written', 'unchanged', 'skipped', 'manual'])
export const panelPortEnvKeySchema = z.enum(['PANEL_PORT', 'SERVER_PORT'])
export const panelPortSyncSchema = z.object({
  status: panelPortSyncStatusSchema,
  envKey: panelPortEnvKeySchema.nullable(),
  port: portSchema,
  message: z.string(),
  manualCommand: z.string().nullable(),
})
export type PanelPortSync = z.infer<typeof panelPortSyncSchema>

export const panelSettingsSaveResponseSchema = successResultSchema.extend({
  portSync: panelPortSyncSchema.nullable(),
})
export type PanelSettingsSaveResponse = z.infer<typeof panelSettingsSaveResponseSchema>

export const panelSettingsResponseSchema = panelSettingsPayloadSchema.extend({
  /** 面板实际监听的端口（服务端按 BSP_PANEL_PUBLISHED_PORT / X-Forwarded-* / Host 头判定） */
  apiPort: portSchema,
  /**
   * 是否为生产部署。开发环境下前端（Vite）与后端各占一个端口，「面板端口」没有单一含义，
   * 设置页据此隐藏该区块，避免出现「设置里一个端口、浏览器地址栏另一个端口」的误导。
   */
  isProduction: z.boolean(),
})
export type PanelSettingsResponse = z.infer<typeof panelSettingsResponseSchema>

export const directoryItemSchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(['directory', 'file']),
})
export type DirectoryItem = z.infer<typeof directoryItemSchema>

export const directoryListQuerySchema = z.object({
  path: trimmedTextSchema.max(2048).optional(),
})
export type DirectoryListQuery = z.infer<typeof directoryListQuerySchema>

export const directorySearchQuerySchema = z.object({
  keyword: trimmedTextSchema.max(64).optional(),
})
export type DirectorySearchQuery = z.infer<typeof directorySearchQuerySchema>

export const steamcmdConfigPayloadSchema = z.object({
  steamcmdPath: trimmedTextSchema.min(1).max(2048),
  installRoot: trimmedTextSchema.min(1).max(2048),
})
export type SteamcmdConfigPayload = z.infer<typeof steamcmdConfigPayloadSchema>

export const steamcmdConfigRequestSchema = steamcmdConfigPayloadSchema.partial()
export type SteamcmdConfigRequest = z.infer<typeof steamcmdConfigRequestSchema>

export const steamcmdConfigResponseSchema = steamcmdConfigPayloadSchema.extend({
  runtimeMode: z.enum(['docker', 'native']),
  runtimeStatus: z.enum(['running', 'stopped']),
  steamcmdImage: z.string(),
  gameDstImage: z.string(),
  isDockerAvailable: z.boolean(),
  isSteamcmdInstalled: z.boolean(),
  isGameDstImageInstalled: z.boolean(),
  detectedSteamcmdPath: z.string(),
  downloadRegion: z.string(),
  networkMode: z.string(),
  installMaxAttempts: z.number().int().positive(),
  httpProxyConfigured: z.boolean(),
  httpsProxyConfigured: z.boolean(),
})
export type SteamcmdConfigResponse = z.infer<typeof steamcmdConfigResponseSchema>

export const networkConfigPayloadSchema = z.object({
  mode: z.enum(['bootstrap_pending', 'managed']),
  httpPort: portSchema,
  domain: trimmedTextSchema.max(253),
  tls: z.object({
    enabled: z.boolean(),
    provider: z.enum(['none', 'letsencrypt', 'custom']),
  }),
})
export type NetworkConfigPayload = z.infer<typeof networkConfigPayloadSchema>

export const networkConfigRequestSchema = z.object({
  mode: networkConfigPayloadSchema.shape.mode.optional(),
  httpPort: networkConfigPayloadSchema.shape.httpPort.optional(),
  domain: networkConfigPayloadSchema.shape.domain.optional(),
  tls: z.object({
    enabled: z.boolean().optional(),
    provider: z.enum(['none', 'letsencrypt', 'custom']).optional(),
  }).optional(),
})
export type NetworkConfigRequest = z.infer<typeof networkConfigRequestSchema>

export const networkInterfaceRealtimeSchema = z.object({
  name: z.string(),
  upBps: z.number().nonnegative(),
  downBps: z.number().nonnegative(),
  totalSentBytes: z.number().nonnegative(),
  totalReceivedBytes: z.number().nonnegative(),
})
export type NetworkInterfaceRealtime = z.infer<typeof networkInterfaceRealtimeSchema>

export const networkRealtimeSchema = z.object({
  timestamp: z.number().int().nonnegative(),
  interfaces: z.array(networkInterfaceRealtimeSchema),
})
export type NetworkRealtime = z.infer<typeof networkRealtimeSchema>

const hubImageUpdateInfoSchema = z.object({
  image: z.string(),
  tag: z.string(),
  releaseVersion: z.string().nullable(),
  localDigest: z.string().nullable(),
  localDigestShort: z.string().nullable(),
  remoteDigest: z.string().nullable(),
  remoteDigestShort: z.string().nullable(),
  updateAvailable: z.boolean(),
  localPresent: z.boolean(),
  checkError: z.string().nullable(),
})
export type HubImageUpdateInfo = z.infer<typeof hubImageUpdateInfoSchema>

const gitHubReleaseSummarySchema = z.object({
  tagName: z.string(),
  name: z.string(),
  body: z.string(),
  publishedAt: z.string(),
  htmlUrl: z.string(),
})
export type GitHubReleaseSummary = z.infer<typeof gitHubReleaseSummarySchema>

export const panelUpdateStatusSchema = z.object({
  runtimeMode: z.enum(['docker', 'native']),
  /** v0.2.0 起统一镜像：面板/DST/SteamCMD 共用同一镜像，单一更新目标 */
  image: hubImageUpdateInfoSchema,
  release: gitHubReleaseSummarySchema.nullable(),
  lastCheckedAt: z.string().nullable(),
  checking: z.boolean(),
  updating: z.boolean(),
  applySupported: z.boolean(),
  imageApplySupported: z.boolean(),
  /** Native/systemd 部署是否支持面板内一键更新（安装器已布置特权更新组件时为真） */
  nativeUpdateSupported: z.boolean(),
  applyHint: z.string().nullable(),
  /** 更新语义分类：无更新 / 版本更高 / 版本号相同但镜像内容不同 / 有更新但读不到版本号 */
  updateKind: z.enum(['none', 'newer', 'same-version-changed', 'unknown']),
  manualUpdateCommand: z.string().nullable(),
  /** 离线镜像包下载与导入命令（国内推荐路径） */
  offlineImageCommand: z.string().nullable(),
  checkError: z.string().nullable(),
  /** 一键更新的实时阶段：界面据此显示进度，而不是笼统的「更新中」 */
  updatePhase: z.enum(['idle', 'preparing', 'downloading', 'downloaded', 'installing', 'recreating', 'failed']),
  /** 当前阶段的用户可读说明 */
  updateMessage: z.string().nullable(),
  /** 上一次更新的失败原因（未开始或已成功时为 null） */
  updateError: z.string().nullable(),
  /** 本次更新的目标镜像引用：跨版本升级时指向 Release tag 对应的镜像 */
  targetImage: z.string().nullable(),
  /** 目标镜像是否已在本地（离线镜像包导入、或下载完成后为 true，可直接重建） */
  targetImageReady: z.boolean(),
  /** 下载阶段已下载字节；未开始下载或拿不到进度时为 null */
  downloadBytes: z.number().nonnegative().nullable(),
  /** 下载阶段本次需要下载的总字节；registry 未给出总量时为 null */
  downloadTotalBytes: z.number().nonnegative().nullable(),
})
export type PanelUpdateStatus = z.infer<typeof panelUpdateStatusSchema>

/**
 * 面板更新动作：
 * - 省略（旧前端）：下载并立即安装，保持一次点击完成更新；
 * - download：只把目标镜像拉到本地，完成后停在「等待安装」；
 * - install：用已就绪的镜像重建面板。
 */
export const panelUpdateApplyRequestSchema = z.object({
  action: z.enum(['download', 'install']).optional(),
}).strict()
export type PanelUpdateApplyRequest = z.infer<typeof panelUpdateApplyRequestSchema>

export const panelUpdateApplyResponseSchema = z.object({
  /** ready 表示镜像已在本地，无需下载，可直接点「立即安装」 */
  status: z.enum(['updating', 'completed', 'ready']),
  message: z.string(),
})
export type PanelUpdateApplyResponse = z.infer<typeof panelUpdateApplyResponseSchema>

export const systemSuccessResponseSchema = successResultSchema
export type SystemSuccessResponse = z.infer<typeof systemSuccessResponseSchema>

// ---------------------------------------------------------------------------
// 环境自检
// ---------------------------------------------------------------------------

export const selfCheckStatusSchema = z.enum(['ok', 'warn', 'fail', 'skipped'])
export type SelfCheckStatus = z.infer<typeof selfCheckStatusSchema>

export const selfCheckItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: selfCheckStatusSchema,
  /** 这一项的实测结论，直接可读，不含敏感值 */
  detail: z.string(),
  /** 不通过时的下一步动作；通过时为 null */
  hint: z.string().nullable(),
})
export type SelfCheckItem = z.infer<typeof selfCheckItemSchema>

export const selfCheckReportSchema = z.object({
  generatedAt: z.string(),
  releaseVersion: z.string(),
  runtimeMode: z.string(),
  items: z.array(selfCheckItemSchema),
  summary: z.object({
    ok: z.number().int().nonnegative(),
    warn: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }),
})
export type SelfCheckReport = z.infer<typeof selfCheckReportSchema>
