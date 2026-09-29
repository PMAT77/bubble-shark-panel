import { z } from 'zod'

export const instanceIdSchema = z.string().trim().min(1).max(128)

export const instanceStatusSchema = z.enum([
  'pending_install',
  'running',
  'stopped',
  'installing',
  'error',
])
export type InstanceStatus = z.infer<typeof instanceStatusSchema>

export const instanceListQuerySchema = z.object({
  nodeId: z.string().trim().min(1).max(128).optional(),
  status: instanceStatusSchema.optional(),
  keyword: z.string().trim().min(1).max(256).optional(),
})
export type InstanceListQuery = z.infer<typeof instanceListQuerySchema>

/** 统计卡各状态计数（全量口径，不受 status 筛选影响） */
export const instanceStatusCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  pendingInstall: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  stopped: z.number().int().nonnegative(),
  installing: z.number().int().nonnegative(),
  error: z.number().int().nonnegative(),
})
export type InstanceStatusCounts = z.infer<typeof instanceStatusCountsSchema>

/** 统计计数查询范围：跟随节点与关键词，刻意不含 status */
export const instanceStatusCountsQuerySchema = z.object({
  nodeId: z.string().trim().min(1).max(128).optional(),
  keyword: z.string().trim().min(1).max(256).optional(),
})
export type InstanceStatusCountsQuery = z.infer<typeof instanceStatusCountsQuerySchema>

const portSchema = z.number().int().min(1).max(65535)

// 可选路径字段：空字符串（含纯空白）视为未提供，避免表单提交空值被 min(1) 拒绝
const optionalPathSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(1).max(1024).optional(),
)

export const createInstanceBodySchema = z.object({
  nodeId: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(128),
  gameCode: z.string().trim().min(1).max(64),
  installPath: optionalPathSchema,
  configPath: optionalPathSchema,
  queryPort: portSchema.optional(),
  gamePort: portSchema.optional(),
  rconPort: portSchema.optional(),
})
export type CreateInstancePayload = z.infer<typeof createInstanceBodySchema>

export const instanceActionBodySchema = z.object({
  id: instanceIdSchema,
  force: z.boolean().optional(),
  autoAllocatePorts: z.boolean().optional(),
})
export type InstanceActionBody = z.infer<typeof instanceActionBodySchema>

export const instanceIdsBodySchema = z.object({
  ids: z.array(instanceIdSchema).max(100).optional(),
})
export type InstanceIdsBody = z.infer<typeof instanceIdsBodySchema>

export const instanceInstallLogQuerySchema = z.object({
  id: instanceIdSchema,
})

export const instanceRuntimeMetricsSchema = z.object({
  cpuUsageRate: z.number().nullable(),
  memoryMb: z.number().nullable(),
  uptimeSeconds: z.number().int().nonnegative().nullable(),
})
export type InstanceRuntimeMetrics = z.infer<typeof instanceRuntimeMetricsSchema>

export const instanceMetricsPayloadSchema = z.object({
  items: z.record(z.string(), instanceRuntimeMetricsSchema.nullable()),
  collectedAt: z.string(),
})
export type InstanceMetricsPayload = z.infer<typeof instanceMetricsPayloadSchema>

export const instanceUpdateStatusItemSchema = z.object({
  id: instanceIdSchema,
  name: z.string(),
  updateAvailable: z.boolean(),
  localBuildId: z.string().nullable(),
  remoteBuildId: z.string().nullable(),
  updateCheckedAt: z.string().nullable(),
  message: z.string().optional(),
})
export type InstanceUpdateStatusItem = z.infer<typeof instanceUpdateStatusItemSchema>

export const instanceCheckUpdatesPayloadSchema = z.object({
  items: z.array(instanceUpdateStatusItemSchema),
  updateAvailableCount: z.number().int().nonnegative(),
})
export type InstanceCheckUpdatesPayload = z.infer<typeof instanceCheckUpdatesPayloadSchema>

export const instanceUpdateCheckJobPayloadSchema = z.object({
  checking: z.boolean(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  result: instanceCheckUpdatesPayloadSchema.nullable(),
  error: z.string().nullable(),
})
export type InstanceUpdateCheckJobPayload = z.infer<typeof instanceUpdateCheckJobPayloadSchema>

export const installableGameItemSchema = z.object({
  appId: z.string(),
  name: z.string(),
  steamcmdLoginMode: z.enum(['anonymous', 'account', 'account-fallback']).optional(),
})
export type InstallableGameItem = z.infer<typeof installableGameItemSchema>

export const instanceInstallLogSourceSchema = z.enum(['install_log', 'status_summary', 'empty'])
export type InstanceInstallLogSource = z.infer<typeof instanceInstallLogSourceSchema>

export const instanceInstallLogPayloadSchema = z.object({
  content: z.string(),
  status: z.enum(['success', 'failed', 'running', 'unknown']),
  updatedAt: z.string().nullable(),
  source: instanceInstallLogSourceSchema,
})
export type InstanceInstallLogPayload = z.infer<typeof instanceInstallLogPayloadSchema>

export const instanceAllocatePortsPayloadSchema = z.object({
  gamePort: portSchema,
})
export type InstanceAllocatePortsPayload = z.infer<typeof instanceAllocatePortsPayloadSchema>

export const instancePortConflictDataSchema = z.object({
  conflictingPorts: z.array(portSchema).optional(),
  suggestedGamePort: portSchema.nullable().optional(),
  currentGamePort: portSchema.optional(),
})
export type InstancePortConflictData = z.infer<typeof instancePortConflictDataSchema>

export const instanceItemSchema = z.object({
  id: instanceIdSchema,
  nodeId: z.string(),
  name: z.string(),
  gameCode: z.string(),
  status: instanceStatusSchema,
  containerId: z.string().nullable(),
  installPath: z.string().nullable(),
  configPath: z.string().nullable(),
  queryPort: portSchema.nullable(),
  gamePort: portSchema.nullable(),
  rconPort: portSchema.nullable(),
  lastCommand: z.string().nullable(),
  lastError: z.string().nullable(),
  /** 运行期警告（重启循环 / 退出原因 / 分片残留）；停止实例不清空，与 lastError 分开 */
  runtimeWarning: z.string().nullable(),
  /** 最近一次异常退出检测时间（ISO）；成功启动后清除 */
  unexpectedExitAt: z.string().nullable(),
  installLogStatus: z.enum(['running', 'success', 'failed']).nullable(),
  installPercent: z.number().nullable(),
  installLogUpdatedAt: z.string().nullable(),
  updateAvailable: z.boolean(),
  localBuildId: z.string().nullable(),
  remoteBuildId: z.string().nullable(),
  updateCheckedAt: z.string().nullable(),
  runtimeStartedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type InstanceItem = z.infer<typeof instanceItemSchema>

/**
 * 「实例标识」：给**不是实例管理模块**的页面用的最小投影。
 *
 * 为什么单独一个 schema：房间/世界/玩家/Mod/备份/计划任务/成员这些页面要列出"我能管的实例"
 * （或给出目标实例下拉），但它们不需要安装路径、端口、节点这些信息。此前它们直接调
 * `/app/instance/list`（要求 `instance:read`），于是"看房间"被迫等于"能看实例管理"；
 * 现在它们走 `/app/instance/options`，只拿这里的字段，权限也只需要自己的那个读权限点。
 *
 * 字段恰好够用：`status/lastError/lastCommand` 是 `getInstanceState()` 判定
 * 「安装失败 / 运行异常」的输入，`gameCode` 用于筛出本游戏的实例。
 */
export const instanceSummaryItemSchema = z.object({
  id: instanceIdSchema,
  name: z.string(),
  gameCode: z.string(),
  status: instanceStatusSchema,
  lastError: z.string().nullable(),
  lastCommand: z.string().nullable(),
})
export type InstanceSummaryItem = z.infer<typeof instanceSummaryItemSchema>

/** 世界运行时状态查询（通过游戏内指令回读，仅运行中实例可用） */
export const instanceWorldStateQuerySchema = z.object({
  instanceId: instanceIdSchema,
  shard: z.enum(['master', 'caves']).default('master'),
})
export type InstanceWorldStateQuery = z.infer<typeof instanceWorldStateQuerySchema>

export const instanceWorldStateSchema = z.object({
  instanceId: instanceIdSchema,
  /** 查询是否成功（指令已送达且日志回读到结果） */
  available: z.boolean(),
  /** 世界天数（0 起，展示层 +1） */
  cycles: z.number().int().nonnegative().nullable(),
  /** 季节（autumn/winter/spring/summer 或 Mod 自定义） */
  season: z.string().nullable(),
  /** 当前季节内的天数（0 起，展示层 +1） */
  daysInSeason: z.number().int().nonnegative().nullable(),
  /** 不可用原因说明（available=false 时给用户看的文案） */
  message: z.string().optional(),
})
export type InstanceWorldStateDto = z.infer<typeof instanceWorldStateSchema>
