import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { before, after, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import Fastify from 'fastify'
import { ErrorCode } from '../../../../shared/constants/error-code'
import { initDatabase, closeDatabase, createGameInstance, findUserByAccount, addUserInstanceGrants } from '../../shared/db'
import { ensureDb, nowIso } from '../../shared/db/connection'
import { userPermissions } from '../../shared/db/schema'
import { registerAuthModule } from '../auth'
import { registerWorldMaintenanceRoutes } from './world-maintenance-routes'
import { maintenanceDependencies as deps, waitWorldMaintenanceForTest } from './world-maintenance-service'
import { resolveShardSaveDir } from '../../infra/game-adapter/dst/shard-layout'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-maint-auth-'))
const app = Fastify()
let id = ''; let userId = ''; let token = ''; let installPath = ''
const oldUnit = process.env.BSP_UNIT_TEST
const oldAudit = process.env.BSP_OPERATION_AUDIT_ROOT
async function permissions(keys: string[]) {
  const { drizzleDb } = ensureDb()
  await drizzleDb.delete(userPermissions).where(eq(userPermissions.userId, userId))
  if (keys.length) await drizzleDb.insert(userPermissions).values(keys.map(permission => ({ userId, permission, createdAt: nowIso() })))
}
before(async () => {
  process.env.BSP_UNIT_TEST = '1'; process.env.BSP_OPERATION_AUDIT_ROOT = path.join(dir, 'audit')
  await initDatabase(path.join(dir, 'test.sqlite'), path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle'), { adminUsername: 'maint-user', adminPassword: '123456', seedDevelopmentUsers: false })
  installPath = path.join(dir, 'game'); fs.mkdirSync(installPath)
  id = (await createGameInstance({ nodeId: 'local-node', name: '维护测试', gameCode: '343050', status: 'stopped', installPath })).id
  userId = (await findUserByAccount('maint-user'))!.id
  await addUserInstanceGrants(userId, [id], null)
  registerAuthModule(app); registerWorldMaintenanceRoutes(app); await app.ready()
  token = JSON.parse((await app.inject({ method: 'POST', url: '/app/account/login', payload: { account: 'maint-user', password: '123456' } })).body).data.token
})
after(async () => {
  await app.close(); closeDatabase(); fs.rmSync(dir, { recursive: true, force: true })
  if (oldUnit === undefined) delete process.env.BSP_UNIT_TEST; else process.env.BSP_UNIT_TEST = oldUnit
  if (oldAudit === undefined) delete process.env.BSP_OPERATION_AUDIT_ROOT; else process.env.BSP_OPERATION_AUDIT_ROOT = oldAudit
})
it('world:reset 账号无需控制台读取或生命周期权限，状态只返回契约字段', async (t) => {
  await permissions(['world:reset'])
  t.mock.method(deps, 'inspect', async () => ({ unitExists: false, snapshot: null }))
  t.mock.method(deps, 'backup', async () => ({ ok: false, message: '测试归档失败' }))
  const headers = { token }
  const response = JSON.parse((await app.inject({ method: 'POST', url: '/app/instance/world-maintenance', headers, payload: { instanceId: id, requestId: randomUUID(), action: 'reset', confirmName: '维护测试' } })).body)
  assert.equal(response.error, '')
  const opId = response.data.id
  for (let i = 0; i < 100; i += 1) {
    const status = JSON.parse((await app.inject({ method: 'GET', url: `/app/instance/world-maintenance?instanceId=${id}&operationId=${opId}`, headers })).body)
    assert.equal(status.error, '')
    assert.equal('actorId' in status.data, false); assert.equal('payload' in status.data, false)
    if (status.data.state === 'awaiting_confirmation') break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const cancel = JSON.parse((await app.inject({ method: 'POST', url: '/app/instance/world-maintenance/continue', headers, payload: { instanceId: id, operationId: opId, withoutBackup: false } })).body)
  assert.equal(cancel.error, '')
  await waitWorldMaintenanceForTest(opId)
})
it('只给 console:command 不能回档或生成，保存权限单独校验', async () => {
  await permissions(['console:command'])
  const reset = JSON.parse((await app.inject({ method: 'POST', url: '/app/instance/world-maintenance', headers: { token }, payload: { instanceId: id, requestId: randomUUID(), action: 'reset', confirmName: '维护测试' } })).body)
  assert.equal(reset.code, ErrorCode.FORBIDDEN)
  await permissions(['world:reset'])
  const save = JSON.parse((await app.inject({ method: 'POST', url: '/app/instance/world-maintenance', headers: { token }, payload: { instanceId: id, requestId: randomUUID(), action: 'save' } })).body)
  assert.equal(save.code, ErrorCode.FORBIDDEN)
})
it('停止状态清理所选分片后复用内部启动用例，不要求额外生命周期权限', async (t) => {
  await permissions(['world:reset'])
  const save = resolveShardSaveDir(installPath, 'master'); fs.mkdirSync(save, { recursive: true }); fs.writeFileSync(path.join(save, 'old-world'), 'old')
  t.mock.method(deps, 'inspect', async () => ({ unitExists: false, snapshot: null }))
  t.mock.method(deps, 'syncMods', async () => {})
  let started = false
  t.mock.method(deps, 'start', async () => {
    assert.equal(fs.existsSync(path.join(save, 'old-world')), false)
    fs.mkdirSync(save, { recursive: true }); fs.writeFileSync(path.join(save, 'shardindex'), 'return {session_id="1111111111111111"}')
    started = true
  })
  t.mock.method(deps, 'query', async () => ({ master: { ready: true, remoteConnected: true, sessionId: '1111111111111111', snapshotId: 1, seed: '42', shardId: '1' } }))
  const response = JSON.parse((await app.inject({ method: 'POST', url: '/app/instance/world-maintenance', headers: { token }, payload: { instanceId: id, requestId: randomUUID(), action: 'regenerate', shard: 'master', worldSeed: '42', confirmName: '维护测试', backupBefore: false } })).body)
  assert.equal(response.error, '')
  await waitWorldMaintenanceForTest(response.data.id)
  assert.equal(started, true)
  const status = JSON.parse((await app.inject({ method: 'GET', url: `/app/instance/world-maintenance?instanceId=${id}&operationId=${response.data.id}`, headers: { token } })).body)
  assert.equal(status.data.state, 'completed')
})
