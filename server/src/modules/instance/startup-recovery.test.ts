import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, it, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import type { InstanceStartupSnapshot } from '../../../../shared/contracts/instance-resources'
import { buildMasterContainerName, getContainerRuntime, type ContainerRef, type ContainerRuntime, type LogOpts } from '../../infra/container'
import { emptyResourceSnapshot } from '../../infra/container/dst-container-resources'
import { closeDatabase, createGameInstance, deleteGameInstanceById, getGameInstanceById, initDatabase, updateGameInstanceRuntime } from '../../shared/db'
import { instanceConsoleLogStore } from '../../shared/instance-runtime/console-log-store'
import { recoverInstanceStartup, stopInstanceContainer } from './container-lifecycle'
import { reconcileInstanceRuntimeState } from './runtime-reconciliation'
import { createStartupTask, currentStartupTask, persistStartupTask, releaseStartupTask, suspendStartupTasks } from './startup-state'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-startup-recovery-'))
before(async () => {
  await initDatabase(path.join(dir, 'test.sqlite'), path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle'), {
    adminUsername: 'admin', adminPassword: '123456', seedDevelopmentUsers: false,
  })
})
after(() => { closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }) })

async function until(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 1500
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(10)
  }
  assert.fail(message)
}

async function fixture(t: TestContext, phase: InstanceStartupSnapshot['phase']) {
  const app = Fastify()
  const id = randomUUID()
  const installPath = path.join(dir, id)
  fs.mkdirSync(installPath)
  const masterRef = { id: `${id}-live-master`, name: buildMasterContainerName(id) }
  const instance = await createGameInstance({ id, nodeId: 'local-node', name: `recover-${phase}`, gameCode: '343050', status: 'running', installPath, containerId: masterRef.id })
  const seed = createStartupTask(id)
  const startedAt = new Date(Date.now() - 1000).toISOString()
  seed.snapshot = {
    ...seed.snapshot, status: 'running', phase, startedAt, phaseStartedAt: startedAt,
    phaseDeadlineAt: new Date(Date.now() + 3000).toISOString(),
    master: { state: 'loading', memoryPeakMb: null }, caves: { state: 'disabled', memoryPeakMb: null },
    settings: { masterMemoryMb: 2560, cavesMemoryMb: 2560, shardReadyWaitSec: 300 },
  }
  await updateGameInstanceRuntime(id, { runtimeStartedAt: startedAt })
  await persistStartupTask(seed)
  releaseStartupTask(seed)
  const report = structuredClone(seed.snapshot)
  const runtime = getContainerRuntime() as ContainerRuntime & Required<Pick<ContainerRuntime, 'resourceSnapshot'>>
  t.mock.method(runtime, 'findByName', async (name: string) => name === masterRef.name ? masterRef : undefined)
  const inspect = t.mock.method(runtime, 'inspect', async (ref: ContainerRef) => ({ ...ref, running: true, restarts: 5, startedAt, uptimeSeconds: 60 }))
  t.mock.method(runtime, 'resourceSnapshot', async () => ({ ...emptyResourceSnapshot(), memoryCurrentMb: 1200, memoryPeakMb: 2000, memoryMaxMb: 2560, restarts: 5, oomKillCount: 0 }))
  const create = t.mock.method(runtime, 'createShardContainer', async () => masterRef)
  const start = t.mock.method(runtime, 'start', async () => {})
  const stop = t.mock.method(runtime, 'stop', async () => {})
  const remove = t.mock.method(runtime, 'remove', async () => {})
  const network = t.mock.method(runtime, 'ensureShardNetwork', async () => 'fixture-network')
  t.mock.method(runtime, 'removeShardNetwork', async () => {})
  const followSignals: AbortSignal[] = []
  let followsFinished = 0
  t.mock.method(runtime, 'logs', async function* (_ref: ContainerRef, options: LogOpts = {}) {
    assert.ok(options.signal)
    followSignals.push(options.signal)
    yield { stream: 'stdout' as const, text: 'Loading recovery fixture' }
    await new Promise<void>((resolve) => {
      if (options.signal!.aborted) resolve()
      else options.signal!.addEventListener('abort', () => resolve(), { once: true })
    })
    followsFinished++
  })
  const respond = (command: string) => {
    const token = /BSPSTART:([a-f0-9-]{36})\|/.exec(command)?.[1]
    assert.ok(token, '恢复应使用带随机标记的游戏查询')
    instanceConsoleLogStore.appendDockerLine(id, `BSPSTART:${token}|1|1|x`, 'master')
  }
  const exec = t.mock.method(runtime, 'execStdin', async (ref: ContainerRef, command: string) => {
    assert.equal(ref.id, masterRef.id)
    respond(command)
    return { exitCode: 0, output: '' }
  })
  t.after(async () => {
    await stopInstanceContainer(id)
    const task = currentStartupTask(id)
    if (task) releaseStartupTask(task)
    instanceConsoleLogStore.removeInstance(id)
    await deleteGameInstanceById(id)
    await app.close()
  })
  const recover = async () => {
    const saved = await getGameInstanceById(id)
    assert.ok(saved)
    await recoverInstanceStartup(app, saved)
  }
  const waitForSuccess = () => until(async () => (await getGameInstanceById(id))?.lastStartupReport?.status === 'success', '恢复未成功完成')
  return { app, instance, seed, report, runtime, masterRef, inspect, create, start, stop, remove, network, exec, respond, followSignals, followsFinished: () => followsFinished, recover, waitForSuccess }
}

it('prepare 恢复发现活着的主世界时直接监控，单世界不重建或绑定容器', async (t) => {
  const f = await fixture(t, 'prepare')
  await f.recover()
  await f.waitForSuccess()
  assert.equal(f.create.mock.callCount(), 0)
  assert.equal(f.start.mock.callCount(), 0)
  assert.equal(f.stop.mock.callCount(), 0)
  assert.equal(f.remove.mock.callCount(), 0)
  assert.equal(f.network.mock.callCount(), 0)
  assert.equal(f.exec.mock.callCount(), 1)
  const saved = await getGameInstanceById(f.instance.id)
  assert.equal(saved?.containerId, f.masterRef.id)
  assert.equal(saved?.lastStartupReport?.taskId, f.report.taskId)
  assert.equal(saved?.lastStartupReport?.status, 'success')
  assert.equal(saved?.lastStartupReport?.caves.state, 'disabled')
  assert.ok(saved?.runtimeReadyAt)
})

it('master_loading 恢复保留已过期的期限，失败关闭日志而不再等待 300 秒', async (t) => {
  const f = await fixture(t, 'master_loading')
  const expired = new Date(Date.now() - 1000).toISOString()
  await updateGameInstanceRuntime(f.instance.id, { lastStartupReport: { ...f.report, phaseDeadlineAt: expired } })
  await f.recover()
  await until(async () => (await getGameInstanceById(f.instance.id))?.status === 'error', '恢复没有按过期期限失败')
  assert.equal(f.exec.mock.callCount(), 0)
  assert.equal(f.create.mock.callCount(), 0)
  assert.equal(f.start.mock.callCount(), 0)
  assert.equal(f.stop.mock.callCount(), 1)
  assert.equal(f.remove.mock.callCount(), 1)
  assert.equal(f.followSignals.length, 1)
  assert.equal(f.followSignals[0]?.aborted, true)
  await until(() => f.followsFinished() === 1, '失败没有关闭旧日志跟随')
  const saved = await getGameInstanceById(f.instance.id)
  assert.equal(saved?.lastStartupReport?.taskId, f.report.taskId)
  assert.equal(saved?.lastStartupReport?.diagnosis?.code, 'probe_unavailable')
  assert.equal(saved?.lastStartupReport?.status, 'failed')
  assert.equal(saved?.containerId, null)
  assert.equal(saved?.runtimeReadyAt, null)
})

it('恢复入口 runtime 查找失败保留报告与原期限并释放任务，后续可再次恢复', async (t) => {
  const f = await fixture(t, 'master_loading')
  const before = await getGameInstanceById(f.instance.id)
  let unavailable = true
  t.mock.method(f.runtime, 'findByName', async (name: string) => {
    if (unavailable) throw new Error('fixture runtime temporarily unavailable')
    return name === f.masterRef.name ? f.masterRef : undefined
  })
  await f.recover()
  await until(async () => !currentStartupTask(f.instance.id)
    && (await getGameInstanceById(f.instance.id))?.lastStartupReport?.diagnosis?.code === 'probe_unavailable', '恢复探测失败未释放任务')
  const unavailableSaved = await getGameInstanceById(f.instance.id)
  assert.deepEqual({ ...unavailableSaved, lastStartupReport: before?.lastStartupReport, updatedAt: before?.updatedAt }, before)
  assert.equal(unavailableSaved?.lastStartupReport?.taskId, f.report.taskId)
  assert.equal(unavailableSaved?.lastStartupReport?.phaseDeadlineAt, f.report.phaseDeadlineAt)
  assert.equal(unavailableSaved?.lastStartupReport?.status, 'running')
  assert.equal(f.stop.mock.callCount(), 0)
  assert.equal(f.remove.mock.callCount(), 0)
  unavailable = false
  await f.recover()
  await f.waitForSuccess()
  assert.equal((await getGameInstanceById(f.instance.id))?.lastStartupReport?.taskId, f.report.taskId)
  assert.equal(f.create.mock.callCount(), 0)
  assert.equal(f.start.mock.callCount(), 0)
})

it('面板暂停保存检查点，恢复沿用 taskId 和期限，列表对账不抢写活动任务', async (t) => {
  const f = await fixture(t, 'master_loading')
  const active = createStartupTask(f.instance.id, f.report)
  await suspendStartupTasks()
  assert.equal(active.controller.signal.aborted, true)
  assert.equal(currentStartupTask(f.instance.id), undefined)
  const suspended = await getGameInstanceById(f.instance.id)
  assert.equal(suspended?.lastStartupReport?.taskId, f.report.taskId)
  assert.equal(suspended?.lastStartupReport?.phaseDeadlineAt, f.report.phaseDeadlineAt)
  assert.equal(suspended?.lastStartupReport?.status, 'running')
  let command: string | undefined
  t.mock.method(f.runtime, 'execStdin', async (_ref: ContainerRef, input: string) => {
    assert.equal(currentStartupTask(f.instance.id)?.snapshot.phaseDeadlineAt, f.report.phaseDeadlineAt)
    command = input
    return { exitCode: 0, output: '' }
  })
  await f.recover()
  await until(() => command !== undefined, '恢复未开始游戏查询')
  const pending = await getGameInstanceById(f.instance.id)
  const inspections = f.inspect.mock.callCount()
  await reconcileInstanceRuntimeState(f.app)
  assert.equal(f.inspect.mock.callCount(), inspections, '旧对账不能重复探测并覆盖活动启动')
  assert.deepEqual(await getGameInstanceById(f.instance.id), pending)
  assert.ok(command)
  f.respond(command)
  await f.waitForSuccess()
  assert.equal((await getGameInstanceById(f.instance.id))?.lastStartupReport?.taskId, f.report.taskId)
  assert.equal(f.create.mock.callCount(), 0)
  assert.equal(f.start.mock.callCount(), 0)
})
