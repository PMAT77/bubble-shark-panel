import fs from 'node:fs'
import path from 'node:path'
import type { ShardId, ShardSnapshotDto } from '../../../../../shared/contracts/shard'
import { SHARD_ROLLBACK_STEPS_LIMIT } from '../../../../../shared/contracts/shard'
import { parseClusterIni } from './cluster-ini'
import { resolveClusterPaths } from './cluster-service'
import { resolveShardSaveDir } from './shard-layout'
import { readClusterShardEnabledFromInstall } from './shard-service'
import { isLuaTable, MAX_LUA_PARSE_LENGTH, parseLuaTableLiteral } from './lua-literal'

export type DstShardSnapshot = ShardSnapshotDto

function readTable(file: string) {
  try {
    if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > MAX_LUA_PARSE_LENGTH) return null
    return parseLuaTableLiteral(fs.readFileSync(file, 'utf8').replace(/^\s*return\s*/, '').replace(/\0+$/, ''))
  }
  catch { return null }
}

export function readShardSessionId(installPath: string, shard: ShardId): string | null {
  const value = readTable(path.join(resolveShardSaveDir(installPath, shard), 'shardindex'))?.entries.get('session_id')
  return typeof value === 'string' && /^[A-Fa-f0-9]{16}$/.test(value) ? value : null
}

export function configuredWorldShards(installPath: string): ShardId[] {
  return readClusterShardEnabledFromInstall(installPath) ? ['master', 'caves'] : ['master']
}

function readSnapshots(installPath: string, shard: ShardId): DstShardSnapshot[] {
  const sessionId = readShardSessionId(installPath, shard)
  if (!sessionId) return []
  const dir = path.join(resolveShardSaveDir(installPath, shard), 'session', sessionId)
  try {
    // 世界文件在会话根目录；玩家编号文件位于子目录，不能递归计入。
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isFile() || !/^\d{10}$/.test(entry.name) || Number(entry.name) < 1) return []
      const file = path.join(dir, entry.name)
      const metaPath = `${file}.meta`
      if (!fs.existsSync(metaPath) || !fs.lstatSync(metaPath).isFile() || fs.statSync(file).size === 0) return []
      const clock = readTable(metaPath)?.entries.get('clock')
      const cycles = isLuaTable(clock) ? clock.entries.get('cycles') : null
      const worldDay = typeof cycles === 'number' && Number.isSafeInteger(cycles) && cycles >= 0 ? cycles + 1 : null
      return [{ id: `${sessionId}:${entry.name}`, sessionId, snapshotId: Number(entry.name), worldDay,
        savedAt: fs.statSync(file).mtime.toISOString(), cavesAvailable: null, cavesSessionId: null, rollbackSteps: null, unavailableReason: null }]
    }).sort((a, b) => b.snapshotId - a.snapshotId)
  }
  catch { return [] }
}

export function listShardSnapshots(installPath: string, shard: ShardId): DstShardSnapshot[] {
  const snapshots = readSnapshots(installPath, shard)
  if (shard === 'caves') return snapshots.map(item => ({ ...item, unavailableReason: '整房间回档以地上世界的存档点为准' }))
  const cavesConfigured = configuredWorldShards(installPath).includes('caves')
  const cavesSessionId = cavesConfigured ? readShardSessionId(installPath, 'caves') : null
  const cavesIds = new Set(cavesConfigured ? readSnapshots(installPath, 'caves').map(item => item.snapshotId) : [])
  let steps = 0
  return snapshots.map((item) => {
    const available = !cavesConfigured || cavesIds.has(item.snapshotId)
    return { ...item, cavesAvailable: cavesConfigured ? available : null, cavesSessionId,
      rollbackSteps: available && steps < SHARD_ROLLBACK_STEPS_LIMIT ? ++steps : null,
      unavailableReason: available ? null : '缺少洞穴对应的完整快照，无法整房间回档' }
  })
}

export function readMaxSnapshots(installPath: string): number {
  const { clusterIniPath } = resolveClusterPaths(installPath)
  return fs.existsSync(clusterIniPath) ? parseClusterIni(fs.readFileSync(clusterIniPath, 'utf8')).fields.maxSnapshots : 6
}

/** 仅供诊断原生命令；业务回档必须使用已锁定的会话与编号。 */
export function buildRollbackCommand(steps: number): string { return `c_rollback(${steps})` }
export function buildResetWorldCommand(scope: 'cluster' | 'shard' = 'shard'): string {
  return scope === 'cluster' ? 'c_regenerateworld()' : 'c_regenerateshard()'
}

export { buildSnapshotRollbackCommand } from './maintenance-probe'

export function validateRollbackSteps(steps: number, available: number): string[] {
  if (!Number.isInteger(steps) || steps < 1 || steps > SHARD_ROLLBACK_STEPS_LIMIT) return [`回档步数须为 1–${SHARD_ROLLBACK_STEPS_LIMIT} 的整数`]
  return steps > available ? [`当前只有 ${available} 个可整房间回档的存档点，请刷新后重新选择`] : []
}

export function worldIsOnline(installPath: string): boolean {
  const { clusterIniPath } = resolveClusterPaths(installPath)
  return parseClusterIni(fs.readFileSync(clusterIniPath, 'utf8')).fields.networkMode !== 'offline'
}

/** 归档前后比较源文件状态，检测自动保存或快照淘汰与打包的冲突。 */
export function worldSaveFingerprint(installPath: string): string {
  const rows: string[] = []
  const visit = (dir: string, prefix: string) => {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(file, `${prefix}/${entry.name}`)
      else if (entry.isFile()) { const stat = fs.statSync(file); rows.push(`${prefix}/${entry.name}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`) }
    }
  }
  for (const shard of configuredWorldShards(installPath)) visit(resolveShardSaveDir(installPath, shard), shard)
  return rows.join('\n')
}
