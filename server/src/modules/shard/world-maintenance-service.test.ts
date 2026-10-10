import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, it, type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import type { DbBackup } from '../../shared/db'
import type { ResolvedLocalDstInstance } from '../../shared/dst/local-dst-instance'
import type { WorldMaintenancePayload } from '../../../../shared/contracts/world-maintenance'
import { beginWorldMaintenance, continueWorldMaintenance, recoverWorldMaintenance, maintenanceDependencies as deps, waitWorldMaintenanceForTest } from './world-maintenance-service'
import { maintenanceRecords, resetMaintenanceStoreForTest, generationSeedGuard } from './world-maintenance-store'
import { resolveShardSaveDir } from '../../infra/game-adapter/dst/shard-layout'
import { listShardSnapshots } from '../../infra/game-adapter/dst/world-maintenance'
import { readWorldSeeds, writeObservedWorldSeed, markObservedWorldSeedStale, readObservedWorldSeed } from '../../infra/game-adapter/dst/panel-config-meta'
const masterSession = '49156F29BABC4C94'
const dirs: string[] = []
const app = Fastify()
const actor = { id: randomUUID(), account: 'maintainer' }
const oldAudit = process.env.BSP_OPERATION_AUDIT_ROOT
function fixture(t: TestContext) {
  const installPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-maintenance-flow-'))
  dirs.push(installPath)
  process.env.BSP_OPERATION_AUDIT_ROOT = path.join(installPath, 'audit')
  const cluster = path.join(installPath, 'klei-storage', 'DoNotStarveTogether', 'Cluster_1')
  fs.mkdirSync(cluster, { recursive: true })
  fs.writeFileSync(path.join(cluster, 'cluster.ini'), '[SHARD]\nshard_enabled = false\n[NETWORK]\noffline_cluster = true\n')
  const save = resolveShardSaveDir(installPath, 'master')
  fs.mkdirSync(path.join(save, 'session', masterSession), { recursive: true })
  fs.writeFileSync(path.join(save, 'shardindex'), `return {session_id="${masterSession}"}`)
  for (const n of [6, 7, 8]) {
    const file = path.join(save, 'session', masterSession, String(n).padStart(10, '0'))
    fs.writeFileSync(file, 'world')
    fs.writeFileSync(`${file}.meta`, `return {clock={cycles=${n === 6 ? 3 : 4}}}`)
  }
  const instance = { id: randomUUID(), name: '测试房间', installPath, status: 'running', resourceConfig: { masterMemoryMb: null, cavesMemoryMb: null, shardReadyWaitSec: 1 } } as ResolvedLocalDstInstance
  let actualSession = masterSession
  let actualSnapshot = 8
  let loadId = randomUUID()
  let saves = 0
  let sends = 0
  t.mock.method(deps, 'getInstance', async () => instance)
  t.mock.method(deps, 'inspect', async () => ({ unitExists: true, snapshot: { running: true } }))
  t.mock.method(deps, 'query', async () => ({ master: { loadId, ready: true, remoteConnected: true, sessionId: actualSession, snapshotId: actualSnapshot, seed: readWorldSeeds(installPath).master ?? '123', shardId: '1' } }))
  t.mock.method(deps, 'acknowledge', async () => 'accepted' as const)
  t.mock.method(deps, 'save', async () => { saves += 1 })
  t.mock.method(deps, 'backup', async () => ({ ok: true, backup: { id: randomUUID() } as DbBackup }))
  t.mock.method(deps, 'syncMods', async () => {})
  t.mock.method(deps, 'send', async (_id: string, command: string) => {
    sends += 1
    loadId = randomUUID()
    const target = /v.snapshot_id==(\d+)/.exec(command)
    if (target) {
      actualSnapshot = Number(target[1])
      for (const row of listShardSnapshots(installPath, 'master')) if (row.snapshotId > actualSnapshot) {
        const file = path.join(save, 'session', masterSession, String(row.snapshotId).padStart(10, '0'))
        fs.rmSync(file); fs.rmSync(`${file}.meta`)
      }
    }
    else {
      actualSession = '1111111111111111'
      fs.writeFileSync(path.join(save, 'shardindex'), `return {session_id="${actualSession}"}`)
    }
    return { ok: true }
  })
  const payload = (action: 'rollback' | 'reset' | 'save' = 'rollback'): WorldMaintenancePayload => action === 'rollback'
    ? { instanceId: instance.id, requestId: randomUUID(), action, sessionId: masterSession, snapshotId: 6, backupBefore: true }
    : action === 'reset' ? { instanceId: instance.id, requestId: randomUUID(), action, confirmName: instance.name, backupBefore: true }
      : { instanceId: instance.id, requestId: randomUUID(), action, backupBefore: true }
  const begin = (p = payload()) => beginWorldMaintenance({ app, instance, actor, payload: p })
  const record = () => maintenanceRecords(installPath).at(-1)!
  return { instance, begin, payload, record, save, counts: () => ({ saves, sends }), setActual: (session: string, snapshot: number) => { actualSession = session; actualSnapshot = snapshot } }
}
async function waitForState(f: ReturnType<typeof fixture>, state: string) {
  for (let i = 0; i < 200; i += 1) {
    if (f.record().state === state) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`未到达状态 ${state}，实际 ${f.record().state}: ${f.record().message}`)
}
afterEach(() => {
  resetMaintenanceStoreForTest()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  if (oldAudit === undefined) delete process.env.BSP_OPERATION_AUDIT_ROOT
  else process.env.BSP_OPERATION_AUDIT_ROOT = oldAudit
})
it('回档前备份不新增保存点，回到确认的编号和天数', async (t) => {
  const f = fixture(t)
  const op = f.begin()
  assert.equal(op.targetWorldDay, 4)
  await waitWorldMaintenanceForTest(op.id)
  assert.equal(f.record().state, 'completed')
  assert.deepEqual(f.counts(), { saves: 0, sends: 1 })
  assert.equal(listShardSnapshots(f.instance.installPath, 'master')[0]?.snapshotId, 6)
})
it('相同请求 ID 不会重复保存或重复回档，参数变化拒绝复用', async (t) => {
  const f = fixture(t)
  const payload = f.payload('save')
  const first = f.begin(payload)
  assert.equal(f.begin(payload).id, first.id)
  await waitWorldMaintenanceForTest(first.id)
  assert.equal(f.begin(payload).id, first.id)
  assert.equal(f.counts().saves, 1)
  assert.throws(() => f.begin({ ...payload, backupBefore: false }), /请求 ID/)
})
it('列表目标已被淘汰时中止，不使用 c_rollback 的补偿规则猜测目标', (t) => {
  const f = fixture(t)
  const file = path.join(f.save, 'session', masterSession, '0000000006')
  fs.rmSync(file)
  assert.throws(() => f.begin(), /列表已过期/)
  assert.equal(f.counts().sends, 0)
})
it('备份失败暂停；再次确认跳过备份后仍执行原目标', async (t) => {
  const f = fixture(t)
  t.mock.method(deps, 'backup', async () => ({ ok: false, message: '磁盘空间不足' }))
  const op = f.begin()
  await waitForState(f, 'awaiting_confirmation')
  assert.equal(f.counts().sends, 0)
  continueWorldMaintenance(f.instance, f.record(), true)
  await waitWorldMaintenanceForTest(op.id)
  assert.equal(f.record().state, 'completed')
  assert.equal(f.record().backupSkipped, true)
  assert.equal(f.counts().saves, 0)
})
it('跳过备份不能绕过目标消失；取消不发送危险命令', async (t) => {
  const f = fixture(t)
  t.mock.method(deps, 'backup', async () => ({ ok: false, message: '归档失败' }))
  const op = f.begin()
  await waitForState(f, 'awaiting_confirmation')
  fs.rmSync(path.join(f.save, 'session', masterSession, '0000000006'))
  continueWorldMaintenance(f.instance, f.record(), true)
  await waitWorldMaintenanceForTest(op.id)
  assert.equal(f.record().state, 'failed')
  assert.equal(f.counts().sends, 0)
})
it('确认过期后拒绝继续，用户可取消等待中的操作', async (t) => {
  const f = fixture(t)
  t.mock.method(deps, 'backup', async () => ({ ok: false, message: '归档失败' }))
  const op = f.begin()
  await waitForState(f, 'awaiting_confirmation')
  f.record().confirmationExpiresAt = new Date(Date.now() - 1).toISOString()
  assert.throws(() => continueWorldMaintenance(f.instance, f.record(), true), /失效/)
  f.record().confirmationExpiresAt = new Date(Date.now() + 1000).toISOString()
  continueWorldMaintenance(f.instance, f.record(), false)
  await waitWorldMaintenanceForTest(op.id)
  assert.equal(f.record().state, 'cancelled')
  assert.equal(f.counts().sends, 0)
})
it('重置前保存超时不会创建备份或执行生成命令', async (t) => {
  const f = fixture(t)
  t.mock.method(deps, 'save', async () => { throw new Error('洞穴保存超时') })
  const op = f.begin(f.payload('reset'))
  await waitWorldMaintenanceForTest(op.id)
  assert.equal(f.record().state, 'failed')
  assert.match(f.record().message!, /保存超时/)
  assert.equal(f.counts().sends, 0)
})
it('生成命令结果不确定时保留检查点，不自动重发或还原种子', async (t) => {
  const f = fixture(t)
  t.mock.method(deps, 'send', async () => ({ ok: false, message: '连接中断，结果未知' }))
  const op = f.begin({ instanceId: f.instance.id, requestId: randomUUID(), action: 'regenerate', shard: 'master', worldSeed: '42', confirmName: f.instance.name, backupBefore: true })
  await waitWorldMaintenanceForTest(op.id)
  assert.equal(f.record().state, 'unknown')
  assert.equal(readWorldSeeds(f.instance.installPath).master, '42')
  recoverWorldMaintenance(app, f.instance)
  assert.throws(() => f.begin(f.payload('reset')), /结果未确认/)
})
it('命令发送前配置同步失败，恢复本次种子修改', async (t) => {
  const f = fixture(t)
  let count = 0
  t.mock.method(deps, 'syncMods', async () => { if (++count === 1) throw new Error('配置不可写') })
  const op = f.begin({ instanceId: f.instance.id, requestId: randomUUID(), action: 'regenerate', shard: 'master', worldSeed: '42', confirmName: f.instance.name, backupBefore: true })
  await waitWorldMaintenanceForTest(op.id)
  assert.equal(f.record().state, 'failed')
  assert.equal(readWorldSeeds(f.instance.installPath).master, undefined)
  assert.equal(f.counts().sends, 0)
})
it('面板重启恢复检查点时只核验，不再次发送命令', async (t) => {
  const f = fixture(t)
  const op = f.begin()
  await waitWorldMaintenanceForTest(op.id)
  const record = f.record()
  record.state = 'running'; record.phase = 'executing'; record.deadlineAt = new Date(Date.now() + 1000).toISOString()
  fs.writeFileSync(path.join(f.instance.installPath, '.bsp-world-maintenance.json'), JSON.stringify([record]))
  resetMaintenanceStoreForTest()
  const before = f.counts()
  recoverWorldMaintenance(app, f.instance)
  await waitWorldMaintenanceForTest(op.id)
  assert.equal(f.record().state, 'completed')
  assert.deepEqual(f.counts(), before)
})
it('运行状态未知不能跳过校验，也不能删除磁盘存档', async (t) => {
  const f = fixture(t)
  t.mock.method(deps, 'inspect', async () => ({ unitExists: true, snapshot: null }))
  const op = f.begin(f.payload('reset'))
  await waitWorldMaintenanceForTest(op.id)
  assert.equal(f.record().state, 'failed')
  assert.equal(listShardSnapshots(f.instance.installPath, 'master').length, 3)
  assert.equal(f.counts().sends, 0)
})

it('归档异常也暂停等待确认，不继续危险操作', async (t) => {
  const f = fixture(t)
  t.mock.method(deps, 'backup', async () => { throw new Error('归档进程异常退出') })
  const op = f.begin()
  await waitForState(f, 'awaiting_confirmation')
  assert.equal(f.counts().sends, 0)
  continueWorldMaintenance(f.instance, f.record(), false)
  await waitWorldMaintenanceForTest(op.id)
  assert.equal(f.record().state, 'cancelled')
})
it('游戏拒绝保存中的回档时不重载，不将未执行结果记作不确定', async (t) => {
  const f = fixture(t)
  t.mock.method(deps, 'acknowledge', async () => 'rejected' as const)
  const op = f.begin()
  await waitWorldMaintenanceForTest(op.id)
  assert.equal(f.record().state, 'failed')
  assert.equal(f.record().commandAttempted, false)
})

function enableCaves(f: ReturnType<typeof fixture>) {
  const cluster = path.dirname(path.dirname(f.save))
  fs.writeFileSync(path.join(cluster, 'cluster.ini'), '[SHARD]\nshard_enabled = true\n[NETWORK]\noffline_cluster = true\n')
  const caves = resolveShardSaveDir(f.instance.installPath, 'caves')
  fs.mkdirSync(path.dirname(caves), { recursive: true })
  fs.writeFileSync(path.join(path.dirname(caves), 'server.ini'), '[SHARD]\nis_master = false\n')
  fs.cpSync(f.save, caves, { recursive: true })
  const session = '66BD68AFE6767E46'
  fs.renameSync(path.join(caves, 'session', masterSession), path.join(caves, 'session', session))
  fs.writeFileSync(path.join(caves, 'shardindex'), `return {session_id="${session}"}`)
  return session
}
it('洞穴明确拒绝目标时不再发送地上回档请求', async (t) => {
  const f = fixture(t); const cavesSession = enableCaves(f)
  const probe = { loadId: randomUUID(), ready: true, remoteConnected: true, snapshotId: 8, seed: '123', shardId: '1' }
  t.mock.method(deps, 'query', async () => ({ master: { ...probe, sessionId: masterSession }, caves: { ...probe, sessionId: cavesSession } }))
  const sent: string[] = []
  t.mock.method(deps, 'send', async (_id: string, _command: string, shard: 'master' | 'caves') => { sent.push(shard); return { ok: true } })
  t.mock.method(deps, 'acknowledge', async () => 'rejected' as const)
  const op = f.begin({ ...f.payload(), cavesSessionId: cavesSession } as WorldMaintenancePayload)
  await waitWorldMaintenanceForTest(op.id)
  assert.deepEqual(sent, ['caves'])
  assert.equal(f.record().state, 'failed')
  assert.equal(f.record().commandAttempted, false)
})
it('洞穴已执行而地上拒绝时记为结果不确定，禁止自动重复回档', async (t) => {
  const f = fixture(t); const cavesSession = enableCaves(f)
  const probe = { loadId: randomUUID(), ready: true, remoteConnected: true, snapshotId: 8, seed: '123', shardId: '1' }
  t.mock.method(deps, 'query', async () => ({ master: { ...probe, sessionId: masterSession }, caves: { ...probe, sessionId: cavesSession } }))
  const sent: string[] = []
  t.mock.method(deps, 'send', async (_id: string, _command: string, shard: 'master' | 'caves') => { sent.push(shard); return { ok: true } })
  t.mock.method(deps, 'acknowledge', async (_id: string, shard: 'master' | 'caves') => shard === 'caves' ? 'accepted' as const : 'rejected' as const)
  const op = f.begin({ ...f.payload(), cavesSessionId: cavesSession } as WorldMaintenancePayload)
  await waitWorldMaintenanceForTest(op.id)
  assert.deepEqual(sent, ['caves', 'master'])
  assert.equal(f.record().state, 'unknown')
  assert.equal(f.record().commandAttempted, true)
  assert.throws(() => f.begin(f.payload('reset')), /结果未确认/)
})

it('停止后生成遇到明确启动失败时结束 loading，不自动再次清理或启动', async (t) => {
  const f = fixture(t); f.instance.status = 'stopped'
  t.mock.method(deps, 'inspect', async () => ({ unitExists: false, snapshot: null }))
  let starts = 0
  t.mock.method(deps, 'start', async () => { starts += 1; throw new Error('启动失败：端口已占用') })
  const op = f.begin(f.payload('reset'))
  await waitWorldMaintenanceForTest(op.id)
  assert.equal(f.record().state, 'failed')
  assert.match(f.record().message!, /启动失败/)
  assert.equal(starts, 1)
  recoverWorldMaintenance(app, f.instance)
  assert.equal(starts, 1)
})

it('无活动任务的旧 stale 标记不阻止真实种子回读，超时生成不无限提示正在生成', async (t) => {
  const f = fixture(t)
  writeObservedWorldSeed(f.instance.installPath, 'master', { seed: '123', sessionId: masterSession, at: new Date().toISOString() })
  markObservedWorldSeedStale(f.instance.installPath, 'master')
  assert.equal(readObservedWorldSeed(f.instance.installPath, 'master')?.stale, true)
  assert.equal(generationSeedGuard(f.instance.installPath, 'master', masterSession), null)
  t.mock.method(deps, 'send', async () => ({ ok: false, message: '发送结果未知' }))
  const op = f.begin(f.payload('reset'))
  await waitWorldMaintenanceForTest(op.id)
  assert.match(generationSeedGuard(f.instance.installPath, 'master', masterSession)!, /未确认生成完成/)
  assert.equal(generationSeedGuard(f.instance.installPath, 'master', '1111111111111111'), null)
})
it('损坏的维护检查点不能当成没有任务并重新执行', (t) => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.instance.installPath, '.bsp-world-maintenance.json'), 'broken json')
  resetMaintenanceStoreForTest()
  assert.throws(() => f.begin(f.payload('reset')))
  assert.equal(f.counts().sends, 0)
})

it('普通重置先同步已保存种子 Mod；同步失败不发送生成命令', async (t) => {
  const f = fixture(t)
  t.mock.method(deps, 'syncMods', async () => { throw new Error('种子 Mod 配置落位失败') })
  const op = f.begin(f.payload('reset'))
  await waitWorldMaintenanceForTest(op.id)
  assert.equal(f.record().state, 'failed')
  assert.match(f.record().message!, /配置落位失败/)
  assert.equal(f.counts().sends, 0)
})
