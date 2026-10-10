import { z } from 'zod'
import { instanceIdSchema } from './instance'
import { shardIdSchema, worldSeedSchema } from './shard'

const base = z.object({ instanceId: instanceIdSchema, requestId: z.string().uuid(), backupBefore: z.boolean().default(true) })
const confirmName = z.string().trim().min(1).max(128)
const sessionId = z.string().regex(/^[A-Fa-f0-9]{16}$/)
export const worldMaintenancePayloadSchema = z.discriminatedUnion('action', [
  base.extend({ action: z.literal('save') }),
  base.extend({ action: z.literal('rollback'), sessionId, cavesSessionId: sessionId.nullable().optional(), snapshotId: z.number().int().min(1).max(9999999999) }),
  base.extend({ action: z.literal('reset'), confirmName }),
  base.extend({ action: z.literal('regenerate'), confirmName, shard: shardIdSchema, worldSeed: worldSeedSchema.nullable() }),
])
export type WorldMaintenancePayload = z.infer<typeof worldMaintenancePayloadSchema>
export const worldMaintenanceQuerySchema = z.object({ instanceId: instanceIdSchema, operationId: z.string().uuid().optional() })
export const worldMaintenanceContinueSchema = z.object({ instanceId: instanceIdSchema, operationId: z.string().uuid(), withoutBackup: z.boolean() })
export const worldMaintenanceOperationSchema = z.object({
  id: z.string().uuid(),
  requestId: z.string().uuid(),
  instanceId: instanceIdSchema,
  action: z.enum(['save', 'rollback', 'reset', 'regenerate']),
  scope: z.enum(['cluster', 'shard']),
  shards: z.array(shardIdSchema),
  state: z.enum(['running', 'awaiting_confirmation', 'completed', 'failed', 'unknown', 'cancelled']),
  phase: z.enum(['preparing', 'saving', 'backing_up', 'applying_config', 'executing', 'starting', 'verifying', 'finished']),
  startedAt: z.string(),
  updatedAt: z.string(),
  deadlineAt: z.string().nullable(),
  confirmationExpiresAt: z.string().nullable(),
  backupId: z.string().nullable(),
  backupWarning: z.string().nullable(),
  backupSkipped: z.boolean(),
  message: z.string().nullable(),
  canContinue: z.boolean(),
  targetSnapshotId: z.number().nullable(),
  targetWorldDay: z.number().nullable(),
})
export type WorldMaintenanceOperation = z.infer<typeof worldMaintenanceOperationSchema>
export type WorldMaintenanceAction = WorldMaintenanceOperation['action']
