import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, it, type TestContext } from 'node:test'
import Fastify from 'fastify'
import { buildMasterContainerName, buildCavesContainerName, getContainerRuntime, type ContainerRuntime, type ContainerRef } from '../../infra/container'
import { emptyResourceSnapshot } from '../../infra/container/dst-container-resources'
import { closeDatabase, createGameInstance, deleteGameInstanceById, getGameInstanceById, initDatabase, updateGameInstanceRuntime } from '../../shared/db'
import { protectInstanceMemory, recoverInstanceStartup, startInstanceContainer, stopInstanceContainer } from './container-lifecycle'
import { createStartupTask, persistStartupTask, releaseStartupTask } from './startup-state'
import { reconcileInstanceRuntimeState } from './runtime-reconciliation'
import { registerInstanceModule } from './index'
import { resolvePluginInstanceOps } from './instance-plugin-ops'
import { restartInstanceCore } from './restart-instance-core'
import { inspectMemoryProtection, stopMemoryProtectionWatch } from './memory-watch'
import { reconcileUnexpectedExits } from './exit-watch'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-memory-protection-'))
before(async () => {
  process.env.BSP_UNIT_TEST = '1'
  await initDatabase(path.join(directory, 'fixture.sqlite'), path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle'), { adminUsername: 'admin', adminPassword: '123456', seedDevelopmentUsers: false })
})
after(() => { closeDatabase(); fs.rmSync(directory, { recursive: true, force: true }) })
async function fixture(t: TestContext, loading = false) {
  const app = Fastify()
  const instance = await createGameInstance({ nodeId: 'local-node', name: 'memory-guard', gameCode: '343050', status: 'running', containerId: 'master-old' })
  const masterId = `master-${instance.id}`
  await updateGameInstanceRuntime(instance.id, { containerId: masterId, runtimeStartedAt: new Date().toISOString() })
  const task = createStartupTask(instance.id)
  task.snapshot.status = loading ? 'running' : 'success'; task.snapshot.phase = loading ? 'master_loading' : 'ready'
  task.snapshot.master = { state: 'ready', memoryPeakMb: 3200 }
  task.snapshot.caves = { state: 'ready', memoryPeakMb: 1536 }
  await persistStartupTask(task)
  const refs = new Map<string, ContainerRef>([[buildMasterContainerName(instance.id), { id: masterId, name: buildMasterContainerName(instance.id) }], [buildCavesContainerName(instance.id), { id: `caves-${instance.id}`, name: buildCavesContainerName(instance.id) }]])
  const runtime = getContainerRuntime() as ContainerRuntime & Required<Pick<ContainerRuntime, 'resourceSnapshot' | 'emergencyRemove' | 'hostResources'>>
  t.mock.method(runtime, 'findByName', async (name: string) => refs.get(name))
  t.mock.method(runtime, 'inspect', async (ref: ContainerRef) => ({ ...ref, running: refs.has(ref.name) }))
  t.mock.method(runtime, 'resourceSnapshot', async () => ({ ...emptyResourceSnapshot(), runtimeIdentity: 'old-round', memoryCurrentMb: 3000, memoryMaxMb: 3072 }))
  t.mock.method(runtime, 'removeShardNetwork', async () => {})
  t.mock.method(runtime, 'stop', async () => {})
  t.mock.method(runtime, 'remove', async (ref: ContainerRef) => { refs.delete(ref.name) })
  t.mock.method(runtime, 'emergencyRemove', async (ref: ContainerRef) => { refs.delete(ref.name) })
  t.after(async () => { stopMemoryProtectionWatch(); releaseStartupTask(task); await deleteGameInstanceById(instance.id); await app.close() })
  const evidence = { code: 'oom' as const, message: '确认本轮 OOM', master: { ...emptyResourceSnapshot(), runtimeIdentity: 'old-round', memoryCurrentMb: 3000, memoryMaxMb: 3072 }, caves: null, host: null }
  return { app, instance: (await getGameInstanceById(instance.id))!, task, refs, runtime, evidence }
}

it('persists protection before parallel two-shard cleanup and retains a successful startup record', async t => {
  const f = await fixture(t)
  const started: string[] = []
  let resolveBoth!: () => void
  const both = new Promise<void>(resolve => { resolveBoth = resolve })
  t.mock.method(f.runtime, 'emergencyRemove', async (ref: ContainerRef) => {
    assert.equal((await getGameInstanceById(f.instance.id))?.runtimeFailureKind, 'memory_protection')
    started.push(ref.id)
    if (started.length === 2) resolveBoth()
    await both
    f.refs.delete(ref.name)
  })
  await protectInstanceMemory(f.app, f.instance, f.evidence)
  const row = (await getGameInstanceById(f.instance.id))!
  assert.equal(started.length, 2)
  assert.equal(row.runtimeFailureKind, 'memory_protection')
  assert.equal(row.lastStartupReport?.status, 'success')
  assert.equal(row.lastStartupReport?.master.memoryPeakMb, 3200)
  assert.equal(row.lastStartupReport?.protectionStop?.cleanupCompleted, true)
  assert.equal(row.containerId, null)
  await stopInstanceContainer(row.id)
  assert.equal((await getGameInstanceById(row.id))?.runtimeFailureKind, 'memory_protection')
  assert.equal((await getGameInstanceById(row.id))?.lastError, f.evidence.message)
})

it('loading protection becomes failure; failed cleanup keeps references and blocks manual/automatic start', async t => {
  const f = await fixture(t, true)
  t.mock.method(f.runtime, 'emergencyRemove', async () => { throw new Error('cleanup unavailable') })
  await protectInstanceMemory(f.app, f.instance, f.evidence)
  const row = (await getGameInstanceById(f.instance.id))!
  assert.equal(row.lastStartupReport?.status, 'failed')
  assert.equal(row.lastStartupReport?.protectionStop?.cleanupCompleted, false)
  assert.equal(row.containerId, f.instance.containerId)
  assert.match(row.lastError!, /清理未完成/)
  const input = { instanceId: row.id, gameCode: row.gameCode, installPath: directory, instanceName: row.name, gamePort: null }
  assert.equal((await startInstanceContainer(f.app, { ...input, source: 'manual' })).ok, false)
  assert.equal((await startInstanceContainer(f.app, { ...input, source: 'automatic' })).ok, false)
  await stopInstanceContainer(row.id)
  assert.equal((await getGameInstanceById(row.id))?.lastStartupReport?.protectionStop?.cleanupCompleted, true)
})

it('old epochs and changed runtime identities cannot stop newer processes or overwrite their state', async t => {
  const f = await fixture(t)
  await updateGameInstanceRuntime(f.instance.id, { containerId: 'master-new', runtimeStartedAt: new Date(Date.now() + 1000).toISOString() })
  await protectInstanceMemory(f.app, f.instance, f.evidence)
  assert.equal(f.refs.size, 2)
  const current = (await getGameInstanceById(f.instance.id))!
  t.mock.method(f.runtime, 'resourceSnapshot', async () => ({ ...emptyResourceSnapshot(), runtimeIdentity: 'new-round' }))
  await protectInstanceMemory(f.app, current, f.evidence)
  assert.equal(f.refs.size, 2)
  assert.equal((await getGameInstanceById(current.id))?.runtimeFailureKind, null)
})

it('panel recovery, reconciliation, plugin operations and implicit restart preserve protection', async t => {
  const f = await fixture(t)
  await protectInstanceMemory(f.app, f.instance, f.evidence)
  releaseStartupTask(f.task)
  registerInstanceModule(f.app)
  await f.app.ready()
  const protectedRow = (await getGameInstanceById(f.instance.id))!
  await recoverInstanceStartup(f.app, protectedRow)
  await reconcileInstanceRuntimeState(f.app)
  const plugin = resolvePluginInstanceOps()!
  assert.equal((await plugin.start(f.app, protectedRow.id)).ok, false)
  assert.equal((await plugin.restart(f.app, protectedRow.id)).ok, false)
  const response = await restartInstanceCore(f.app, { headers: {}, id: 'internal', url: '/internal' } as never, protectedRow.id, { source: 'automatic' })
  assert.ok('error' in response && response.error)
  assert.equal((await getGameInstanceById(protectedRow.id))?.runtimeFailureKind, 'memory_protection')
})

it('the live watch waits for continuous pressure and resets its window on unknown metrics', async t => {
  const f = await fixture(t, true)
  let now = Date.now() + 60_000
  t.mock.method(Date, 'now', () => now)
  t.mock.method(f.runtime, 'hostResources', async () => null)
  let unknown = false
  let events = 0
  t.mock.method(f.runtime, 'resourceSnapshot', async () => ({ ...emptyResourceSnapshot(), runtimeIdentity: 'old-round',
    memoryCurrentMb: 3000, memoryMaxMb: 3072, maxEvents: ++events, oomKillCount: 8,
    memoryPressureFullAvg10: unknown ? null : 30 }))
  f.task.snapshot.lastProgressAt = new Date(now - 30_000).toISOString()
  await persistStartupTask(f.task)
  for (let i = 0; i < 3; i++) { await inspectMemoryProtection(f.app); now += 5000 }
  assert.equal((await getGameInstanceById(f.instance.id))?.runtimeFailureKind, null)
  unknown = true
  await inspectMemoryProtection(f.app)
  now += 5000
  unknown = false
  for (let i = 0; i < 3; i++) { await inspectMemoryProtection(f.app); now += 5000 }
  assert.equal((await getGameInstanceById(f.instance.id))?.runtimeFailureKind, null)
  await inspectMemoryProtection(f.app)
  assert.equal((await getGameInstanceById(f.instance.id))?.lastStartupReport?.protectionStop?.code, 'shard_memory_pressure')
  assert.equal(f.refs.size, 0)
})

it('a restarted runtime establishes a new OOM baseline instead of replaying historical counters', async t => {
  const f = await fixture(t)
  let now = Date.now() + 120_000
  t.mock.method(Date, 'now', () => now)
  t.mock.method(f.runtime, 'hostResources', async () => null)
  f.task.snapshot.master.resourceBaseline = { ...emptyResourceSnapshot(), runtimeIdentity: 'old-round', oomKillCount: 0, oomKilled: false }
  await persistStartupTask(f.task)
  let oom = 8
  t.mock.method(f.runtime, 'resourceSnapshot', async () => ({ ...emptyResourceSnapshot(), runtimeIdentity: 'new-round', oomKillCount: oom, oomKilled: true, restarts: 2 }))
  await inspectMemoryProtection(f.app)
  assert.equal((await getGameInstanceById(f.instance.id))?.runtimeFailureKind, null)
  now += 5000
  oom++
  await inspectMemoryProtection(f.app)
  assert.equal((await getGameInstanceById(f.instance.id))?.lastStartupReport?.protectionStop?.code, 'oom')
})

it('reconciliation protects an OOM-exited master before clearing references, including the live cave', async t => {
  const f = await fixture(t)
  releaseStartupTask(f.task)
  t.mock.method(f.runtime, 'hostResources', async () => null)
  t.mock.method(f.runtime, 'inspect', async (ref: ContainerRef) => ({ ...ref, running: ref.name.endsWith('-caves'), runtimeIdentity: 'old-round',
    startedAt: 'Sat 2026-10-10 19:00:00 CST', exitResult: ref.name.endsWith('-caves') ? 'success' : 'oom-kill' }))
  t.mock.method(f.runtime, 'resourceSnapshot', async (ref: ContainerRef) => ({ ...emptyResourceSnapshot(), runtimeIdentity: 'old-round',
    oomKilled: !ref.name.endsWith('-caves'), oomKillCount: 8, memoryMaxMb: 3072 }))
  await reconcileInstanceRuntimeState(f.app)
  const row = (await getGameInstanceById(f.instance.id))!
  assert.equal(row.runtimeFailureKind, 'memory_protection')
  assert.equal(row.lastStartupReport?.status, 'success')
  assert.equal(row.lastStartupReport?.protectionStop?.cleanupCompleted, true)
  assert.equal(f.refs.size, 0)
})

it('the first watch sample protects an OOM-exited cave while the master is alive', async t => {
  const f = await fixture(t, true)
  t.mock.method(f.runtime, 'hostResources', async () => null)
  t.mock.method(f.runtime, 'inspect', async (ref: ContainerRef) => ({ ...ref, running: !ref.name.endsWith('-caves'),
    exitResult: ref.name.endsWith('-caves') ? 'oom-kill' : 'success' }))
  t.mock.method(f.runtime, 'resourceSnapshot', async (ref: ContainerRef) => ({ ...emptyResourceSnapshot(), runtimeIdentity: 'old-round',
    oomKilled: ref.name.endsWith('-caves'), oomKillCount: 8 }))
  await inspectMemoryProtection(f.app)
  assert.equal((await getGameInstanceById(f.instance.id))?.runtimeFailureKind, 'memory_protection')
  assert.equal((await getGameInstanceById(f.instance.id))?.lastStartupReport?.status, 'failed')
  assert.equal(f.refs.size, 0)
})

it('the exit watch preserves OOM protection instead of marking only the master stopped', async t => {
  const f = await fixture(t)
  releaseStartupTask(f.task)
  await updateGameInstanceRuntime(f.instance.id, { runtimeStartedAt: new Date(Date.now() - 120_000).toISOString() })
  t.mock.method(f.runtime, 'hostResources', async () => null)
  t.mock.method(f.runtime, 'inspect', async (ref: ContainerRef) => ({ ...ref, running: ref.name.endsWith('-caves'), exitResult: ref.name.endsWith('-caves') ? 'success' : 'oom-kill' }))
  t.mock.method(f.runtime, 'resourceSnapshot', async (ref: ContainerRef) => ({ ...emptyResourceSnapshot(), runtimeIdentity: 'old-round', oomKilled: !ref.name.endsWith('-caves') }))
  assert.equal(await reconcileUnexpectedExits(f.app), 1)
  assert.equal((await getGameInstanceById(f.instance.id))?.runtimeFailureKind, 'memory_protection')
  assert.equal(f.refs.size, 0)
})
