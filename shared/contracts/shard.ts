import { z } from 'zod'
import { instanceIdSchema, instanceStatusSchema } from './instance'

export const shardIdSchema = z.enum(['master', 'caves'])
export type ShardId = z.infer<typeof shardIdSchema>

export const shardContainerStatusSchema = z.enum([
  'running',
  'stopped',
  'not_created',
  'unknown',
])
export type ShardContainerStatus = z.infer<typeof shardContainerStatusSchema>

export const masterWorldgenPresetSchema = z.literal('SURVIVAL_TOGETHER')
export type MasterWorldgenPreset = z.infer<typeof masterWorldgenPresetSchema>

export const cavesWorldgenPresetSchema = z.enum([
  'DST_CAVE',
  'DST_CAVE_PLUS',
  'COMPLETE_DARKNESS',
])
export type CavesWorldgenPreset = z.infer<typeof cavesWorldgenPresetSchema>

export const shardWorldgenPresetSchema = z.union([
  masterWorldgenPresetSchema,
  cavesWorldgenPresetSchema,
])
export type ShardWorldgenPreset = z.infer<typeof shardWorldgenPresetSchema>

export type ShardInstanceStatus = z.infer<typeof instanceStatusSchema>

const portSchema = z.number().int().min(1).max(65535)
const overrideKeySchema = z.string().regex(/^[a-z][a-z0-9_]*$/).max(64)
// 允许空格：DST 官方档位值存在 'highly random'（prefabswaps_start），写入 Lua 时带引号安全
/** 世界规则档位值的公共校验（允许空格：DST 官方值存在 'highly random'） */
export const overrideValueSchema = z.string().regex(/^[a-zA-Z0-9_.+ -]+$/).max(64)
const worldOverridesSchema = z.record(overrideKeySchema, overrideValueSchema).refine(
  value => Object.keys(value).length <= 128,
  '世界规则项不能超过 128 条',
)

/**
 * 世界种子：1–15 位数字。
 *
 * 游戏的默认种子是 6 位（os.time() 反转后取前 6 位），社区流传与分享的种子多为 10 位；
 * 上限 15 位是为了让数值稳定落在双精度可精确表示的范围内（2^53），避免写入 Lua 后取整走样。
 */
export const worldSeedPattern = /^\d{1,15}$/
export const worldSeedSchema = z.string().regex(worldSeedPattern, '世界种子只能是 1–15 位数字')
export type WorldSeed = z.infer<typeof worldSeedSchema>

export const shardInstanceQuerySchema = z.object({
  instanceId: instanceIdSchema,
})

export const shardSummarySchema = z.object({
  id: shardIdSchema,
  displayName: z.string(),
  configured: z.boolean(),
  containerStatus: shardContainerStatusSchema,
  serverPort: portSchema.nullable(),
  steamAuthPort: portSchema.nullable(),
  steamMasterPort: portSchema.nullable(),
  worldgenPreset: shardWorldgenPresetSchema.nullable(),
  /** 本分片已保存的世界配置覆盖项（真源：worldgenoverride.lua 的 overrides） */
  overrides: z.record(z.string(), z.string()).nullable(),
  /** 面板记录的世界种子；null 表示留空（由游戏自己随机） */
  worldSeed: worldSeedSchema.nullable(),
  /**
   * 当前世界的真实种子：实例运行期间向游戏问到的 `TheWorld.meta.seed`（与存档记录一致）。
   * null 表示暂时没有可信的值——从未读到，或世界刚被重新生成、新种子还没读到。
   */
  currentWorldSeed: worldSeedSchema.nullable(),
  worldGenerated: z.boolean(),
  isMaster: z.boolean(),
  panelSaved: z.boolean(),
  configDirty: z.boolean(),
})
export type ShardSummaryDto = z.infer<typeof shardSummarySchema>

export const shardListSchema = z.object({
  instanceId: instanceIdSchema,
  instanceName: z.string(),
  instanceStatus: instanceStatusSchema,
  clusterShardEnabled: z.boolean(),
  shards: z.array(shardSummarySchema),
  /**
   * @deprecated 服务端不再产生提示文案，恒为空数组：面向用户的说明已内联到页面对应位置。
   * 字段暂时保留，仅为兼容仍执行缓存中旧前端的浏览器（旧代码做 `[...effectiveHints]`，缺字段会崩），下个版本移除。
   */
  effectiveHints: z.array(z.string()),
  warnings: z.array(z.string()),
})
export type ShardListDto = z.infer<typeof shardListSchema>

export const shardSavePayloadSchema = z.object({
  instanceId: instanceIdSchema,
  shard: shardIdSchema,
  serverPort: portSchema,
  steamAuthPort: portSchema,
  steamMasterPort: portSchema,
  worldgenPreset: shardWorldgenPresetSchema,
  worldRuleOverrides: worldOverridesSchema.optional(),
  worldgenOverrides: worldOverridesSchema.optional(),
  /**
   * 世界种子：写入该分片下次生成地图时使用的种子；null 表示清除（回到随机）。
   * 省略该字段表示不变更，与其余差异提交字段语义一致。
   */
  worldSeed: worldSeedSchema.nullable().optional(),
  restart: z.boolean().optional(),
}).superRefine((payload, context) => {
  const isValidMasterPreset = payload.shard === 'master'
    && payload.worldgenPreset === 'SURVIVAL_TOGETHER'
  const isValidCavesPreset = payload.shard === 'caves'
    && payload.worldgenPreset !== 'SURVIVAL_TOGETHER'
  if (!isValidMasterPreset && !isValidCavesPreset) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['worldgenPreset'],
      message: '世界生成预设与分片类型不匹配',
    })
  }
})
export type ShardSavePayload = z.infer<typeof shardSavePayloadSchema>

export const shardSaveResultSchema = z.object({
  saved: z.literal(true),
  restarted: z.boolean(),
})
export type ShardSaveResult = z.infer<typeof shardSaveResultSchema>

export const shardInitCavesResultSchema = z.object({
  initialized: z.boolean(),
  alreadyConfigured: z.boolean(),
  serverPort: portSchema,
  steamAuthPort: portSchema,
  steamMasterPort: portSchema,
  worldgenPreset: cavesWorldgenPresetSchema,
})
export type ShardInitCavesResult = z.infer<typeof shardInitCavesResultSchema>

/** 回档步数上限：防御性上限，实际可用步数由游戏内快照与房间设置决定 */
export const SHARD_ROLLBACK_STEPS_LIMIT = 99

export const shardSnapshotSchema = z.object({
  /** 会话与世界快照编号构成的稳定标识 */
  id: z.string(),
  sessionId: z.string(),
  snapshotId: z.number().int().positive(),
  worldDay: z.number().int().positive().nullable(),
  cavesAvailable: z.boolean().nullable(),
  cavesSessionId: z.string().nullable(),
  rollbackSteps: z.number().int().positive().nullable(),
  unavailableReason: z.string().nullable(),
  /** 世界文件的最后修改时间（ISO） */
  savedAt: z.string(),
})
export type ShardSnapshotDto = z.infer<typeof shardSnapshotSchema>

export const shardSnapshotsQuerySchema = z.object({
  instanceId: instanceIdSchema,
  shard: shardIdSchema,
})
export type ShardSnapshotsQuery = z.infer<typeof shardSnapshotsQuerySchema>

export const shardSnapshotsSchema = z.object({
  instanceId: instanceIdSchema,
  shard: shardIdSchema,
  running: z.boolean(),
  /** 房间设置里的快照保留数量；实际回档范围取决于现存快照 */
  maxSnapshots: z.number().int().min(1),
  maxRollbackSteps: z.number().int().min(0),
  currentSessionId: z.string().nullable(),
  cavesConfigured: z.boolean(),
  snapshots: z.array(shardSnapshotSchema),
  warnings: z.array(z.string()),
})
export type ShardSnapshotsDto = z.infer<typeof shardSnapshotsSchema>

export const shardRollbackPayloadSchema = z.object({
  instanceId: instanceIdSchema,
  shard: shardIdSchema,
  steps: z.number().int().min(1).max(SHARD_ROLLBACK_STEPS_LIMIT),
  /** 默认开启：回档前先自动备份一次，回档过头还能从备份翻回来 */
  backupBeforeRollback: z.boolean().optional(),
})
export type ShardRollbackPayload = z.infer<typeof shardRollbackPayloadSchema>

export const shardResetWorldPayloadSchema = z.object({
  instanceId: instanceIdSchema,
  shard: shardIdSchema,
  /** 二次确认：须与实例名完全一致，避免误点 */
  confirmName: z.string().trim().min(1).max(128),
})
export type ShardResetWorldPayload = z.infer<typeof shardResetWorldPayloadSchema>

export const shardMaintenanceResultSchema = z.object({
  accepted: z.literal(true),
  /** 兼容旧字段；命令细节只写诊断日志，新入口不回传 Lua */
  command: z.string(),
  operationId: z.string().uuid().optional(),
  /** 安全备份 ID；未做备份或备份失败时为 null */
  backupId: z.string().nullable(),
  /** 备份失败会暂停操作，等待用户再次确认 */
  backupWarning: z.string().nullable(),
})
export type ShardMaintenanceResult = z.infer<typeof shardMaintenanceResultSchema>

/** 主动读取当前世界真实种子：需要实例（及目标分片）正在运行 */
export const shardReadWorldSeedPayloadSchema = z.object({
  instanceId: instanceIdSchema,
  shard: shardIdSchema,
})
export type ShardReadWorldSeedPayload = z.infer<typeof shardReadWorldSeedPayloadSchema>

export const shardWorldSeedProbeSchema = z.object({
  instanceId: instanceIdSchema,
  shard: shardIdSchema,
  /** 是否从游戏读到了真实种子 */
  available: z.boolean(),
  /** 游戏记录的真实种子（游戏内的 TheWorld.meta.seed）；读不到时为 null */
  seed: worldSeedSchema.nullable(),
  /** 读取时间（ISO）；读不到时为 null，此时沿用面板此前记录的值 */
  recordedAt: z.string().nullable(),
  /** 读不到时的说明（实例未运行、世界尚未加载完等） */
  message: z.string().nullable(),
})
export type ShardWorldSeedProbe = z.infer<typeof shardWorldSeedProbeSchema>

/** 兼容入口：运行中生成所选分片，全部停止时清理目标存档并启动；结果查询 operationId。 */
export const shardResetWorldWithSeedPayloadSchema = z.object({
  instanceId: instanceIdSchema,
  shard: shardIdSchema,
  /** 世界种子；null 或省略表示由游戏随机 */
  worldSeed: worldSeedSchema.nullable().optional(),
})
export type ShardResetWorldWithSeedPayload = z.infer<typeof shardResetWorldWithSeedPayloadSchema>

export const shardResetWorldWithSeedResultSchema = z.object({
  accepted: z.literal(true),
  operationId: z.string().uuid().optional(),
  /** 安全备份 ID；未备份或备份失败时为 null */
  backupId: z.string().nullable(),
  /** 备份失败会暂停操作，等待用户再次确认 */
  backupWarning: z.string().nullable(),
  /** 兼容旧字段；新流程异步执行，以维护操作的最终状态为准 */
  restarted: z.boolean(),
  /** 兼容旧字段；生成及启动结果通过 operationId 查询 */
  restartWarning: z.string().nullable(),
})
export type ShardResetWorldWithSeedResult = z.infer<typeof shardResetWorldWithSeedResultSchema>
