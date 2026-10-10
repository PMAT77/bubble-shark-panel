import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, it, mock } from 'node:test'
import { eq } from 'drizzle-orm'
import Fastify from 'fastify'
import { ErrorCode } from '../../../../shared/constants/error-code'
import { instanceResourcesPayloadSchema, type InstanceStartupSnapshot } from '../../../../shared/contracts/instance-resources'
import { getContainerRuntime, type ContainerRuntime } from '../../infra/container'
import { addUserInstanceGrants, closeDatabase, createGameInstance, findUserByAccount, getGameInstanceById, initDatabase, updateGameInstanceRuntime } from '../../shared/db'
import { ensureDb, nowIso } from '../../shared/db/connection'
import { userPermissions } from '../../shared/db/schema'
import { registerAuthModule } from '../auth'
import { getInstanceResourceSettings, registerInstanceResourceRoutes } from './resource-settings'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-resource-settings-'))
const databasePath = path.join(dir, 'test.sqlite')
const migrations = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle')
const app = Fastify()
let id = ''
let hiddenId = ''
let userId = ''
let token = ''
const databaseOptions = { adminUsername: 'resource-user', adminPassword: '123456', seedDevelopmentUsers: false }

async function setPermissions(permissions: string[]) {
  const { drizzleDb } = ensureDb()
  await drizzleDb.delete(userPermissions).where(eq(userPermissions.userId, userId))
  if (permissions.length) await drizzleDb.insert(userPermissions).values(permissions.map(permission => ({ userId, permission, createdAt: nowIso() })))
}

before(async () => {
  mock.method(getContainerRuntime() as ContainerRuntime & Required<Pick<ContainerRuntime, 'hostResources'>>, 'hostResources', async () => null)
  await initDatabase(databasePath, migrations, databaseOptions)
  id = (await createGameInstance({ nodeId: 'local-node', name: 'resources', gameCode: '343050', status: 'stopped' })).id
  hiddenId = (await createGameInstance({ nodeId: 'local-node', name: 'hidden', gameCode: '343050', status: 'stopped' })).id
  const user = await findUserByAccount('resource-user')
  assert.ok(user)
  userId = user.id
  await addUserInstanceGrants(userId, [id], null)
  registerAuthModule(app)
  registerInstanceResourceRoutes(app)
  await app.ready()
  const login = await app.inject({ method: 'POST', url: '/app/account/login', payload: { account: 'resource-user', password: '123456' } })
  token = JSON.parse(login.body).data.token
})
after(async () => { await app.close(); mock.restoreAll(); closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }) })

it('read-only diagnostics require read permission and an instance grant; resource writes are retired', async (t) => {
  t.mock.method(getContainerRuntime(), 'findByName', async () => undefined)
  await setPermissions(['instance:read'])
  const read = await app.inject({ method: 'GET', url: `/app/instance/resources?id=${id}`, headers: { token } })
  const body = JSON.parse(read.body)
  assert.equal(body.error, '')
  assert.equal(instanceResourcesPayloadSchema.safeParse(body.data).success, true)
  assert.deepEqual(body.data.config, { masterMemoryMb: null, cavesMemoryMb: null, shardReadyWaitSec: null })
  assert.equal(body.data.recommendation.masterMemoryMb, 2560)
  const config = { masterMemoryMb: 3072, cavesMemoryMb: 0, shardReadyWaitSec: 420 }
  await updateGameInstanceRuntime(id, { resourceConfig: config })
  await setPermissions(['instance:read', 'instance:lifecycle'])
  const hidden = await app.inject({ method: 'GET', url: `/app/instance/resources?id=${hiddenId}`, headers: { token } })
  assert.equal(JSON.parse(hidden.body).code, ErrorCode.FORBIDDEN)
  const saved = await app.inject({ method: 'POST', url: '/app/instance/resources', headers: { token }, payload: { id, config } })
  assert.equal(saved.statusCode, 404)
  assert.deepEqual((await getGameInstanceById(id))?.resourceConfig, config)
  const diagnostics = JSON.parse((await app.inject({ method: 'GET', url: `/app/instance/resources?id=${id}`, headers: { token } })).body).data
  assert.deepEqual(diagnostics.config, { masterMemoryMb: null, cavesMemoryMb: null, shardReadyWaitSec: null })
  assert.notEqual(diagnostics.effective.shardReadyWaitSec, 420)
})

it('stores startup reports across reopen and atomically ignores obsolete task writes', async () => {
  const at = new Date().toISOString()
  const report: InstanceStartupSnapshot = {
    taskId: 'old-task', status: 'failed', phase: 'failed', startedAt: at, phaseStartedAt: at,
    phaseDeadlineAt: null, updatedAt: at, elapsedSeconds: 300, remainingSeconds: null,
    master: { state: 'failed', memoryPeakMb: 2300 }, caves: { state: 'pending', memoryPeakMb: null },
    diagnosis: { code: 'timeout', message: '加载超时' },
    swapAdvice: { state: 'low', message: '启动余量不足，建议追加 2 GiB swap', command: 'sudo env BSP_SWAP_FILE=/swapfile-bsp-extra-2g BSP_SWAP_SIZE=2G bsp setup-swap' },
  }
  await updateGameInstanceRuntime(id, { lastStartupReport: report })
  closeDatabase()
  await initDatabase(databasePath, migrations, databaseOptions)
  assert.deepEqual((await getGameInstanceById(id))?.lastStartupReport, report)
  assert.equal((await getGameInstanceById(id))?.resourceConfig?.masterMemoryMb, 3072)
  const next = { ...report, taskId: 'new-task', status: 'running' as const, phase: 'master_loading' as const, diagnosis: null }
  await updateGameInstanceRuntime(id, { status: 'running', lastStartupReport: next })
  await updateGameInstanceRuntime(id, { status: 'error', lastError: '旧任务错误', lastStartupReport: report, whereStartupTaskId: 'old-task' })
  const current = await getGameInstanceById(id)
  assert.equal(current?.status, 'running')
  assert.equal(current?.lastError, null)
  assert.deepEqual(current?.lastStartupReport, next)
  await updateGameInstanceRuntime(id, { status: 'stopped', whereStartupTaskId: 'new-task' })
  assert.equal((await getGameInstanceById(id))?.status, 'stopped')
})

it('recommends from persisted peaks when runtime metrics are unavailable', async (t) => {
  t.mock.method(getContainerRuntime(), 'findByName', async () => undefined)
  await setPermissions(['instance:read'])
  const response = await app.inject({ method: 'GET', url: `/app/instance/resources?id=${id}`, headers: { token } })
  const body = JSON.parse(response.body)
  assert.equal(body.error, '')
  assert.equal(body.data.recommendation.masterPeakMb, 2300)
  assert.equal(body.data.recommendation.masterMemoryMb, 2816)
  assert.equal(body.data.current.master, null)
  assert.equal(body.data.current.caves, null)
})

it('resource settings expose low swap and a shortfall-sized append command', async (t) => {
  t.mock.method(getContainerRuntime(), 'findByName', async () => undefined)
  const previous = process.env.BSP_HOST_MIN_AVAILABLE_MB
  process.env.BSP_HOST_MIN_AVAILABLE_MB = '3800'
  t.after(() => {
    if (previous === undefined) delete process.env.BSP_HOST_MIN_AVAILABLE_MB
    else process.env.BSP_HOST_MIN_AVAILABLE_MB = previous
  })
  const instance = await getGameInstanceById(id)
  assert.ok(instance)
  const low = await getInstanceResourceSettings(instance, { availableMb: 900, totalMb: 3915, swapFreeMb: 1024, swapTotalMb: 2048 })
  assert.equal(instanceResourcesPayloadSchema.safeParse(low).success, true)
  assert.equal(low.swapAdvice.state, 'low')
  assert.match(low.swapAdvice.command ?? '', /BSP_SWAP_FILE=\/swapfile-bsp-extra-2g BSP_SWAP_SIZE=2G/)
  const exhausted = await getInstanceResourceSettings(instance, { availableMb: 900, totalMb: 3915, swapFreeMb: 0, swapTotalMb: 2048 })
  assert.equal(exhausted.swapAdvice.state, 'exhausted')
  assert.match(exhausted.swapAdvice.command ?? '', /BSP_SWAP_FILE=\/swapfile-bsp-extra-3g BSP_SWAP_SIZE=3G/)
})
