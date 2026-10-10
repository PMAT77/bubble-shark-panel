import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, it, type TestContext } from 'node:test'
import Fastify from 'fastify'
import type { ContainerRuntime } from '../../infra/container/types'
import { closeDatabase, createGameInstance, deleteGameInstanceById, getGameInstanceById, initDatabase } from '../../shared/db'
import { emptyResourceSnapshot } from '../../infra/container/dst-container-resources'
import { instanceConsoleLogStore } from '../../shared/instance-runtime/console-log-store'
import { runStartupMonitor } from './startup-monitor'
import { cancelStartupTask, createStartupTask, releaseStartupTask } from './startup-state'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-startup-baseline-'))
before(async () => {
  await initDatabase(path.join(directory, 'test.sqlite'), path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle'), {
    adminUsername: 'admin', adminPassword: '123456', seedDevelopmentUsers: false,
  })
})
after(() => { closeDatabase(); fs.rmSync(directory, { recursive: true, force: true }) })

async function fixture(t: TestContext) {
  const instance = await createGameInstance({ nodeId: 'local-node', name: 'baseline', gameCode: '343050', status: 'running' })
  const task = createStartupTask(instance.id)
  const app = Fastify()
  t.after(async () => {
    cancelStartupTask(instance.id)
    releaseStartupTask(task)
    instanceConsoleLogStore.removeInstance(instance.id)
    await app.close()
    await deleteGameInstanceById(instance.id)
  })
  const cleanup = t.mock.fn(async () => {})
  return { app, task, cleanup, masterRef: { id: 'master', name: 'master' }, startedAt: new Date().toISOString(), waitSec: 2, pollIntervalMs: 1,
    isCancelled: () => false, luaFailure: () => null }
}

it('historical OOM flags and counters do not fail a healthy loading process', async t => {
  const input = await fixture(t)
  const resources = { ...emptyResourceSnapshot(), runtimeIdentity: 'new-process', oomKillCount: 8, oomKilled: true }
  input.task.snapshot.master.resourceBaseline = { ...resources, runtimeIdentity: 'previous-process', oomKillCount: 0, oomKilled: false }
  await runStartupMonitor(input.app, { ...input, baselineRestarts: 0,
    runtime: { inspect: async () => ({ ...input.masterRef, running: true, restarts: 0, exitResult: 'oom-kill' }), resourceSnapshot: async () => resources } as unknown as ContainerRuntime,
    probe: async () => ({ worldReady: true, shardId: '1', remoteConnected: null }) })
  assert.equal(input.task.snapshot.status, 'success')
  assert.equal(input.cleanup.mock.callCount(), 0)
})

it('captures the first successful restart count after an unknown initial probe', async (t) => {
  const input = await fixture(t)
  let calls = 0
  const runtime = { inspect: async () => ++calls === 1
    ? { ...input.masterRef, running: false, probeFailed: true }
    : { ...input.masterRef, running: true, restarts: 2 } } as unknown as ContainerRuntime
  await runStartupMonitor(input.app, { ...input, runtime, baselineRestarts: null,
    probe: async () => {
      assert.equal((await getGameInstanceById(input.task.instanceId))?.lastStartupReport?.master.restartBaseline, 2)
      return { worldReady: true, shardId: '1', remoteConnected: null }
    } })
  assert.equal(input.task.snapshot.status, 'success')
  assert.equal(input.cleanup.mock.callCount(), 0)
})

it('restores a persisted zero baseline ahead of later sampled restart counters', async (t) => {
  const input = await fixture(t)
  input.task.snapshot.master.restartBaseline = 0
  input.task.snapshot.master.resources = { ...emptyResourceSnapshot(), restarts: 1 }
  const runtime = { inspect: async () => ({ ...input.masterRef, running: true, restarts: 1 }) } as unknown as ContainerRuntime
  await runStartupMonitor(input.app, { ...input, runtime, baselineRestarts: null,
    probe: async () => ({ worldReady: true, shardId: '1', remoteConnected: null }) })
  assert.equal(input.task.snapshot.status, 'failed')
  assert.equal(input.task.snapshot.diagnosis?.code, 'shard_exited')
  assert.equal((await getGameInstanceById(input.task.instanceId))?.lastStartupReport?.master.restartBaseline, 0)
})

it('still fails when a known restart count increases', async (t) => {
  const input = await fixture(t)
  const runtime = { inspect: async () => ({ ...input.masterRef, running: true, restarts: 2 }) } as unknown as ContainerRuntime
  await runStartupMonitor(input.app, { ...input, runtime, baselineRestarts: 1,
    probe: async () => ({ worldReady: true, shardId: '1', remoteConnected: null }) })
  assert.equal(input.task.snapshot.status, 'failed')
  assert.equal(input.task.snapshot.diagnosis?.code, 'shard_exited')
  assert.equal(input.cleanup.mock.callCount(), 1)
})

it('preserves a newly captured baseline instead of updating it on every tick', async (t) => {
  const input = await fixture(t)
  let restarts = 2
  const runtime = { inspect: async () => ({ ...input.masterRef, running: true, restarts }) } as unknown as ContainerRuntime
  await runStartupMonitor(input.app, { ...input, runtime, baselineRestarts: null,
    probe: async () => { restarts = 3; return { worldReady: false, shardId: '1', remoteConnected: null } } })
  assert.equal(input.task.snapshot.status, 'failed')
  assert.equal(input.task.snapshot.diagnosis?.code, 'shard_exited')
})

it('captures unknown cave and restored master baselines without assuming zero', async (t) => {
  const input = await fixture(t)
  const cavesRef = { id: 'caves', name: 'caves' }
  input.task.snapshot.master.state = 'ready'
  input.task.snapshot.phase = 'caves_loading'
  input.task.snapshot.phaseDeadlineAt = new Date(Date.now() + 2000).toISOString()
  const runtime = { inspect: async (ref: { id: string }) => ({ ...ref, name: ref.id, running: true, restarts: ref.id === 'master' ? 2 : 5 }) } as unknown as ContainerRuntime
  await runStartupMonitor(input.app, { ...input, runtime, cavesRef, baselineRestarts: null,
    probe: async (ref, _shard, remote) => ({ worldReady: true, shardId: ref.id === 'master' ? '1' : '2', remoteConnected: remote === '2' ? true : null }) })
  assert.equal(input.task.snapshot.status, 'success')
  assert.equal(input.task.snapshot.caves.state, 'ready')
  assert.equal(input.cleanup.mock.callCount(), 0)
})

it('persists a newly started cave baseline before its first query', async (t) => {
  const input = await fixture(t)
  const cavesRef = { id: 'caves', name: 'caves' }
  const runtime = { inspect: async (ref: { id: string }) => ({ ...ref, name: ref.id, running: true, restarts: ref.id === 'master' ? 0 : 3 }) } as unknown as ContainerRuntime
  await runStartupMonitor(input.app, { ...input, runtime, baselineRestarts: 0,
    startCaves: async () => ({ ok: true as const, ref: cavesRef, baselineRestarts: 3 }),
    probe: async (ref, _shard, remote) => {
      if (ref.id === 'caves') assert.equal((await getGameInstanceById(input.task.instanceId))?.lastStartupReport?.caves.restartBaseline, 3)
      return { worldReady: true, shardId: ref.id === 'master' ? '1' : '2', remoteConnected: remote === '2' ? true : null }
    } })
  assert.equal(input.task.snapshot.status, 'success')
  assert.equal(input.task.snapshot.caves.restartBaseline, 3)
})

it('saves a master OOM during cave loading before cleanup removes the unit', async (t) => {
  const input = await fixture(t)
  const cavesRef = { id: 'caves', name: 'caves' }
  let cavesStarted = false
  let removed = false
  input.task.snapshot.settings = { masterMemoryMb: 1536, cavesMemoryMb: 1536, shardReadyWaitSec: 300 }
  const healthy = { ...emptyResourceSnapshot(), memoryCurrentMb: 800, memoryPeakMb: 900, memoryMaxMb: 2560, maxEvents: 0, oomKillCount: 0, oomKilled: false, exitCode: 0, restarts: 0 }
  const oom = { ...healthy, memoryCurrentMb: 0, memoryPeakMb: 1536, maxEvents: 19, oomKillCount: 1, oomKilled: true, exitCode: 9 }
  const runtime = {
    inspect: async (ref: { id: string }) => ref.id === 'master' && cavesStarted
      ? { ...input.masterRef, running: true, restarting: true, exitResult: 'oom-kill', exitCode: 9, restarts: 0 }
      : { ...ref, name: ref.id, running: true, restarts: 0 },
    resourceSnapshot: async (ref: { id: string }) => removed ? emptyResourceSnapshot() : ref.id === 'master' ? cavesStarted ? oom : healthy : { ...emptyResourceSnapshot(), memoryCurrentMb: 300, oomKillCount: 0, oomKilled: false },
  } as unknown as ContainerRuntime
  const cleanup = t.mock.fn(async () => {
    const saved = (await getGameInstanceById(input.task.instanceId))?.lastStartupReport
    assert.equal(saved?.diagnosis?.code, 'oom')
    assert.match(saved?.diagnosis?.message ?? '', /实际内存硬上限 2560 MiB/)
    assert.doesNotMatch(saved?.diagnosis?.message ?? '', /1536/)
    assert.equal(saved?.master.state, 'failed')
    assert.equal(saved?.master.resources?.oomKilled, true)
    assert.equal(saved?.master.resources?.exitCode, 9)
    assert.equal(saved?.master.resourceDeltas?.oomKillCount, 1)
    assert.equal(saved?.master.memoryPeakMb, 1536)
    removed = true
  })
  await runStartupMonitor(input.app, { ...input, runtime, cleanup, baselineRestarts: 0,
    startCaves: async () => { cavesStarted = true; return { ok: true as const, ref: cavesRef, baselineRestarts: 0 } },
    probe: async (ref) => ({ worldReady: ref.id === 'master', shardId: ref.id === 'master' ? '1' : '2', remoteConnected: null }) })
  const row = await getGameInstanceById(input.task.instanceId)
  assert.equal(cleanup.mock.callCount(), 1)
  assert.equal(row?.runtimeFailureKind, 'memory')
  assert.equal(row?.lastExitCode, 9)
  assert.equal(row?.lastStartupReport?.master.resources?.oomKilled, true)
  assert.equal((await runtime.resourceSnapshot!(input.masterRef)).oomKilled, null)
  assert.ok(instanceConsoleLogStore.listLogs(input.task.instanceId, 0, 100).some(line => line.text.includes('运行时结果：oom-kill')))

  // 新启动重新捕获本轮基线，不继承上一轮 OOM 或峰值。
  const next = createStartupTask(input.task.instanceId)
  t.after(() => releaseStartupTask(next))
  await runStartupMonitor(input.app, { ...input, task: next, baselineRestarts: 0,
    runtime: { inspect: async () => ({ ...input.masterRef, running: true, restarts: 0 }), resourceSnapshot: async () => healthy } as unknown as ContainerRuntime,
    probe: async () => ({ worldReady: true, shardId: '1', remoteConnected: null }) })
  assert.equal(next.snapshot.status, 'success')
  assert.notEqual(next.snapshot.taskId, input.task.snapshot.taskId)
  assert.equal(next.snapshot.master.resourceBaseline?.oomKillCount, 0)
  assert.equal(next.snapshot.master.resourceDeltas?.oomKillCount, 0)
  assert.equal(next.snapshot.master.memoryPeakMb, 900)
})

it('saves a recovered master OOM even when only inspect can still read the exit result', async (t) => {
  const input = await fixture(t)
  input.task.snapshot.master.state = 'ready'
  input.task.snapshot.master.restartBaseline = 0
  input.task.snapshot.settings = { masterMemoryMb: 5120, cavesMemoryMb: null, shardReadyWaitSec: 300 }
  input.task.snapshot.master.resourceBaseline = { ...emptyResourceSnapshot(), oomKillCount: 0 }
  const cleanup = t.mock.fn(async () => {
    const saved = (await getGameInstanceById(input.task.instanceId))?.lastStartupReport
    assert.equal(saved?.diagnosis?.code, 'oom')
    assert.match(saved?.diagnosis?.message ?? '', /实际内存硬上限未读取/)
    assert.doesNotMatch(saved?.diagnosis?.message ?? '', /5120/)
    assert.equal(saved?.master.state, 'failed')
    assert.equal(saved?.master.resources?.oomKilled, true)
    assert.equal(saved?.master.resources?.exitCode, 9)
  })
  const probe = t.mock.fn(async () => ({ worldReady: true, shardId: '1', remoteConnected: null }))
  await runStartupMonitor(input.app, { ...input, cleanup, probe, baselineRestarts: 0,
    runtime: { inspect: async () => ({ ...input.masterRef, running: true, restarting: true, exitResult: 'oom-kill', exitCode: 9 }), resourceSnapshot: async () => emptyResourceSnapshot() } as unknown as ContainerRuntime })
  assert.equal(input.task.snapshot.status, 'failed')
  assert.equal(probe.mock.callCount(), 0)
  assert.equal(cleanup.mock.callCount(), 1)
  assert.equal((await getGameInstanceById(input.task.instanceId))?.runtimeFailureKind, 'memory')
})

it('uses the cave actual cap and saves its OOM evidence before cleaning up different-cap shards', async (t) => {
  const input = await fixture(t)
  const cavesRef = { id: 'caves', name: 'caves' }
  input.task.snapshot.settings = { masterMemoryMb: 5120, cavesMemoryMb: 1536, shardReadyWaitSec: 300 }
  let caveOom = false
  const masterResources = { ...emptyResourceSnapshot(), memoryCurrentMb: 1500, memoryPeakMb: 1800, memoryMaxMb: 3072, oomKillCount: 0, oomKilled: false, exitCode: 0 }
  const caveResources = { ...emptyResourceSnapshot(), memoryCurrentMb: 800, memoryPeakMb: 1000, memoryMaxMb: 2048, maxEvents: 0, oomKillCount: 0, oomKilled: false, exitCode: 0 }
  const runtime = {
    inspect: async (ref: { id: string }) => ref.id === 'caves' && caveOom
      ? { ...cavesRef, running: true, restarting: true, exitResult: 'oom-kill', exitCode: 9, restarts: 0 }
      : { ...ref, name: ref.id, running: true, restarts: 0 },
    resourceSnapshot: async (ref: { id: string }) => ref.id === 'master' ? masterResources : caveOom
      ? { ...caveResources, memoryCurrentMb: 0, memoryPeakMb: 2048, maxEvents: 35, oomKillCount: 1, oomKilled: true, exitCode: 9 }
      : caveResources,
  } as unknown as ContainerRuntime
  const cleanup = t.mock.fn(async (refs: Array<{ id: string, name: string }>) => {
    assert.deepEqual(refs, [cavesRef, input.masterRef])
    const saved = (await getGameInstanceById(input.task.instanceId))?.lastStartupReport
    assert.equal(saved?.diagnosis?.code, 'oom')
    assert.match(saved?.diagnosis?.message ?? '', /洞穴.*实际内存硬上限 2048 MiB/)
    assert.doesNotMatch(saved?.diagnosis?.message ?? '', /3072|5120|1536/)
    assert.equal(saved?.master.state, 'ready')
    assert.equal(saved?.master.resources?.memoryMaxMb, 3072)
    assert.equal(saved?.caves.state, 'failed')
    assert.equal(saved?.caves.resources?.oomKilled, true)
    assert.equal(saved?.caves.resources?.exitCode, 9)
    assert.equal(saved?.caves.resourceBaseline?.oomKillCount, 0)
    assert.equal(saved?.caves.resourceDeltas?.oomKillCount, 1)
    assert.equal(saved?.caves.resourceDeltas?.maxEvents, 35)
    assert.equal(saved?.caves.memoryPeakMb, 2048)
  })
  await runStartupMonitor(input.app, { ...input, runtime, cleanup, baselineRestarts: 0,
    startCaves: async () => ({ ok: true as const, ref: cavesRef, baselineRestarts: 0 }),
    probe: async (ref) => {
      if (ref.id === 'caves') caveOom = true
      return { worldReady: ref.id === 'master', shardId: ref.id === 'master' ? '1' : '2', remoteConnected: null }
    } })
  const row = await getGameInstanceById(input.task.instanceId)
  assert.equal(cleanup.mock.callCount(), 1)
  assert.equal(row?.runtimeFailureKind, 'memory')
  assert.equal(row?.lastExitCode, 9)
  assert.match(row?.runtimeWarning ?? '', /洞穴.*实际内存硬上限 2048 MiB/)
})

it('keeps the last measured master evidence when the unit disappears during cave loading', async (t) => {
  const input = await fixture(t)
  let missing = false
  const measured = { ...emptyResourceSnapshot(), memoryPeakMb: 1100, memoryMaxMb: 1536, oomKillCount: 0, oomKilled: false, exitCode: 0 }
  input.task.snapshot.master.state = 'ready'
  input.task.snapshot.master.resources = measured
  const cleanup = t.mock.fn(async () => {
    const saved = (await getGameInstanceById(input.task.instanceId))?.lastStartupReport
    assert.equal(saved?.diagnosis?.code, 'master_exited')
    assert.deepEqual(saved?.master.resources, measured)
  })
  await runStartupMonitor(input.app, { ...input, cleanup, baselineRestarts: 0,
    runtime: {
      inspect: async (ref: { id: string }) => ({ ...ref, name: ref.id, running: !(missing && ref.id === 'master') }),
      resourceSnapshot: async () => emptyResourceSnapshot(),
    } as unknown as ContainerRuntime,
    startCaves: async () => { missing = true; return { ok: true as const, ref: { id: 'caves', name: 'caves' }, baselineRestarts: 0 } },
    probe: async () => ({ worldReady: true, shardId: '1', remoteConnected: true }) })
  assert.equal(input.task.snapshot.status, 'failed')
  assert.equal(input.task.snapshot.master.state, 'failed')
  assert.equal(cleanup.mock.callCount(), 1)
})
