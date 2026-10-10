import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { after, before, it, type TestContext } from 'node:test'
import Fastify from 'fastify'
import { buildMasterContainerName, getContainerRuntime, type ContainerRef, type ContainerRuntime, type LogOpts, type ShardContainerSpec } from '../../infra/container'
import { emptyResourceSnapshot } from '../../infra/container/dst-container-resources'
import { closeDatabase, createGameInstance, deleteGameInstanceById, getGameInstanceById, initDatabase, updateGameInstanceRuntime } from '../../shared/db'
import { bumpCavesStartGeneration, ensureInstanceContainerLogFollow, startCavesAfterMasterReady } from './container-lifecycle'
import { reconcileInstanceRuntimeState } from './runtime-reconciliation'
import { instanceConsoleLogStore } from '../../shared/instance-runtime/console-log-store'
import { currentStartupTask, persistStartupTask, releaseStartupTask } from './startup-state'

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

async function pendingCavesStart(t: TestContext, name: string) {
  const app = Fastify()
  t.after(() => app.close())
  const instance = await createGameInstance({ nodeId: 'local-node', name, gameCode: '343050', status: 'running' })
  t.after(() => {
    bumpCavesStartGeneration(instance.id)
    const task = currentStartupTask(instance.id)
    if (task) releaseStartupTask(task)
    instanceConsoleLogStore.removeInstance(instance.id)
    return deleteGameInstanceById(instance.id)
  })
  const startedAt = new Date(Date.now() - 1000).toISOString()
  const installPath = path.join(dir, instance.id)
  const masterName = buildMasterContainerName(instance.id)
  const masterRef = { id: `${masterName}.service`, name: masterName }
  await updateGameInstanceRuntime(instance.id, { containerId: masterRef.id, runtimeStartedAt: startedAt })
  const runtime = getContainerRuntime() as ContainerRuntime & Required<Pick<ContainerRuntime, 'resourceSnapshot'>>
  t.mock.method(runtime, 'findByName', async (name: string) => name === masterName ? masterRef : undefined)
  t.mock.method(runtime, 'inspect', async () => ({ ...masterRef, running: true, restarts: 0 }))
  t.mock.method(runtime, 'execStdin', async () => ({ exitCode: 0, output: '' }))
  t.mock.method(runtime, 'resourceSnapshot', async () => emptyResourceSnapshot())
  t.mock.method(runtime, 'removeShardNetwork', async () => {})
  const stop = t.mock.method(runtime, 'stop', async () => {})
  const remove = t.mock.method(runtime, 'remove', async () => {})
  const cavesSpec: ShardContainerSpec = {
    instanceId: instance.id, shard: 'caves', image: 'test', name: `${masterName}-caves`,
    hostInstallPath: installPath, workingDir: installPath, cmd: ['/test/game'],
  }
  const startCaves = t.mock.fn(async () => ({ ok: true as const, ref: { id: 'test-caves', name: 'test-caves' } }))
  const input = {
    instanceId: instance.id, installPath, masterRef, cavesSpec,
    generation: bumpCavesStartGeneration(instance.id), baselineRestarts: 0, startedAt, startCaves,
  }
  return { app, instance, runtime, input, stop, remove, startCaves }
}

it('取消等待中的洞穴任务立即退出，不停止分片或改写当前实例', async (t) => {
  const { app, instance, runtime, input, stop, remove, startCaves } = await pendingCavesStart(t, 'cancel-caves')
  const before = await getGameInstanceById(instance.id)
  let inspected!: () => void
  const probeStarted = new Promise<void>((resolve) => { inspected = resolve })
  t.mock.method(runtime, 'inspect', async () => {
    inspected()
    return { ...input.masterRef, running: true }
  })
  const task = startCavesAfterMasterReady(app, input)
  await probeStarted
  await delay(20)
  const cancelledAt = Date.now()
  bumpCavesStartGeneration(instance.id)
  await task
  const startup = currentStartupTask(instance.id)
  assert.ok(startup)
  await persistStartupTask(startup)
  assert.ok(Date.now() - cancelledAt < 1000, '取消应立即中断两秒等待')
  assert.equal(startCaves.mock.callCount(), 0)
  assert.equal(stop.mock.callCount(), 0)
  assert.equal(remove.mock.callCount(), 0)
  const after = await getGameInstanceById(instance.id)
  assert.deepEqual({ ...after, lastStartupReport: null, updatedAt: before?.updatedAt }, before)
  assert.ok(Date.parse(after!.updatedAt) >= Date.parse(before!.updatedAt), '检查点持久化只允许改变报告与更新时间')
  assert.equal(after?.lastStartupReport?.status, 'cancelled')
  assert.equal(after?.lastStartupReport?.phase, 'cancelled')
  assert.equal(instanceConsoleLogStore.listLogs(instance.id).length, 0)
})

it('实际就绪超时会中止日志跟随、清理主世界并保存启动错误', async (t) => {
  const previousWait = process.env.BSP_SHARD_READY_WAIT_SEC
  process.env.BSP_SHARD_READY_WAIT_SEC = '1'
  t.after(() => {
    if (previousWait === undefined) delete process.env.BSP_SHARD_READY_WAIT_SEC
    else process.env.BSP_SHARD_READY_WAIT_SEC = previousWait
  })
  const { app, instance, runtime, input, stop, remove, startCaves } = await pendingCavesStart(t, 'timeout-caves')
  let followSignal: AbortSignal | undefined
  let followFinished = false
  t.mock.method(runtime, 'logs', async function* (_ref: ContainerRef, opts: LogOpts = {}) {
    followSignal = opts.signal
    yield { stream: 'stdout' as const, text: 'Loading test world' }
    await new Promise<void>((resolve) => {
      if (opts.signal?.aborted) resolve()
      else opts.signal?.addEventListener('abort', () => resolve(), { once: true })
    })
    followFinished = true
  })
  await ensureInstanceContainerLogFollow(instance.id)
  assert.equal(followSignal?.aborted, false)
  await startCavesAfterMasterReady(app, input)
  const failed = await getGameInstanceById(instance.id)
  assert.equal(followSignal?.aborted, true)
  assert.equal(followFinished, true)
  assert.equal(startCaves.mock.callCount(), 0)
  assert.equal(stop.mock.callCount(), 1)
  assert.equal(remove.mock.callCount(), 1)
  assert.equal(failed?.status, 'error')
  assert.equal(failed?.containerId, null)
  assert.equal(failed?.runtimeStartedAt, null)
  assert.equal(failed?.runtimeReadyAt, null)
  assert.equal(failed?.lastErrorPhase, 'runtime')
  assert.match(failed?.lastError ?? '', /主世界等待就绪超时（1 秒）/)
  assert.equal(failed?.lastError, `启动失败：${failed?.runtimeWarning}`)
  assert.equal(failed?.lastStartupReport?.status, 'failed')
  assert.equal(failed?.lastStartupReport?.diagnosis?.code, 'probe_unavailable')
  assert.equal(failed?.lastStartupReport?.master.state, 'failed')
})

it('失败清理期间出现新启动时不移除新的分片或覆盖实例状态', async (t) => {
  const { app, instance, runtime, input, remove, startCaves } = await pendingCavesStart(t, 'restart-during-cleanup')
  instanceConsoleLogStore.appendDockerLine(instance.id, 'LUA ERROR stack traceback:', 'master')
  const newStartedAt = new Date().toISOString()
  let restarted: Awaited<ReturnType<typeof getGameInstanceById>>
  let messagesBeforeRestart: string[] = []
  t.mock.method(runtime, 'stop', async () => {
    assert.equal((await getGameInstanceById(instance.id))?.lastStartupReport?.diagnosis?.code, 'lua_error')
    messagesBeforeRestart = instanceConsoleLogStore.listLogs(instance.id).filter(line => line.stream === 'system').map(line => line.text)
    assert.equal(messagesBeforeRestart.filter(text => /启动失败/.test(text)).length, 1, '失败日志先于清理保存')
    bumpCavesStartGeneration(instance.id)
    await updateGameInstanceRuntime(instance.id, {
      status: 'running', containerId: 'new-master.service', runtimeStartedAt: newStartedAt,
      lastError: null, runtimeWarning: null,
    })
    restarted = await getGameInstanceById(instance.id)
  })
  await startCavesAfterMasterReady(app, input)
  assert.ok(restarted, '致命错误应进入失败清理')
  assert.equal(startCaves.mock.callCount(), 0)
  assert.equal(remove.mock.callCount(), 0, '新启动接管后不能移除同名分片')
  assert.deepEqual(await getGameInstanceById(instance.id), restarted)
  assert.deepEqual(instanceConsoleLogStore.listLogs(instance.id).filter(line => line.stream === 'system').map(line => line.text), messagesBeforeRestart, '新启动接管后不能追加旧任务失败消息')
})
