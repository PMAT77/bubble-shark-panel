import { z } from 'zod'

/** 仅兼容历史实例配置数据；新任务统一使用服务器设置。 */
const memoryLimitSchema = z.number().int().nonnegative().refine(value => value === 0 || value >= 6, '内存上限至少为 6 MiB，或设为 0 表示不限').nullable()
export const instanceResourceConfigSchema = z.object({
  masterMemoryMb: memoryLimitSchema,
  cavesMemoryMb: memoryLimitSchema,
  shardReadyWaitSec: z.number().int().positive().nullable(),
})
export type InstanceResourceConfig = z.infer<typeof instanceResourceConfigSchema>

const nullableNumber = z.number().nullable()
export const effectiveInstanceResourceSettingsSchema = z.object({ masterMemoryMb: nullableNumber, cavesMemoryMb: nullableNumber, shardReadyWaitSec: z.number().positive() })
export const swapAdviceSchema = z.object({
  state: z.enum(['unknown', 'none', 'low', 'exhausted', 'ready']),
  message: z.string(), command: z.string().nullable(),
})
export type SwapAdvice = z.infer<typeof swapAdviceSchema>
export const resourceSnapshotSchema = z.object({
  memoryCurrentMb: nullableNumber,
  memoryPeakMb: nullableNumber,
  memoryMaxMb: nullableNumber,
  memoryMaxState: z.enum(['finite', 'unlimited', 'unknown']).optional(),
  memoryHighState: z.enum(['finite', 'unlimited', 'unknown']).optional(),
  memoryAndSwapPeakMb: nullableNumber.optional(),
  peakLimited: z.boolean().optional(),
  memoryParent: z.string().nullable().optional(),
  runtimeIdentity: z.string().nullable().optional(),
  swapCurrentMb: nullableNumber,
  swapMaxMb: nullableNumber,
  memoryHighMb: nullableNumber,
  highEvents: nullableNumber,
  maxEvents: nullableNumber,
  oomKillCount: nullableNumber,
  memoryPressureFullAvg10: nullableNumber,
  throttledUsec: nullableNumber,
  exitCode: nullableNumber,
  restarts: nullableNumber,
  oomKilled: z.boolean().nullable(),
  measuredAt: z.string(),
})
export type ResourceSnapshot = z.infer<typeof resourceSnapshotSchema>

export const hostResourceSnapshotSchema = z.object({
  availableMb: nullableNumber, totalMb: nullableNumber, swapFreeMb: nullableNumber, swapTotalMb: nullableNumber,
  source: z.enum(['native-host', 'docker-host', 'unknown']),
  memoryPressureFullAvg10: nullableNumber,
  panelCurrentMb: nullableNumber, panelPeakMb: nullableNumber,
  reserveMb: z.number().nonnegative(), reserveEstimated: z.boolean(),
  budget: z.object({
    state: z.enum(['protected', 'legacy', 'unavailable']), message: z.string(),
    currentMb: nullableNumber, maxMb: nullableNumber, swapCurrentMb: nullableNumber,
    highMb: nullableNumber, highEvents: nullableNumber, maxEvents: nullableNumber, oomKillCount: nullableNumber,
    memoryPressureFullAvg10: nullableNumber,
  }),
})
export type HostResourceSnapshot = z.infer<typeof hostResourceSnapshotSchema>

export const memoryProtectionStopSchema = z.object({
  at: z.string(), code: z.enum(['oom', 'shard_memory_pressure', 'shared_memory_pressure', 'host_memory_pressure']),
  message: z.string(), cleanupCompleted: z.boolean(),
  master: resourceSnapshotSchema.nullable(), caves: resourceSnapshotSchema.nullable(),
  host: hostResourceSnapshotSchema.nullable(),
})
export type MemoryProtectionStop = z.infer<typeof memoryProtectionStopSchema>

export const instanceStartupShardSchema = z.object({
  state: z.enum(['pending', 'loading', 'ready', 'failed', 'disabled']),
  memoryPeakMb: nullableNumber,
  memoryAndSwapPeakMb: nullableNumber.optional(),
  peakLimited: z.boolean().optional(),
  restartBaseline: z.number().int().nonnegative().nullable().optional(),
  resources: resourceSnapshotSchema.optional(),
  resourceBaseline: resourceSnapshotSchema.optional(),
  resourceDeltas: z.object({ highEvents: nullableNumber, maxEvents: nullableNumber, oomKillCount: nullableNumber, throttledUsec: nullableNumber, restarts: nullableNumber }).optional(),
})
export const instanceStartupSnapshotSchema = z.object({
  taskId: z.string(),
  status: z.enum(['queued', 'running', 'success', 'failed', 'cancelled']),
  phase: z.enum(['queued', 'prepare', 'master_loading', 'caves_loading', 'connecting', 'ready', 'failed', 'cancelled']),
  startedAt: z.string(),
  phaseStartedAt: z.string(),
  phaseDeadlineAt: z.string().nullable(),
  updatedAt: z.string(),
  lastProgressAt: z.string().nullable().optional(),
  settings: effectiveInstanceResourceSettingsSchema.optional(),
  elapsedSeconds: z.number().nonnegative(),
  remainingSeconds: z.number().nonnegative().nullable(),
  master: instanceStartupShardSchema,
  caves: instanceStartupShardSchema,
  diagnosis: z.object({ code: z.string(), message: z.string() }).nullable(),
  swapAdvice: swapAdviceSchema.optional(),
  protectionStop: memoryProtectionStopSchema.optional(),
  poolOomBaseline: nullableNumber.optional(),
  planningDemand: z.object({ masterMb: nullableNumber, cavesMb: nullableNumber }).optional(),
})
export type InstanceStartupSnapshot = z.infer<typeof instanceStartupSnapshotSchema>

export const instanceResourcesQuerySchema = z.object({ id: z.string().trim().min(1).max(128) })
export const instanceResourcesBodySchema = instanceResourcesQuerySchema.extend({ config: instanceResourceConfigSchema })
export type InstanceResourcesBody = z.infer<typeof instanceResourcesBodySchema>
export const instanceResourcesPayloadSchema = z.object({
  config: instanceResourceConfigSchema,
  effective: effectiveInstanceResourceSettingsSchema,
  current: z.object({ master: resourceSnapshotSchema.nullable(), caves: resourceSnapshotSchema.nullable() }),
  recommendation: z.object({
    masterMemoryMb: z.number().positive(), cavesMemoryMb: z.number().positive(),
    modCount: z.number().int().nonnegative(), estimatedMb: z.number().nonnegative(), measuredAt: z.string(),
    masterPeakMb: nullableNumber, cavesPeakMb: nullableNumber,
    masterDemandMb: nullableNumber.optional(), cavesDemandMb: nullableNumber.optional(),
    masterPeakLimited: z.boolean().optional(), cavesPeakLimited: z.boolean().optional(),
  }),
  host: z.object({ availableMb: nullableNumber, totalMb: nullableNumber, swapFreeMb: nullableNumber, swapTotalMb: nullableNumber }),
  protection: hostResourceSnapshotSchema.optional(),
  swapAdvice: swapAdviceSchema,
})
export type InstanceResourcesPayload = z.infer<typeof instanceResourcesPayloadSchema>
