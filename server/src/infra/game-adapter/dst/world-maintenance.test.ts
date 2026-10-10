import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, it } from 'node:test'
import { buildResetWorldCommand, listShardSnapshots, readMaxSnapshots, validateRollbackSteps, readShardSessionId } from './world-maintenance'
import { resolveClusterPaths } from './cluster-service'
import { resolveShardSaveDir } from './shard-layout'
const dirs: string[] = []
const session = '49156F29BABC4C94'
const caveSession = '66BD68AFE6767E46'
function fixture(caves = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-world-snapshots-'))
  dirs.push(dir)
  const { clusterRoot, clusterIniPath } = resolveClusterPaths(dir)
  fs.mkdirSync(clusterRoot, { recursive: true })
  fs.writeFileSync(clusterIniPath, `[SHARD]\nshard_enabled = ${caves}\n[MISC]\nmax_snapshots = 6\n`)
  for (const shard of ['master', ...(caves ? ['caves'] : [])] as const) {
    const save = resolveShardSaveDir(dir, shard as 'master' | 'caves')
    fs.mkdirSync(save, { recursive: true })
    fs.writeFileSync(path.join(save, 'shardindex'), `return {session_id="${shard === 'master' ? session : caveSession}", world={}}\0`)
  }
  return dir
}
function snapshot(dir: string, n: number, cycles: number | null, shard: 'master' | 'caves' = 'master', sid = shard === 'master' ? session : caveSession) {
  const root = path.join(resolveShardSaveDir(dir, shard), 'session', sid)
  fs.mkdirSync(root, { recursive: true })
  const file = path.join(root, String(n).padStart(10, '0'))
  fs.writeFileSync(file, 'world session bytes')
  fs.writeFileSync(`${file}.meta`, cycles === null ? 'return ???' : `return {clock={cycles=${cycles},time=0.5},seasons={season="autumn"}}\0`)
  fs.utimesSync(file, new Date('2026-10-10T01:00:00Z'), new Date('2026-10-10T01:00:00Z'))
  return file
}
afterEach(() => dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })))
it('使用生成命令区分整房间与单分片，c_reset 仅用于重载', () => {
  assert.equal(buildResetWorldCommand('cluster'), 'c_regenerateworld()')
  assert.equal(buildResetWorldCommand('shard'), 'c_regenerateshard()')
})
it('一个会话包含多个编号快照，按编号排序而不是目录时间', () => {
  const dir = fixture()
  snapshot(dir, 6, 3); snapshot(dir, 8, 4); snapshot(dir, 7, 4)
  const rows = listShardSnapshots(dir, 'master')
  assert.deepEqual(rows.map(r => [r.snapshotId, r.worldDay, r.rollbackSteps]), [[8, 5, 1], [7, 5, 2], [6, 4, 3]])
  assert.equal(rows[0]!.sessionId, session)
  assert.equal(rows[0]!.savedAt, '2026-10-10T01:00:00.000Z')
})
it('排除旧会话、玩家子目录、编号目录、无世界文件和缺失元数据', () => {
  const dir = fixture()
  const file = snapshot(dir, 6, 3)
  snapshot(dir, 1, 0, 'master', '1111111111111111')
  const root = path.dirname(file)
  fs.mkdirSync(path.join(root, 'player', '0000000008'), { recursive: true })
  fs.writeFileSync(path.join(root, '0000000009.meta'), 'return {clock={cycles=0}}')
  fs.writeFileSync(path.join(root, '0000000010'), 'incomplete')
  fs.mkdirSync(path.join(root, '0000000011'))
  assert.deepEqual(listShardSnapshots(dir, 'master').map(r => r.snapshotId), [6])
})
it('损坏元数据不伪造第一天，静态解析不执行 Lua', () => {
  const dir = fixture()
  snapshot(dir, 6, null)
  const malicious = snapshot(dir, 7, null)
  fs.writeFileSync(`${malicious}.meta`, 'return {clock={cycles=os.execute("throw")}}')
  assert.deepEqual(listShardSnapshots(dir, 'master').map(r => r.worldDay), [null, null])
})
it('没有可信当前会话时不能猜测可回档数量', () => {
  const dir = fixture()
  snapshot(dir, 6, 3)
  fs.writeFileSync(path.join(resolveShardSaveDir(dir, 'master'), 'shardindex'), 'damaged')
  assert.equal(readShardSessionId(dir, 'master'), null)
  assert.deepEqual(listShardSnapshots(dir, 'master'), [])
})
it('整房间回档排除洞穴缺失的对应快照，步数只按完整目标计算', () => {
  const dir = fixture(true)
  snapshot(dir, 6, 3); snapshot(dir, 7, 4); snapshot(dir, 8, 4)
  snapshot(dir, 6, 3, 'caves'); snapshot(dir, 8, 4, 'caves')
  assert.deepEqual(listShardSnapshots(dir, 'master').map(r => [r.snapshotId, r.cavesAvailable, r.rollbackSteps]), [[8, true, 1], [7, false, null], [6, true, 2]])
  assert.ok(listShardSnapshots(dir, 'caves').every(r => r.rollbackSteps === null))
})
it('启用洞穴但无法识别洞穴会话时，不降级为单世界回档', () => {
  const dir = fixture(true)
  snapshot(dir, 6, 3)
  fs.rmSync(path.join(resolveShardSaveDir(dir, 'caves'), 'shardindex'))
  assert.equal(listShardSnapshots(dir, 'master')[0]?.rollbackSteps, null)
})
it('保留设置只是配置说明，不能代替可恢复数量', () => {
  const dir = fixture()
  assert.equal(readMaxSnapshots(dir), 6)
  assert.deepEqual(validateRollbackSteps(1, 1), [])
  assert.match(validateRollbackSteps(3, 1)[0]!, /只有 1 个/)
  assert.ok(validateRollbackSteps(0, 6).length)
  assert.ok(validateRollbackSteps(1.5, 6).length)
  assert.ok(validateRollbackSteps(100, 200).length)
})
