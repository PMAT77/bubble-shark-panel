import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, it, type TestContext } from 'node:test'
import Fastify from 'fastify'
import { buildMasterContainerName, getContainerRuntime } from '../../infra/container'
import { closeDatabase, createGameInstance, deleteGameInstanceById, getGameInstanceById, initDatabase, updateGameInstanceRuntime } from '../../shared/db'
import { instanceConsoleLogStore } from '../../shared/instance-runtime/console-log-store'
import { emptyResourceSnapshot } from '../../infra/container/dst-container-resources'
import { reconcileInstanceRuntimeState } from './runtime-reconciliation'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-runtime-resource-'))
before(async () => {
  await initDatabase(path.join(directory, 'test.sqlite'), path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle'), {
    adminUsername: 'admin', adminPassword: '123456', seedDevelopmentUsers: false,
  })
})
after(() => { closeDatabase(); fs.rmSync(directory, { recursive: true, force: true }) })

async function fixture(t: TestContext) {
  const app = Fastify()
  const instance = await createGameInstance({ nodeId: 'local-node', name: 'runtime-resources', gameCode: '343050', status: 'running' })
  const name = buildMasterContainerName(instance.id)
  const runtime = getContainerRuntime() as ReturnType<typeof getContainerRuntime> & { resourceSnapshot: NonNullable<ReturnType<typeof getContainerRuntime>['resourceSnapshot']> }
  t.mock.method(runtime, 'findByName', async (requested: string) => requested === name ? { id: name, name } : undefined)
  t.mock.method(runtime, 'logs', async function* () {})
  const resources = t.mock.method(runtime, 'resourceSnapshot', async () => emptyResourceSnapshot())
  const previous = process.env.BSP_DST_CONTAINER_MEMORY_MB
  process.env.BSP_DST_CONTAINER_MEMORY_MB = '1536'
  t.after(async () => {
    if (previous === undefined) delete process.env.BSP_DST_CONTAINER_MEMORY_MB
    else process.env.BSP_DST_CONTAINER_MEMORY_MB = previous
    instanceConsoleLogStore.removeInstance(instance.id)
    await deleteGameInstanceById(instance.id)
    await app.close()
  })
  return { app, instance, runtime, name, resources }
}

it('runtime OOM warnings ignore legacy overrides but preserve captured startup settings', async (t) => {
  const { app, instance, runtime, name, resources } = await fixture(t)
  t.mock.method(runtime, 'inspect', async () => ({ id: name, name, running: true, restarts: 1, uptimeSeconds: 5, exitResult: 'oom-kill', memOomKillCount: 1 }))
  const settings = { masterMemoryMb: 5120, cavesMemoryMb: 3072, shardReadyWaitSec: 600 }
  const startedAt = new Date(Date.now() - 30_000).toISOString()
  await updateGameInstanceRuntime(instance.id, { runtimeStartedAt: startedAt, resourceConfig: settings })
  await reconcileInstanceRuntimeState(app)
  assert.match((await getGameInstanceById(instance.id))?.runtimeWarning ?? '', /配置上限 1536 MiB，实际未读取/)
  await updateGameInstanceRuntime(instance.id, {
    resourceConfig: { ...settings, masterMemoryMb: 1024 }, runtimeWarning: null,
    lastStartupReport: { taskId: 'captured', status: 'failed', phase: 'failed', startedAt, phaseStartedAt: startedAt, updatedAt: startedAt,
      phaseDeadlineAt: null, elapsedSeconds: 30, remainingSeconds: null, settings,
      master: { state: 'failed', memoryPeakMb: null }, caves: { state: 'pending', memoryPeakMb: null }, diagnosis: null },
  })
  resources.mock.mockImplementation(async () => { throw new Error('runtime resources unavailable') })
  await reconcileInstanceRuntimeState(app)
  const warning = (await getGameInstanceById(instance.id))?.runtimeWarning ?? ''
  assert.match(warning, /配置上限 5120 MiB，实际未读取/)
  assert.doesNotMatch(warning, /1536|1024/)
})

it('runtime readiness preserves the captured timeout despite subsequent server or legacy configuration changes', async (t) => {
  const { app, instance, runtime, name, resources } = await fixture(t)
  t.mock.method(runtime, 'inspect', async () => ({ id: name, name, running: true, restarts: 0, uptimeSeconds: 5 }))
  const at = new Date(Date.now() - 400_000).toISOString()
  await updateGameInstanceRuntime(instance.id, { runtimeStartedAt: at, resourceConfig: { masterMemoryMb: 5120, cavesMemoryMb: 0, shardReadyWaitSec: 1 },
    lastStartupReport: { taskId: 'captured', status: 'running', phase: 'master_loading', startedAt: at, phaseStartedAt: at, updatedAt: at,
      phaseDeadlineAt: new Date(Date.parse(at) + 600_000).toISOString(), elapsedSeconds: 400, remainingSeconds: 200,
      settings: { masterMemoryMb: 5120, cavesMemoryMb: null, shardReadyWaitSec: 600 },
      master: { state: 'loading', memoryPeakMb: null }, caves: { state: 'disabled', memoryPeakMb: null }, diagnosis: null } })
  await reconcileInstanceRuntimeState(app)
  assert.equal((await getGameInstanceById(instance.id))?.runtimeWarning, null)
  assert.equal(resources.mock.callCount(), 0, 'healthy listing must not collect extra resources')
})

it('OOM diagnostics use the actual 2560 MiB cap instead of the configured 1536 MiB cap', async (t) => {
  const { app, instance, runtime, name, resources } = await fixture(t)
  t.mock.method(runtime, 'inspect', async () => ({ id: name, name, running: true, restarts: 1, uptimeSeconds: 5, exitResult: 'oom-kill', memOomKillCount: 4 }))
  resources.mock.mockImplementation(async () => ({ ...emptyResourceSnapshot(), memoryMaxMb: 2560 }))
  await reconcileInstanceRuntimeState(app)
  const warning = (await getGameInstanceById(instance.id))?.runtimeWarning ?? ''
  assert.match(warning, /实际内存硬上限 2560 MiB/)
  assert.doesNotMatch(warning, /1536/)
  assert.equal(resources.mock.callCount(), 1)
})

it('restart warnings read current limits without reusing a previous task limit or peak', async (t) => {
  const { app, instance, runtime, name, resources } = await fixture(t)
  t.mock.method(runtime, 'inspect', async () => ({ id: name, name, running: true, restarts: 1, uptimeSeconds: 5, exitResult: 'oom-kill' }))
  const at = new Date(Date.now() - 600_000).toISOString()
  await updateGameInstanceRuntime(instance.id, {
    runtimeReadyAt: at,
    lastStartupReport: { taskId: 'old-task', status: 'success', phase: 'ready', startedAt: at, phaseStartedAt: at, updatedAt: at,
      phaseDeadlineAt: null, elapsedSeconds: 1, remainingSeconds: null,
      master: { state: 'ready', memoryPeakMb: 9000, resources: { ...emptyResourceSnapshot(), memoryMaxMb: 8192, memoryPeakMb: 9000 } },
      caves: { state: 'disabled', memoryPeakMb: null }, diagnosis: null },
  })
  resources.mock.mockImplementation(async () => ({ ...emptyResourceSnapshot(), memoryMaxMb: 3072 }))
  await reconcileInstanceRuntimeState(app)
  const warning = (await getGameInstanceById(instance.id))?.runtimeWarning ?? ''
  assert.match(warning, /最近一次退出.*实际内存硬上限 3072 MiB/)
  assert.doesNotMatch(warning, /8192|9000|1536/)
  assert.equal(resources.mock.callCount(), 1)
})
