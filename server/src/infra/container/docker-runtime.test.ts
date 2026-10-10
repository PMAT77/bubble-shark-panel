import assert from 'node:assert/strict'
import { it } from 'node:test'
import type Docker from 'dockerode'
import type { ContainerCreateOptions } from 'dockerode'
import { DockerContainerRuntime } from './docker-runtime'
import { buildHostResourceSnapshot } from './memory-budget'
import { emptyResourceSnapshot } from './dst-container-resources'

it('Docker shard overrides preserve CPU and explicitly allow host swap', async (t) => {
  const runtime = new DockerContainerRuntime()
  const docker = (runtime as unknown as { docker: Docker }).docker
  t.mock.method(runtime, 'findByName', async () => undefined)
  const previous = process.env.BSP_DST_CONTAINER_CPU_QUOTA
  process.env.BSP_DST_CONTAINER_CPU_QUOTA = '1.5'
  t.after(() => {
    if (previous === undefined) delete process.env.BSP_DST_CONTAINER_CPU_QUOTA
    else process.env.BSP_DST_CONTAINER_CPU_QUOTA = previous
  })
  let created: ContainerCreateOptions | undefined
  t.mock.method(docker, 'createContainer', async (options: ContainerCreateOptions) => { created = options; return { id: 'fixture' } })
  const spec = { instanceId: 'test', shard: 'master' as const, image: 'test', name: 'test-master', hostInstallPath: '/fixture', workingDir: '/fixture', cmd: ['/fixture/game'], resourceLimits: { memory: 2560 * 1024 * 1024 } }
  await runtime.createShardContainer(spec)
  assert.equal(created?.HostConfig?.Memory, 2560 * 1024 * 1024)
  assert.equal(created?.HostConfig?.MemorySwap, -1)
  assert.equal(created?.HostConfig?.NanoCpus, 1_500_000_000)
  await runtime.createShardContainer({ ...spec, resourceLimits: { memory: 0 } })
  assert.equal(created?.HostConfig?.Memory, undefined)
  t.mock.method(runtime, 'hostResources', async () => buildHostResourceSnapshot({ source: 'docker-host', verified: true,
    meminfo: 'MemTotal: 6291456 kB', pool: { ...emptyResourceSnapshot(), memoryMaxMb: 5120 } }))
  await runtime.createShardContainer({ ...spec, memoryParent: 'bspdst.slice' })
  assert.equal(created?.HostConfig?.CgroupParent, 'bspdst.slice')
  await assert.rejects(runtime.createShardContainer({ ...spec, memoryParent: 'unsafe.slice' }), /父组无效/)
})

it('Docker inspect distinguishes unavailable runtime from missing unit and preserves OOM/restart evidence', async (t) => {
  const runtime = new DockerContainerRuntime()
  const docker = (runtime as unknown as { docker: Docker }).docker
  const ref = { id: 'fixture', name: 'fixture' }
  let mode = 'oom'
  const container = {
    inspect: async () => {
      if (mode === 'unavailable') throw new Error('connect ECONNREFUSED /var/run/docker.sock')
      if (mode === 'missing') throw new Error('No such container: fixture')
      return { Id: ref.id, Name: '/fixture', State: { Running: true, Restarting: false, OOMKilled: true, ExitCode: 137 }, RestartCount: 2, HostConfig: { Memory: 2560 * 1024 * 1024, MemorySwap: -1 } }
    },
    stats: async () => ({ memory_stats: { usage: 1800 * 1024 * 1024, max_usage: 2200 * 1024 * 1024 }, cpu_stats: { throttling_data: { throttled_time: 100000 } } }),
  }
  t.mock.method(docker, 'getContainer', () => container)
  const snapshot = await runtime.inspect(ref)
  assert.equal(snapshot.exitResult, 'oom-kill')
  assert.equal(snapshot.oomKilled, true)
  assert.equal(snapshot.exitCode, 137)
  assert.equal(snapshot.restarts, 2)
  const resources = await runtime.resourceSnapshot(ref)
  assert.equal(resources.memoryMaxMb, 2560)
  assert.equal(resources.memoryCurrentMb, 1800)
  assert.equal(resources.memoryPeakMb, 2200)
  assert.equal(resources.swapMaxMb, null)
  assert.equal(resources.throttledUsec, 100)
  assert.equal(resources.highEvents, null)
  mode = 'unavailable'
  assert.equal((await runtime.inspect(ref)).probeFailed, true)
  mode = 'missing'
  assert.equal((await runtime.inspect(ref)).probeFailed, undefined)
  assert.equal((await runtime.inspect(ref)).running, false)
})

it('Docker lookup returns missing only after a successful runtime query', async (t) => {
  const runtime = new DockerContainerRuntime()
  const docker = (runtime as unknown as { docker: Docker }).docker
  let unavailable = true
  t.mock.method(docker, 'listContainers', async () => {
    if (unavailable) throw new Error('connect ECONNREFUSED /var/run/docker.sock')
    return []
  })
  await assert.rejects(runtime.findByName('fixture'), /ECONNREFUSED/)
  unavailable = false
  assert.equal(await runtime.findByName('fixture'), undefined)
})

it('remote and rootless Docker never claim host protection from the panel namespace', async t => {
  const remote = new DockerContainerRuntime('tcp://remote:2375')
  assert.equal((await remote.hostResources()).source, 'unknown')
  const local = new DockerContainerRuntime('unix:///fixture.sock')
  const docker = (local as unknown as { docker: Docker }).docker
  t.mock.method(docker, 'info', async () => ({ CgroupDriver: 'systemd', CgroupVersion: '2', SecurityOptions: ['name=rootless'] }))
  assert.equal((await local.hostResources()).budget.state, 'unavailable')
})
