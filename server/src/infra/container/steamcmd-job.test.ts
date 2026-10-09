import assert from 'node:assert/strict'
import { afterEach, describe, it, mock } from 'node:test'
import { Readable } from 'node:stream'
import DockerClient from 'dockerode'
import tar from 'tar-stream'
import {
  cleanupOrphanedSteamcmdInstallContainers, cleanupAllRunningSteamcmdInstallContainers,
  cancelSteamcmdInstallContainer, runSteamcmdJob,
} from './steamcmd-job.ts'
import { classifySteamcmdInstallFailure } from './steamcmd-errors'

const previousProxy = process.env.BSP_STEAMCMD_HTTPS_PROXY
afterEach(() => {
  mock.restoreAll()
  if (previousProxy === undefined) delete process.env.BSP_STEAMCMD_HTTPS_PROXY
  else process.env.BSP_STEAMCMD_HTTPS_PROXY = previousProxy
})

function fakeDocker(options: { text?: string, code?: number, oom?: boolean, inspectFails?: boolean, archiveFails?: boolean, duringCreate?: () => Promise<void>, duringStart?: () => Promise<void>, timeout?: boolean, startFails?: boolean } = {}) {
  const events: string[] = []
  let running = false
  let createOptions: DockerClient.ContainerCreateOptions | undefined
  let resolveWait!: (value: { StatusCode: number }) => void
  const wait = new Promise<{ StatusCode: number }>(resolve => { resolveWait = resolve })
  const container = {
    async start() {
      events.push('start')
      if (options.startFails) throw new Error('start refused')
      running = true
      await options.duringStart?.()
      if (!options.timeout) { running = false; resolveWait({ StatusCode: options.code ?? 8 }) }
    },
    async wait() { return wait },
    async logs() {
      const text = Buffer.from(options.text ?? "Logging directory: '/logs'\nError! App '343050' state is 0x402 after update job.\n")
      const header = Buffer.alloc(8)
      header[0] = 1
      header.writeUInt32BE(text.length, 4)
      const framed = Buffer.concat([header, text])
      return Readable.from([framed.subarray(0, 11), framed.subarray(11, 53), framed.subarray(53)])
    },
    async inspect() {
      events.push('inspect')
      if (options.inspectFails) throw new Error('inspect unavailable')
      return { State: { Running: running, OOMKilled: options.oom ?? false } }
    },
    async kill() { events.push('kill'); running = false; resolveWait({ StatusCode: 137 }) },
    async remove() { events.push('remove') },
    async getArchive(input: { path: string }) {
      events.push('archive')
      if (options.archiveFails) throw new Error('file unavailable')
      const pack = tar.pack()
      pack.entry({ name: input.path.split('/').at(-1)! }, 'CURRENT: download failed HTTP error 503\n')
      pack.finalize()
      return pack
    },
  }
  mock.method(DockerClient.prototype, 'listContainers', async () => [])
  mock.method(DockerClient.prototype, 'createContainer', async (spec: DockerClient.ContainerCreateOptions) => {
    createOptions = spec
    events.push('create')
    await options.duringCreate?.()
    return container
  })
  return { events, container, get createOptions() { return createOptions } }
}

const spec = { image: 'fixture', cmd: ['steamcmd', '+login', 'anonymous'], jobId: 'job-fixture', timeoutMs: 1000 }

it('inspects and collects diagnostics before removing containers, mapping host proxies', async () => {
  process.env.BSP_STEAMCMD_HTTPS_PROXY = 'http://host.docker.internal:7890'
  const fake = fakeDocker()
  const result = await runSteamcmdJob(spec)
  assert.equal(result.exitCode, 8)
  assert.equal(result.oomKilled, false)
  assert.equal(fake.createOptions?.HostConfig?.AutoRemove, false)
  assert.deepEqual(fake.createOptions?.HostConfig?.ExtraHosts, ['host.docker.internal:host-gateway'])
  assert.ok(fake.events.indexOf('inspect') < fake.events.indexOf('archive'))
  assert.ok(fake.events.indexOf('archive') < fake.events.indexOf('remove'))
  assert.match(result.output, /0x402/)
  assert.match(result.output, /HTTP error 503/)
})

it('does not infer OOM from 137 and keeps cleanup when diagnostic reads fail', async () => {
  for (const oom of [false, true]) {
    const fake = fakeDocker({ code: 137, oom, archiveFails: true })
    const result = await runSteamcmdJob(spec)
    assert.equal(result.oomKilled, oom)
    assert.equal(classifySteamcmdInstallFailure(result.output), oom ? 'oom' : 'incomplete')
    assert.ok(fake.events.includes('remove'))
    mock.restoreAll()
  }
  const fake = fakeDocker({ code: 137, inspectFails: true, archiveFails: true })
  const result = await runSteamcmdJob(spec)
  assert.equal(result.oomKilled, undefined)
  assert.match(result.output, /OOM 状态未知/)
  assert.ok(fake.events.includes('remove'))
})

it('honors cancellation arriving during create or start and cleans startup failures', async () => {
  let fake = fakeDocker({ duringCreate: () => cancelSteamcmdInstallContainer(spec.jobId) })
  let result = await runSteamcmdJob(spec)
  assert.equal(result.cancelled, true)
  assert.ok(!fake.events.includes('start'))
  assert.ok(fake.events.includes('remove'))
  mock.restoreAll()
  fake = fakeDocker({ duringStart: () => cancelSteamcmdInstallContainer(spec.jobId) })
  result = await runSteamcmdJob(spec)
  assert.equal(result.cancelled, true)
  assert.ok(fake.events.includes('kill'))
  assert.ok(fake.events.includes('remove'))
  mock.restoreAll()
  fake = fakeDocker({ startFails: true })
  result = await runSteamcmdJob(spec)
  assert.equal(result.ok, false)
  assert.match(result.output, /启动失败/)
  assert.ok(fake.events.includes('remove'))
})

it('collects timeout diagnostics without classifying the kill as OOM', async () => {
  const fake = fakeDocker({ timeout: true })
  const result = await runSteamcmdJob({ ...spec, timeoutMs: 20 })
  assert.equal(result.timedOut, true)
  assert.equal(result.oomKilled, false)
  assert.equal(classifySteamcmdInstallFailure(result.output), 'timeout')
  assert.ok(fake.events.indexOf('archive') < fake.events.indexOf('remove'))
})

it('cleans stopped managed containers on panel startup', async () => {
  const fake = fakeDocker()
  mock.method(DockerClient.prototype, 'listContainers', async () => [{ Id: 'stopped', State: 'exited' }])
  mock.method(DockerClient.prototype, 'getContainer', () => fake.container)
  assert.equal(await cleanupAllRunningSteamcmdInstallContainers(), 1)
  assert.ok(fake.events.includes('remove'))
})

it('does not mix diagnostics into successful app-info output', async () => {
  const fake = fakeDocker({ code: 0 })
  const result = await runSteamcmdJob({ ...spec, kind: 'app-info' })
  assert.equal(result.ok, true)
  assert.ok(!fake.events.includes('archive'))
  assert.doesNotMatch(result.output, /SteamCMD 诊断/)
})

it('does not report success when log transport fails even if the process exits zero', async () => {
  const fake = fakeDocker({ code: 0 })
  fake.container.logs = async () => { throw new Error('log transport unavailable') }
  const result = await runSteamcmdJob({ ...spec, kind: 'app-info' })
  assert.equal(result.ok, false)
  assert.equal(result.exitCode, 0)
  assert.match(result.output, /log transport unavailable/)
  assert.ok(fake.events.includes('remove'))
})

describe('cleanupOrphanedSteamcmdInstallContainers', () => {
  it('returns 0 when jobId is empty (no global sweep)', async () => {
    assert.equal(await cleanupOrphanedSteamcmdInstallContainers(), 0)
    assert.equal(await cleanupOrphanedSteamcmdInstallContainers('   '), 0)
  })
})

/**
 * dev:compose 手工验收清单：
 * 1. 删除残留 cm2network/steamcmd 容器；error 实例点「更新服务端」→ running 的 bsp-steamcmd-*，日志有 [xx%]
 * 2. 安装中 docker restart bubblesharkpanel-panel → 列表不再永久 installing，可再次更新
 * 3. 取消安装 → 再更新 → 不应秒退「安装已中断」
 */

it('splits Docker progress on carriage returns and fragmented frames without merging lines', async () => {
  const text = 'Update state (0x61) downloading, progress: 56.25\rUpdate state (0x61) downloading, progress: 70\r\nUpdate state (0x81) verifying update, progress: 2'
  fakeDocker({ code: 0, text })
  const received: string[] = []
  const result = await runSteamcmdJob({ image: 'fixture', cmd: ['+login', 'anonymous'], timeoutMs: 1000, onLogLine: line => received.push(line) })
  assert.equal(result.ok, true)
  for (const line of text.split(/\r\n|\r|\n/)) assert.ok(received.includes(line), line)
})
