import { randomUUID } from 'node:crypto'
import type { ShardId } from '../../../../shared/contracts/shard'
import { buildMaintenanceProbe, buildSaveObserver, parseMaintenanceProbe, type MaintenanceWorldProbe, type WorldProbeByShard } from '../../infra/game-adapter/dst/maintenance-probe'
import { configuredWorldShards, listShardSnapshots, readShardSessionId, worldSaveFingerprint } from '../../infra/game-adapter/dst/world-maintenance'
import { instanceConsoleLogStore } from '../../shared/instance-runtime/console-log-store'
import { sendInstanceContainerCommand } from '../instance/container-lifecycle'

export const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
export const consoleCursor = (id: string) => instanceConsoleLogStore.listLogs(id).at(-1)?.id ?? 0
export function outputLines(id: string, shard: ShardId, after: number): string[] {
  return instanceConsoleLogStore.listLogs(id, after, 2000).filter(line => line.stream === 'stdout' && line.shard === shard).map(line => line.text.replace(/^\[\d+:\d+:\d+\]:\s*/, '').trim())
}
export async function waitMaintenanceAcknowledgement(instanceId: string, shard: ShardId, token: string, after: number): Promise<'accepted' | 'rejected' | 'unknown'> {
  const until = Date.now() + 3000
  while (Date.now() < until) {
    for (const line of outputLines(instanceId, shard, after)) {
      for (const state of ['accepted', 'rejected', 'unknown'] as const) if (line === `BSPMAINT:${token}:${state}`) return state
    }
    await pause(100)
  }
  return 'unknown'
}
export async function queryMaintenanceWorld(instanceId: string, shard: ShardId, remoteShardId?: string): Promise<MaintenanceWorldProbe | null> {
  const token = randomUUID()
  const after = consoleCursor(instanceId)
  const result = await sendInstanceContainerCommand(instanceId, buildMaintenanceProbe(token, remoteShardId), shard)
  if (!result.ok) return null
  const until = Date.now() + 1500
  while (Date.now() < until) {
    for (const line of outputLines(instanceId, shard, after)) {
      const probe = parseMaintenanceProbe(line, token)
      if (probe) return probe
    }
    await pause(100)
  }
  return null
}
export async function queryRoomWorlds(instanceId: string, shards: ShardId[]): Promise<WorldProbeByShard> {
  const master = await queryMaintenanceWorld(instanceId, 'master')
  const caves = shards.includes('caves') && master?.shardId ? await queryMaintenanceWorld(instanceId, 'caves', master.shardId) : null
  return { ...(master ? { master } : {}), ...(caves ? { caves } : {}) }
}

export async function saveRoomConfirmed(instanceId: string, installPath: string, timeoutSec: number): Promise<void> {
  const shards = configuredWorldShards(installPath)
  const initial = await queryRoomWorlds(instanceId, shards)
  if (shards.some(shard => !initial[shard]?.ready || !initial[shard]?.remoteConnected)) throw new Error('保存需要所有已配置分片加载完成并连接')
  const before = worldSaveFingerprint(installPath)
  const token = randomUUID()
  const after = consoleCursor(instanceId)
  for (const shard of shards) {
    const result = await sendInstanceContainerCommand(instanceId, buildSaveObserver(token, timeoutSec), shard)
    if (!result.ok) throw new Error(`${shard === 'master' ? '地上' : '洞穴'}保存观察指令发送失败`)
    const until = Date.now() + 2000
    while (!outputLines(instanceId, shard, after).includes(`BSPSAVEARM:${token}`)) {
      if (Date.now() > until) throw new Error('没有确认游戏已准备保存，请稍后重试')
      await pause(100)
    }
  }
  const saved = await sendInstanceContainerCommand(instanceId, 'c_save()', 'master')
  if (!saved.ok) throw new Error(saved.message ?? '保存指令发送失败，保存结果未确认')
  const deadline = Date.now() + timeoutSec * 1000
  while (Date.now() < deadline) {
    const done = shards.every((shard) => {
      const marker = outputLines(instanceId, shard, after).find(line => line.startsWith(`BSPSAVED:${token}|`))
      const [, session, snapshot] = marker?.split('|') ?? []
      return session === initial[shard]?.sessionId && readShardSessionId(installPath, shard) === session
        && Number.isInteger(Number(snapshot)) && listShardSnapshots(installPath, shard).some(item => item.snapshotId === Number(snapshot))
    })
    if (done && worldSaveFingerprint(installPath) !== before) return
    await pause(250)
  }
  throw new Error('保存超时：未确认所有分片保存完成及存档落盘，已停止后续操作')
}
