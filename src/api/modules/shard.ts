import type {
  ShardId,
  ShardInitCavesResult,
  ShardListDto,
  ShardMaintenanceResult,
  ShardResetWorldWithSeedResult,
  ShardRollbackPayload,
  ShardSavePayload,
  ShardSaveResult,
  ShardSnapshotsDto,
  ShardWorldSeedProbe,
} from '../../../shared/contracts/shard'
import api from '../index'

export type {
  ShardId,
  ShardContainerStatus,
  ShardListDto,
  ShardMaintenanceResult,
  ShardResetWorldWithSeedResult,
  ShardRollbackPayload,
  ShardSavePayload,
  ShardSaveResult,
  ShardSnapshotDto,
  ShardSnapshotsDto,
  ShardSummaryDto,
  ShardInitCavesResult,
  ShardWorldSeedProbe,
  CavesWorldgenPreset,
  MasterWorldgenPreset,
} from '../../../shared/contracts/shard'

export { shardSavePayloadSchema } from '../../../shared/contracts/shard'

export default {
  getShardList: (instanceId: string) => api.get('app/instance/shards', {
    params: { instanceId },
  }) as Promise<{ data: ShardListDto }>,
  initCaves: (instanceId: string) => api.post('app/instance/shards/init-caves', undefined, {
    params: { instanceId },
  }) as Promise<{ data: ShardInitCavesResult }>,
  saveShardConfig: (payload: ShardSavePayload) => api.put('app/instance/shards', payload) as Promise<{ data: ShardSaveResult }>,
  /** 向正在运行的分片询问当前世界的真实种子（读到后会被面板记录下来） */
  readWorldSeed: (payload: { instanceId: string, shard: ShardId }) =>
    api.post('app/instance/shards/read-world-seed', payload) as Promise<{ data: ShardWorldSeedProbe }>,
  /** 兼容入口：按种子生成所选分片，返回后台操作 ID */
  resetWorldWithSeed: (payload: { instanceId: string, shard: ShardId, worldSeed: string | null }) =>
    api.post('app/instance/shards/reset-world-with-seed', payload) as Promise<{ data: ShardResetWorldWithSeedResult }>,
  getShardSnapshots: (instanceId: string, shard: ShardId) => api.get('app/instance/shards/snapshots', {
    params: { instanceId, shard },
  }) as Promise<{ data: ShardSnapshotsDto }>,
  rollbackShard: (payload: ShardRollbackPayload) => api.post('app/instance/shards/rollback', payload) as Promise<{ data: ShardMaintenanceResult }>,
  resetShardWorld: (payload: { instanceId: string, shard: ShardId, confirmName: string }) => api.post('app/instance/shards/reset-world', payload) as Promise<{ data: ShardMaintenanceResult }>,
}
