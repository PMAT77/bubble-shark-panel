import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, it } from 'node:test'
import Fastify from 'fastify'
import { getContainerRuntime } from '../../infra/container'
import { closeDatabase, createGameInstance, deleteGameInstanceById, getGameInstanceById, initDatabase, updateGameInstanceRuntime } from '../../shared/db'
import { reconcileInstanceRuntimeState } from './runtime-reconciliation'
import { instanceConsoleLogStore } from '../../shared/instance-runtime/console-log-store'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-reconcile-'))
before(async () => {
  await initDatabase(path.join(dir, 'test.sqlite'), path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle'), {
    adminUsername: 'admin', adminPassword: '123456', seedDevelopmentUsers: false,
  })
})
after(() => { closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }) })

it('Lua 崩溃但进程存活时停止两个分片并保留错误，后续对账不复活', async (t) => {
  const app = Fastify()
  t.after(() => app.close())
  const instance = await createGameInstance({ nodeId: 'local-node', name: 'lua-crash', gameCode: '343050', status: 'running' })
  t.after(() => { instanceConsoleLogStore.removeInstance(instance.id); return deleteGameInstanceById(instance.id) })
  await updateGameInstanceRuntime(instance.id, { runtimeStartedAt: new Date(Date.now() - 1000).toISOString() })
  const runtime = getContainerRuntime()
  t.mock.method(runtime, 'findByName', async (name: string) => ({ id: name, name }))
  t.mock.method(runtime, 'inspect', async () => ({ id: 'unit', name: 'unit', running: true, restarts: 0, uptimeSeconds: 1000 }))
  const stop = t.mock.method(runtime, 'stop', async () => {})
  t.mock.method(runtime, 'remove', async () => {})
  t.mock.method(runtime, 'removeShardNetwork', async () => {})
  instanceConsoleLogStore.appendDockerLine(instance.id, '[00:01:08]: [string "scripts/prefabs/blueprint.lua"]:201: attempt to concatenate field', 'master')
  instanceConsoleLogStore.appendDockerLine(instance.id, 'LUA ERROR stack traceback:', 'master')
  await reconcileInstanceRuntimeState(app)
  const failed = await getGameInstanceById(instance.id)
  assert.equal(failed?.status, 'error')
  assert.equal(failed?.lastErrorPhase, 'runtime')
  assert.match(failed?.lastError ?? '', /blueprint.lua/)
  assert.equal(stop.mock.callCount(), 2)
  await updateGameInstanceRuntime(instance.id, { runtimeWarning: failed?.runtimeWarning ?? null })
  await reconcileInstanceRuntimeState(app)
  assert.equal((await getGameInstanceById(instance.id))?.status, 'error')
})

it('preserves all running fields on unknown probes, then reconciles confirmed stop and missing units', async (t) => {
  const app = Fastify()
  t.after(() => app.close())
  const instance = await createGameInstance({ nodeId: 'local-node', name: 'probe', gameCode: '343050', status: 'running' })
  t.after(() => deleteGameInstanceById(instance.id))
  await updateGameInstanceRuntime(instance.id, { containerId: 'unit', runtimePid: 123, runtimeStartedAt: new Date().toISOString() })
  const before = await getGameInstanceById(instance.id)
  const runtime = getContainerRuntime()
  t.mock.method(runtime, 'findByName', async () => ({ id: 'unit', name: 'unit' }))
  let mode = 'unknown'
  let probes = 0
  t.mock.method(runtime, 'inspect', async () => {
    probes++
    return { id: 'unit', name: 'unit', running: false, probeFailed: mode === 'unknown' }
  })
  await reconcileInstanceRuntimeState(app)
  assert.deepEqual(await getGameInstanceById(instance.id), before)
  await reconcileInstanceRuntimeState(app)
  assert.equal(probes, 2, 'unknown results must not be cached')
  mode = 'stopped'
  await reconcileInstanceRuntimeState(app)
  const stopped = await getGameInstanceById(instance.id)
  assert.equal(stopped?.status, 'stopped')
  assert.equal(stopped?.containerId, null)
  assert.equal(stopped?.runtimePid, null)
  await updateGameInstanceRuntime(instance.id, { status: 'running' })
  t.mock.method(runtime, 'findByName', async () => undefined)
  await reconcileInstanceRuntimeState(app)
  assert.equal((await getGameInstanceById(instance.id))?.status, 'stopped')
})

it('shares probes across concurrent readers and invalidates on lifecycle writes and deletion', async (t) => {
  const app = Fastify()
  t.after(() => app.close())
  const instance = await createGameInstance({ nodeId: 'local-node', name: 'cache', gameCode: '343050', status: 'stopped' })
  const runtime = getContainerRuntime()
  t.mock.method(runtime, 'findByName', async () => ({ id: 'unit', name: 'unit' }))
  const probe = t.mock.method(runtime, 'inspect', async () => ({ id: 'unit', name: 'unit', running: false }))
  await Promise.all([reconcileInstanceRuntimeState(app), reconcileInstanceRuntimeState(app), reconcileInstanceRuntimeState(app)])
  assert.equal(probe.mock.callCount(), 1)
  await reconcileInstanceRuntimeState(app)
  assert.equal(probe.mock.callCount(), 1)
  await updateGameInstanceRuntime(instance.id, { status: 'error' })
  await reconcileInstanceRuntimeState(app)
  assert.equal(probe.mock.callCount(), 2)
  await deleteGameInstanceById(instance.id)
  await reconcileInstanceRuntimeState(app)
  assert.equal(probe.mock.callCount(), 2)
})

it('does not resurrect on unknown probes but restores a confirmed healthy runtime', async (t) => {
  const app = Fastify()
  t.after(() => app.close())
  const instance = await createGameInstance({ nodeId: 'local-node', name: 'restore', gameCode: '343050', status: 'stopped' })
  t.after(() => deleteGameInstanceById(instance.id))
  const runtime = getContainerRuntime()
  t.mock.method(runtime, 'findByName', async () => ({ id: 'unit', name: 'unit' }))
  t.mock.method(runtime, 'inspect', async () => ({ id: 'unit', name: 'unit', running: false, probeFailed: true }))
  await reconcileInstanceRuntimeState(app)
  assert.equal((await getGameInstanceById(instance.id))?.status, 'stopped')
  t.mock.method(runtime, 'inspect', async () => ({ id: 'unit', name: 'unit', running: true, uptimeSeconds: 1000, restarts: 0 }))
  t.mock.method(runtime, 'logs', async function* () {})
  await reconcileInstanceRuntimeState(app)
  assert.equal((await getGameInstanceById(instance.id))?.status, 'running')
  await reconcileInstanceRuntimeState(app)
  assert.equal((await getGameInstanceById(instance.id))?.status, 'running')
})
