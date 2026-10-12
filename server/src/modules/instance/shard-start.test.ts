import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { after, before, it, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import Fastify from 'fastify'
import Docker from 'dockerode'
import { getContainerRuntime, buildMasterContainerName, buildCavesContainerName, type ContainerRuntime, type ContainerRef, type ShardContainerSpec, type LogOpts } from '../../infra/container'
import { emptyResourceSnapshot } from '../../infra/container/dst-container-resources'
import { ensureDstClusterConfig, ensureDstCavesShardConfig } from '../../infra/game-adapter/dst/cluster-config'
import { buildServerIni } from '../../infra/game-adapter/dst/server-ini'
import { readMasterServerIniFields, readCavesServerIniFields } from '../../infra/game-adapter/dst/shard-service'
import { resolveMasterServerIniPath, resolveCavesServerIniPath } from '../../infra/game-adapter/dst/shard-layout'
import { validateShardPortsForStart } from '../../infra/game-adapter/dst/port-conflict'
import { closeDatabase, createGameInstance, deleteGameInstanceById, getGameInstanceById, initDatabase, updateGameInstanceRuntime } from '../../shared/db'
import { instanceConsoleLogStore } from '../../shared/instance-runtime/console-log-store'
import { startInstanceContainer, stopInstanceContainer, protectInstanceMemory, stopFailedCaves, recoverInstanceStartup, runtimeMemoryEpoch } from './container-lifecycle'
import { currentStartupTask, releaseStartupTask } from './startup-state'
import { reconcileInstanceRuntimeState } from './runtime-reconciliation'
import { restartInstanceCore } from './restart-instance-core'
import { reconcileUnexpectedExits } from './exit-watch'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-shard-start-'))
before(async () => {
  process.env.BSP_UNIT_TEST = '1'
  await initDatabase(path.join(directory, 'fixture.sqlite'), path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle'), { adminUsername: 'admin', adminPassword: '123456', seedDevelopmentUsers: false })
})
after(() => { closeDatabase(); fs.rmSync(directory, { recursive: true, force: true }) })

async function until(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 2500
  while (Date.now() < deadline) { if (await predicate()) return; await delay(10) }
  assert.fail('后台分片任务未按预期完成')
}

async function occupyShardPorts(t: TestContext, installPath: string, occupyCaves = false) {
  const sockets = new Set<dgram.Socket>()
  t.after(async () => {
    for (const socket of sockets) await new Promise<void>(resolve => socket.close(resolve))
  })
  const ports: number[] = []
  const caveSockets: dgram.Socket[] = []
  for (let i = 0; i < 6; i++) {
    const socket = dgram.createSocket('udp4')
    await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.bind(0, '0.0.0.0', resolve) })
    sockets.add(socket)
    ports.push(socket.address().port)
    if (i >= 3) caveSockets.push(socket)
  }
  const master = { ...readMasterServerIniFields(installPath), serverPort: ports[0], steamAuthPort: ports[1], steamMasterPort: ports[2] }
  const caves = { ...readCavesServerIniFields(installPath)!, serverPort: ports[3], steamAuthPort: ports[4], steamMasterPort: ports[5] }
  fs.writeFileSync(resolveMasterServerIniPath(installPath), buildServerIni(master))
  fs.writeFileSync(resolveCavesServerIniPath(installPath), buildServerIni(caves))
  const releaseCaves = async () => {
    for (const socket of caveSockets) {
      if (sockets.delete(socket)) await new Promise<void>(resolve => socket.close(resolve))
    }
  }
  if (!occupyCaves) await releaseCaves()
  return { master, caves, releaseCaves }
}

async function fixture(t: TestContext, mode: 'native' | 'docker', readyMaster = false) {
  const env = { ...process.env }
  process.env.BSP_RUNTIME_MODE = mode
  process.env.BSP_HOST_MIN_AVAILABLE_MB = '0'
  const app = Fastify()
  const id = randomUUID()
  const installPath = path.join(directory, id)
  const instance = await createGameInstance({ id, installPath, nodeId: 'local-node', name: `shard-${mode}`, gameCode: '343050', status: readyMaster ? 'running' : 'stopped' })
  fs.mkdirSync(path.join(installPath, 'bin64'), { recursive: true })
  fs.writeFileSync(path.join(installPath, 'bin64/dontstarve_dedicated_server_nullrenderer_x64'), '')
  const clusterPath = ensureDstClusterConfig(installPath, { instanceName: instance.name })
  const ini = path.join(clusterPath, 'DoNotStarveTogether/Cluster_1/cluster.ini')
  fs.writeFileSync(ini, fs.readFileSync(ini, 'utf8').replace('shard_enabled = false', 'shard_enabled = true'))
  ensureDstCavesShardConfig(installPath)
  const refs = new Map<string, ContainerRef>()
  const runtime = getContainerRuntime() as ContainerRuntime & Required<Pick<ContainerRuntime, 'resourceSnapshot' | 'hostResources' | 'emergencyRemove'>>
  const masterName = buildMasterContainerName(instance.id)
  const masterAt = new Date(Date.now() - 60_000).toISOString()
  if (readyMaster) {
    refs.set(masterName, { id: 'healthy-master', name: masterName, runtimeIdentity: 'master-round' })
    await updateGameInstanceRuntime(instance.id, { containerId: 'healthy-master', runtimeStartedAt: masterAt, runtimeReadyAt: masterAt,
      lastStartupReport: { taskId: 'old-round', status: 'success', phase: 'ready', startedAt: masterAt, updatedAt: masterAt,
        phaseStartedAt: masterAt, phaseDeadlineAt: null, elapsedSeconds: 1, remainingSeconds: null, diagnosis: null,
        master: { state: 'ready', startedAt: masterAt, readyAt: masterAt, memoryPeakMb: 2000, memoryAndSwapPeakMb: 2500, restartBaseline: 0,
          resources: { ...emptyResourceSnapshot(), runtimeIdentity: 'master-round' }, resourceBaseline: { ...emptyResourceSnapshot(), runtimeIdentity: 'master-round', oomKillCount: 4 } },
        caves: { state: 'stopped', memoryPeakMb: 1536, peakLimited: true } } })
  }
  const create = t.mock.method(runtime, 'createShardContainer', async (spec: ShardContainerSpec) => {
    assert.equal(spec.networkName, 'shared-network')
    const ref = { id: `${spec.shard}-new`, name: spec.name, runtimeIdentity: `${spec.shard}-round` }
    refs.set(ref.name, ref); return ref
  })
  t.mock.method(runtime, 'findByName', async (name: string) => refs.get(name))
  t.mock.method(runtime, 'inspect', async (ref: ContainerRef) => ({ ...ref, running: refs.has(ref.name), restarts: 0, runtimeIdentity: ref.runtimeIdentity, startedAt: masterAt }))
  t.mock.method(runtime, 'resourceSnapshot', async (ref: ContainerRef) => ({ ...emptyResourceSnapshot(), runtimeIdentity: ref.runtimeIdentity, memoryCurrentMb: 1500, memoryPeakMb: 3000, memoryMaxMb: 4096, oomKillCount: ref.name === masterName ? 4 : 0 }))
  t.mock.method(runtime, 'hostResources', async () => null)
  t.mock.method(runtime, 'ensureShardNetwork', async () => 'shared-network')
  const networkRemove = t.mock.method(runtime, 'removeShardNetwork', async () => {})
  const stop = t.mock.method(runtime, 'stop', async () => {})
  const remove = t.mock.method(runtime, 'remove', async (ref: ContainerRef) => { refs.delete(ref.name) })
  t.mock.method(runtime, 'emergencyRemove', async (ref: ContainerRef) => { refs.delete(ref.name) })
  t.mock.method(runtime, 'start', async () => {})
  t.mock.method(Docker.prototype, 'getImage', () => ({ inspect: async () => ({ Id: 'fixture-image' }) }) as never)
  t.mock.method(runtime, 'logs', async function* (_ref: ContainerRef, options: LogOpts = {}) {
    yield { stream: 'stdout' as const, text: 'Loading fixture' }
    await new Promise<void>(resolve => {
      if (options.signal?.aborted) resolve()
      else options.signal?.addEventListener('abort', () => resolve(), { once: true })
    })
  })
  t.mock.method(runtime, 'execStdin', async (ref: ContainerRef, command: string) => {
    const token = /BSPSTART:([a-f0-9-]{36})\|/.exec(command)?.[1]
    assert.ok(token)
    const role = ref.name === masterName ? 'master' : 'caves'
    instanceConsoleLogStore.appendDockerLine(instance.id, `BSPSTART:${token}|1|${role === 'master' ? '1' : 'actual-cave-id'}|1`, role)
    return { exitCode: 0, output: '' }
  })
  t.after(async () => {
    t.mock.method(runtime, 'remove', async (ref: ContainerRef) => { refs.delete(ref.name) })
    await stopInstanceContainer(instance.id)
    const task = currentStartupTask(instance.id); if (task) releaseStartupTask(task)
    instanceConsoleLogStore.removeInstance(instance.id)
    await deleteGameInstanceById(instance.id); await app.close()
    for (const key of ['BSP_RUNTIME_MODE', 'BSP_HOST_MIN_AVAILABLE_MB']) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key] }
  })
  const input = { instanceId: instance.id, instanceName: instance.name, installPath, gameCode: instance.gameCode, gamePort: null, source: 'manual' as const }
  return { app, instance, input, refs, runtime, create, stop, remove, networkRemove, masterAt, masterName }
}

for (const mode of ['native', 'docker'] as const) {
  it(`${mode}: 主世界确认退出后停止失去依赖的洞穴并清理共享网络`, async t => {
    const f = await fixture(t, mode, true)
    const caveName = buildCavesContainerName(f.instance.id)
    f.refs.set(caveName, { id: 'caves-old', name: caveName, runtimeIdentity: 'caves-round' })
    await updateGameInstanceRuntime(f.instance.id, { runtimeStartedAt: new Date(Date.now() - 120_000).toISOString() })
    t.mock.method(f.runtime, 'inspect', async (ref: ContainerRef) => ({ ...ref, running: ref.name === caveName, restarts: 0, runtimeIdentity: ref.runtimeIdentity }))
    assert.equal(await reconcileUnexpectedExits(f.app), 1)
    const row = (await getGameInstanceById(f.instance.id))!
    assert.equal(row.status, 'stopped')
    assert.equal(row.runtimeReadyAt, null)
    assert.match(row.lastError ?? '', /主世界异常退出.*洞穴/)
    assert.equal(f.refs.size, 0)
    assert.equal(f.networkRemove.mock.callCount(), 1)
  })

  it(`${mode}: 主世界单独启动，洞穴补启动保留主世界身份、基线、峰值和就绪时间`, async t => {
    const f = await fixture(t, mode)
    const accepted = await startInstanceContainer(f.app, { ...f.input, target: 'master' })
    assert.equal(accepted.ok, true)
    await until(async () => (await getGameInstanceById(f.instance.id))?.lastStartupReport?.status === 'success')
    assert.equal(f.create.mock.callCount(), 1)
    assert.equal(f.create.mock.calls[0]?.arguments[0].shard, 'master')
    await occupyShardPorts(t, f.input.installPath)
    const before = (await getGameInstanceById(f.instance.id))!
    const resumed = await startInstanceContainer(f.app, { ...f.input, target: 'caves' })
    assert.equal(resumed.ok, true)
    assert.equal((await startInstanceContainer(f.app, { ...f.input, target: 'caves' })).ok, false)
    await until(async () => (await getGameInstanceById(f.instance.id))?.lastStartupReport?.caves.state === 'ready')
    const after = (await getGameInstanceById(f.instance.id))!
    assert.equal(f.create.mock.callCount(), 2)
    assert.equal(f.create.mock.calls[1]?.arguments[0].shard, 'caves')
    assert.equal(after.containerId, before.containerId)
    assert.equal(after.runtimeStartedAt, before.runtimeStartedAt)
    assert.equal(after.runtimeReadyAt, before.runtimeReadyAt)
    assert.equal(after.lastStartupReport?.master.memoryPeakMb, before.lastStartupReport?.master.memoryPeakMb)
    assert.deepEqual(after.lastStartupReport?.master.resourceBaseline, before.lastStartupReport?.master.resourceBaseline)
    assert.equal(after.lastStartupReport?.target, 'caves')
    assert.equal(f.stop.mock.callCount(), 0)
    assert.equal(f.networkRemove.mock.callCount(), 0)
  })

  it(`${mode}: 整体启动补齐缺失洞穴，洞穴创建失败保留健康主世界`, async t => {
    const f = await fixture(t, mode, true)
    await occupyShardPorts(t, f.input.installPath)
    const createShard = f.runtime.createShardContainer.bind(f.runtime)
    t.mock.method(f.runtime, 'createShardContainer', async (spec: ShardContainerSpec) => { assert.equal(spec.shard, 'caves'); throw new Error('fixture create failed') })
    assert.equal((await startInstanceContainer(f.app, f.input)).ok, true)
    await until(async () => (await getGameInstanceById(f.instance.id))?.lastStartupReport?.status === 'failed')
    const saved = (await getGameInstanceById(f.instance.id))!
    assert.match(saved.lastError ?? '', /fixture create failed/)
    assert.equal(saved.status, 'running')
    assert.equal(saved.containerId, 'healthy-master')
    assert.equal(saved.runtimeReadyAt, f.masterAt)
    assert.equal(saved.lastStartupReport?.master.memoryPeakMb, 2000)
    assert.equal(saved.lastStartupReport?.master.memoryAndSwapPeakMb, 2500)
    assert.equal(saved.lastStartupReport?.caves.cleanupCompleted, true)
    t.mock.method(f.runtime, 'createShardContainer', createShard)
    assert.equal((await startInstanceContainer(f.app, { ...f.input, target: 'caves' })).ok, true)
    await until(async () => (await getGameInstanceById(f.instance.id))?.lastStartupReport?.caves.state === 'ready')
    const retried = (await getGameInstanceById(f.instance.id))!
    assert.equal(retried.containerId, saved.containerId)
    assert.equal(retried.runtimeStartedAt, saved.runtimeStartedAt)
    assert.equal(retried.runtimeReadyAt, saved.runtimeReadyAt)
    assert.deepEqual(retried.lastStartupReport?.master.resourceBaseline, saved.lastStartupReport?.master.resourceBaseline)
    assert.equal(f.stop.mock.callCount(), 0)
    assert.equal(f.networkRemove.mock.callCount(), 0)
  })

  it(`${mode}: 洞穴端口真实占用时补启动失败，释放后重试保留主世界`, async t => {
    const f = await fixture(t, mode, true)
    const { caves, releaseCaves } = await occupyShardPorts(t, f.input.installPath, true)
    assert.equal((await startInstanceContainer(f.app, { ...f.input, target: 'caves' })).ok, true)
    await until(async () => (await getGameInstanceById(f.instance.id))?.lastStartupReport?.status === 'failed')
    const failed = (await getGameInstanceById(f.instance.id))!
    assert.match(failed.lastError ?? '', new RegExp(`端口 ${caves.serverPort}、${caves.steamAuthPort}、${caves.steamMasterPort} 已被占用`))
    assert.equal(failed.status, 'running')
    assert.equal(failed.containerId, 'healthy-master')
    assert.equal(f.create.mock.callCount(), 0)
    await releaseCaves()
    assert.equal((await startInstanceContainer(f.app, { ...f.input, target: 'caves' })).ok, true)
    await until(async () => (await getGameInstanceById(f.instance.id))?.lastStartupReport?.caves.state === 'ready')
    const retried = (await getGameInstanceById(f.instance.id))!
    assert.equal(retried.containerId, failed.containerId)
    assert.equal(retried.runtimeStartedAt, failed.runtimeStartedAt)
    assert.equal(retried.runtimeReadyAt, failed.runtimeReadyAt)
    assert.equal(f.create.mock.calls[0]?.arguments[0].shard, 'caves')
    assert.equal(f.stop.mock.callCount(), 0)
    assert.equal(f.networkRemove.mock.callCount(), 0)
  })

  it(`${mode}: 其它运行实例预留洞穴端口时拒绝补启动并保留主世界`, async t => {
    const f = await fixture(t, mode, true)
    const { caves } = await occupyShardPorts(t, f.input.installPath)
    const otherPath = path.join(directory, randomUUID())
    ensureDstClusterConfig(otherPath, {})
    fs.writeFileSync(resolveMasterServerIniPath(otherPath), buildServerIni({ ...readMasterServerIniFields(otherPath), serverPort: caves.serverPort }))
    const other = await createGameInstance({ installPath: otherPath, nodeId: 'local-node', name: 'port-owner', gameCode: '343050', status: 'running' })
    t.after(async () => { await deleteGameInstanceById(other.id) })
    assert.equal((await startInstanceContainer(f.app, { ...f.input, target: 'caves' })).ok, true)
    await until(async () => (await getGameInstanceById(f.instance.id))?.lastStartupReport?.status === 'failed')
    const failed = (await getGameInstanceById(f.instance.id))!
    assert.match(failed.lastError ?? '', new RegExp(`端口 ${caves.serverPort} 已被同节点上运行中的其它实例占用`))
    assert.equal(failed.status, 'running')
    assert.equal(failed.containerId, 'healthy-master')
    assert.equal(failed.runtimeReadyAt, f.masterAt)
    assert.equal(f.create.mock.callCount(), 0)
    assert.equal(f.stop.mock.callCount(), 0)
    assert.equal(f.networkRemove.mock.callCount(), 0)
  })

  it(`${mode}: 洞穴保护停机保留主世界，自动重启与恢复不能解除保护锁`, async t => {
    const f = await fixture(t, mode, true)
    const caveName = buildCavesContainerName(f.instance.id)
    f.refs.set(caveName, { id: 'caves-old', name: caveName, runtimeIdentity: 'caves-round' })
    const row = (await getGameInstanceById(f.instance.id))!
    await protectInstanceMemory(f.app, row, { code: 'oom', message: '洞穴 OOM', master: null,
      caves: { ...emptyResourceSnapshot(), runtimeIdentity: 'caves-round' }, host: null }, undefined, 'caves')
    const saved = (await getGameInstanceById(f.instance.id))!
    assert.equal(saved.status, 'running')
    assert.equal(saved.runtimeReadyAt, f.masterAt)
    assert.equal(saved.lastStartupReport?.status, 'success')
    assert.equal(saved.lastStartupReport?.caves.protectionStop?.cleanupCompleted, true)
    assert.equal(f.refs.size, 1)
    const automatic = await restartInstanceCore(f.app, { headers: {}, id: 'internal', url: '/internal' } as never, row.id, { source: 'automatic' })
    assert.ok('error' in automatic && automatic.error)
    assert.equal((await startInstanceContainer(f.app, { ...f.input, target: 'caves', source: 'automatic' })).ok, false)
    await recoverInstanceStartup(f.app, saved)
    await reconcileInstanceRuntimeState(f.app)
    assert.equal(f.refs.size, 1)
    assert.equal(f.stop.mock.callCount(), 0)
    assert.equal((await startInstanceContainer(f.app, { ...f.input, target: 'caves' })).ok, true)
    await until(async () => (await getGameInstanceById(f.instance.id))?.lastStartupReport?.caves.state === 'ready')
    assert.equal((await getGameInstanceById(f.instance.id))?.lastStartupReport?.caves.protectionStop, undefined)
  })

  it(`${mode}: 洞穴清理失败禁止重复启动，不关闭主世界或删除共享网络`, async t => {
    const f = await fixture(t, mode, true)
    const caveName = buildCavesContainerName(f.instance.id)
    f.refs.set(caveName, { id: 'caves-old', name: caveName, runtimeIdentity: 'caves-round' })
    t.mock.method(f.runtime, 'remove', async () => { throw new Error('cleanup failed') })
    await stopFailedCaves(f.app, (await getGameInstanceById(f.instance.id))!, 'lua_error', '洞穴 Lua 错误')
    const row = (await getGameInstanceById(f.instance.id))!
    assert.equal(row.status, 'running')
    assert.equal(row.runtimeReadyAt, f.masterAt)
    assert.equal(row.lastStartupReport?.caves.cleanupCompleted, false)
    assert.equal((await startInstanceContainer(f.app, { ...f.input, target: 'caves' })).ok, false)
    assert.equal(f.stop.mock.calls[0]?.arguments[0]?.name, caveName)
    assert.equal(f.networkRemove.mock.callCount(), 0)
  })
}

it('冷启动仍检查主世界占用端口，洞穴补启动只检查洞穴的预留端口', async t => {
  const f = await fixture(t, 'native')
  const { master, caves } = await occupyShardPorts(t, f.input.installPath)
  assert.match(await validateShardPortsForStart(master, caves) ?? '', /已被占用/)
  const reservedPorts = new Set([master.serverPort])
  assert.match(await validateShardPortsForStart(master, caves, { reservedPorts }) ?? '', /其它实例占用/)
  assert.equal(await validateShardPortsForStart(null, caves, { reservedPorts }), undefined)
  assert.equal((await startInstanceContainer(f.app, { ...f.input, target: 'master' })).ok, true)
  await until(async () => (await getGameInstanceById(f.instance.id))?.lastStartupReport?.status === 'failed')
  assert.equal(f.create.mock.callCount(), 0)
})

it('主世界尚未运行时拒绝单独洞穴启动，且不创建任何分片', async t => {
  const f = await fixture(t, 'native')
  const result = await startInstanceContainer(f.app, { ...f.input, target: 'caves' })
  assert.equal(result.ok, false)
  assert.equal(f.create.mock.callCount(), 0)
})

it('旧轮次的异常退出清理不能停止新轮次主世界', async t => {
  const f = await fixture(t, 'native', true)
  const observed = (await getGameInstanceById(f.instance.id))!
  await updateGameInstanceRuntime(f.instance.id, { runtimeStartedAt: new Date().toISOString() })
  assert.equal(await stopInstanceContainer(f.instance.id, runtimeMemoryEpoch(observed)), false)
  assert.equal(f.stop.mock.callCount(), 0)
  assert.equal(f.networkRemove.mock.callCount(), 0)
  assert.equal((await getGameInstanceById(f.instance.id))?.containerId, 'healthy-master')
})

it('洞穴任务出队后确认主世界已退出时不得保留运行中状态', async t => {
  const f = await fixture(t, 'native', true)
  t.mock.method(f.runtime, 'ensureShardNetwork', async () => { f.refs.delete(f.masterName); return 'shared-network' })
  assert.equal((await startInstanceContainer(f.app, { ...f.input, target: 'caves' })).ok, true)
  await until(async () => (await getGameInstanceById(f.instance.id))?.lastStartupReport?.status === 'failed')
  const row = (await getGameInstanceById(f.instance.id))!
  assert.equal(row.status, 'error')
  assert.equal(row.runtimeReadyAt, null)
  assert.equal(row.lastStartupReport?.master.state, 'failed')
  assert.equal(f.create.mock.callCount(), 0)
})

it('洞穴补启动准备阶段的主世界探测失败保留未知，后续查询恢复后成功', async t => {
  const f = await fixture(t, 'native', true)
  let masterReads = 0
  t.mock.method(f.runtime, 'inspect', async (ref: ContainerRef) => {
    const probeFailed = ref.name === f.masterName && ++masterReads === 2
    return { ...ref, running: !probeFailed, probeFailed, restarts: 0, runtimeIdentity: ref.runtimeIdentity }
  })
  assert.equal((await startInstanceContainer(f.app, { ...f.input, target: 'caves' })).ok, true)
  await until(async () => (await getGameInstanceById(f.instance.id))?.lastStartupReport?.status === 'success')
  assert.equal(f.stop.mock.callCount(), 0)
  assert.equal((await getGameInstanceById(f.instance.id))?.runtimeReadyAt, f.masterAt)
})
