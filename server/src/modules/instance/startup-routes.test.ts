import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, it, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import Fastify from 'fastify'
import { ErrorCode } from '../../../../shared/constants/error-code'
import { instanceStartupSnapshotSchema, type InstanceStartupSnapshot } from '../../../../shared/contracts/instance-resources'
import { buildCavesContainerName, getContainerRuntime, type ContainerRef, type LogOpts } from '../../infra/container'
import { addUserInstanceGrants, closeDatabase, createGameInstance, findUserByAccount, getGameInstanceById, initDatabase, updateGameInstanceRuntime } from '../../shared/db'
import { ensureDb, nowIso } from '../../shared/db/connection'
import { userPermissions } from '../../shared/db/schema'
import { instanceConsoleLogStore } from '../../shared/instance-runtime/console-log-store'
import { registerAuthModule } from '../auth'
import { registerInstanceModule } from './index'
import { bumpCavesStartGeneration, ensureInstanceContainerLogFollow, stopInstanceContainer } from './container-lifecycle'
import { createStartupTask, currentStartupTask, persistStartupTask, releaseStartupTask } from './startup-state'
import { resolvePluginInstanceOps } from './instance-plugin-ops'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-startup-routes-'))
const databasePath = path.join(dir, 'test.sqlite')
const migrations = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle')
const app = Fastify()
const rawLog = 'PRIVATE_CONSOLE_LOG_NOT_IN_STARTUP_SUMMARY'
const previousUnitTest = process.env.BSP_UNIT_TEST
let id = ''
let hiddenId = ''
let userId = ''
let token = ''

async function setPermissions(permissions: string[]) {
  const { drizzleDb } = ensureDb()
  await drizzleDb.delete(userPermissions).where(eq(userPermissions.userId, userId))
  if (permissions.length) await drizzleDb.insert(userPermissions).values(permissions.map(permission => ({ userId, permission, createdAt: nowIso() })))
}

before(async () => {
  process.env.BSP_UNIT_TEST = '1'
  await initDatabase(databasePath, migrations, { adminUsername: 'startup-user', adminPassword: '123456', seedDevelopmentUsers: false })
  id = (await createGameInstance({ nodeId: 'local-node', name: 'startup', gameCode: '343050', status: 'stopped' })).id
  hiddenId = (await createGameInstance({ nodeId: 'local-node', name: 'hidden', gameCode: '343050', status: 'stopped' })).id
  const at = new Date().toISOString()
  const report: InstanceStartupSnapshot = {
    taskId: 'startup-report', status: 'failed', phase: 'failed', startedAt: at, phaseStartedAt: at,
    phaseDeadlineAt: null, updatedAt: at, elapsedSeconds: 0, remainingSeconds: null,
    master: { state: 'failed', memoryPeakMb: 2300 }, caves: { state: 'pending', memoryPeakMb: null },
    diagnosis: { code: 'timeout', message: '加载超时' },
  }
  await updateGameInstanceRuntime(id, { lastStartupReport: report })
  await updateGameInstanceRuntime(hiddenId, { lastStartupReport: { ...report, taskId: 'hidden-task' } })
  instanceConsoleLogStore.appendDockerLine(id, rawLog, 'master')
  const user = await findUserByAccount('startup-user')
  assert.ok(user)
  userId = user.id
  await addUserInstanceGrants(userId, [id], null)
  registerAuthModule(app)
  registerInstanceModule(app)
  await app.ready()
  const login = await app.inject({ method: 'POST', url: '/app/account/login', payload: { account: 'startup-user', password: '123456' } })
  token = JSON.parse(login.body).data.token
})

after(async () => {
  await app.close()
  instanceConsoleLogStore.removeInstance(id)
  instanceConsoleLogStore.removeInstance(hiddenId)
  closeDatabase()
  fs.rmSync(dir, { recursive: true, force: true })
  if (previousUnitTest === undefined) delete process.env.BSP_UNIT_TEST
  else process.env.BSP_UNIT_TEST = previousUnitTest
})

it('startup requires instance:read independently of console access and still enforces the instance grant', async () => {
  await setPermissions(['console:read'])
  const consoleOnly = await app.inject({ method: 'GET', url: `/app/instance/startup?id=${id}`, headers: { token } })
  assert.equal(JSON.parse(consoleOnly.body).code, ErrorCode.FORBIDDEN)
  await setPermissions(['instance:read'])
  const hidden = await app.inject({ method: 'GET', url: `/app/instance/startup?id=${hiddenId}`, headers: { token } })
  assert.equal(JSON.parse(hidden.body).code, ErrorCode.FORBIDDEN)
  const allowed = await app.inject({ method: 'GET', url: `/app/instance/startup?id=${id}`, headers: { token } })
  assert.equal(JSON.parse(allowed.body).error, '')
})

it('startup exposes only contract metadata and excludes raw console logs', async () => {
  await setPermissions(['instance:read'])
  const response = await app.inject({ method: 'GET', url: `/app/instance/startup?id=${id}`, headers: { token } })
  const body = JSON.parse(response.body)
  assert.equal(body.error, '')
  assert.deepEqual(body.data, instanceStartupSnapshotSchema.strict().parse(body.data))
  assert.equal(body.data.taskId, 'startup-report')
  assert.equal(body.data.diagnosis.code, 'timeout')
  assert.equal(body.data.master.memoryPeakMb, 2300)
  assert.equal(response.body.includes(rawLog), false)
  assert.equal('logs' in body.data, false)
})

it('instance list includes safe startup metadata only for granted instances', async (t) => {
  t.mock.method(getContainerRuntime(), 'findByName', async () => undefined)
  await setPermissions(['instance:read'])
  const response = await app.inject({ method: 'POST', url: '/app/instance/list', headers: { token }, payload: {} })
  const body = JSON.parse(response.body)
  assert.equal(body.error, '')
  assert.deepEqual(body.data.map((instance: { id: string }) => instance.id), [id])
  assert.equal(body.data[0].startup.taskId, 'startup-report')
  assert.deepEqual(body.data[0].startup, instanceStartupSnapshotSchema.strict().parse(body.data[0].startup))
  assert.equal(response.body.includes(rawLog), false)
  assert.equal(response.body.includes('hidden-task'), false)
})

async function residualCave(t: TestContext) {
  await setPermissions(['instance:lifecycle'])
  await updateGameInstanceRuntime(id, { status: 'stopped', containerId: null, runtimeStartedAt: null, lastError: null })
  const runtime = getContainerRuntime()
  const cavesRef = { id: 'residual-caves', name: buildCavesContainerName(id) }
  let present = true
  let followSignal: AbortSignal | undefined
  t.mock.method(runtime, 'findByName', async (name: string) => present && name === cavesRef.name ? cavesRef : undefined)
  t.mock.method(runtime, 'inspect', async (ref: ContainerRef) => ({ ...ref, running: true }))
  t.mock.method(runtime, 'logs', async function* (_ref: ContainerRef, opts: LogOpts = {}) {
    followSignal = opts.signal
    yield { stream: 'stdout' as const, text: 'Caves reconnecting to missing master' }
    await new Promise<void>((resolve) => {
      if (opts.signal?.aborted) resolve()
      else opts.signal?.addEventListener('abort', () => resolve(), { once: true })
    })
  })
  const stop = t.mock.method(runtime, 'stop', async () => { assert.equal(followSignal?.aborted, true) })
  const remove = t.mock.method(runtime, 'remove', async () => { present = false })
  t.mock.method(runtime, 'removeShardNetwork', async () => {})
  await ensureInstanceContainerLogFollow(id)
  assert.equal(followSignal?.aborted, false)
  t.after(async () => {
    t.mock.method(runtime, 'findByName', async () => undefined)
    await stopInstanceContainer(id)
    const task = currentStartupTask(id)
    if (task) releaseStartupTask(task)
  })
  return { runtime, cavesRef, stop, remove, signal: followSignal! }
}

for (const source of ['http', 'plugin'] as const) {
  it(`${source} stop cleans a residual cave with no master ID and repeated stop is idempotent`, async (t) => {
    const f = await residualCave(t)
    const invoke = async () => {
      if (source === 'plugin') {
        const result = await resolvePluginInstanceOps()!.stop(app, id)
        assert.equal(result.ok, true)
      }
      else {
        const response = await app.inject({ method: 'POST', url: '/app/instance/stop', headers: { token }, payload: { id } })
        assert.equal(JSON.parse(response.body).error, '')
      }
    }
    await invoke()
    assert.equal(f.signal.aborted, true)
    assert.equal(f.stop.mock.callCount(), 1)
    assert.deepEqual(f.stop.mock.calls[0]?.arguments[0], f.cavesRef)
    assert.equal(f.remove.mock.callCount(), 1)
    assert.equal((await getGameInstanceById(id))?.status, 'stopped')
    await invoke()
    assert.equal(f.stop.mock.callCount(), 1)
    assert.equal(f.remove.mock.callCount(), 1)
  })
}

for (const failure of ['probe', 'cleanup'] as const) {
  it(`stop does not declare success when runtime ${failure} is unavailable`, async (t) => {
    const f = await residualCave(t)
    if (failure === 'probe') t.mock.method(f.runtime, 'findByName', async () => { throw new Error('runtime unavailable') })
    else {
      f.stop.mock.mockImplementation(async () => { throw new Error('runtime unavailable') })
      f.remove.mock.mockImplementation(async () => { throw new Error('runtime unavailable') })
    }
    const response = await app.inject({ method: 'POST', url: '/app/instance/stop', headers: { token }, payload: { id } })
    assert.ok(JSON.parse(response.body).error)
    assert.equal(f.signal.aborted, true)
    assert.equal((await getGameInstanceById(id))?.status, 'error')
  })
}

it('an old stop does not remove the cave or overwrite a newer startup generation', async (t) => {
  const f = await residualCave(t)
  f.stop.mock.mockImplementation(async () => {
    bumpCavesStartGeneration(id)
    const next = createStartupTask(id)
    await persistStartupTask(next)
    await updateGameInstanceRuntime(id, { status: 'running', containerId: 'new-master', lastError: null })
  })
  const response = await app.inject({ method: 'POST', url: '/app/instance/stop', headers: { token }, payload: { id } })
  assert.equal(JSON.parse(response.body).error, '')
  assert.equal(f.remove.mock.callCount(), 0)
  const row = await getGameInstanceById(id)
  assert.equal(row?.status, 'running')
  assert.equal(row?.containerId, 'new-master')
  assert.equal(row?.lastStartupReport?.status, 'queued')
  assert.equal(row?.lastError, null)
})
