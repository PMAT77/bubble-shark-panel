import { shardNameCandidates } from './naming'
import { emptyResourceSnapshot, resolveDstContainerResourceLimits } from './dst-container-resources'
import { buildHostResourceSnapshot, DST_MEMORY_SLICE, readCgroupMemory, readText, sampleHostResources } from './memory-budget'
import type { ContainerCreateOptions } from 'dockerode'
import Docker from 'dockerode'
import { decodeDockerMultiplexLogChunk } from './docker-log'
import { isDockerUnavailableError, resolveDockerConnectOptions } from '../docker-connect'
import { buildInstanceShardNetworkName } from './instance-network'
import { resolveUptimeSecondsFromIso } from './uptime'
import type {
  ContainerInspect,
  ContainerRef,
  ContainerRuntime,
  ContainerStats,
  ExecResult,
  LogLine,
  LogOpts,
  ShardContainerSpec,
  RuntimeResourceSnapshot,
} from './types'

function mapPortBindings(ports: ShardContainerSpec['ports']) {
  if (!ports?.length) {
    return undefined
  }
  const bindings: NonNullable<ContainerCreateOptions['HostConfig']>['PortBindings'] = {}
  for (const port of ports) {
    const key = `${port.containerPort}/${port.protocol}`
    bindings[key] = [{ HostPort: String(port.hostPort) }]
  }
  return bindings
}

export class DockerContainerRuntime implements ContainerRuntime {
  private readonly docker: Docker
  private readonly localDaemon: boolean

  constructor(dockerHost?: string) {
    const options = resolveDockerConnectOptions(dockerHost)
    this.docker = new Docker(options)
    this.localDaemon = typeof options.socketPath === 'string' && options.socketPath.startsWith('/')
  }

  async ensureShardNetwork(instanceId: string): Promise<string> {
    const networkName = buildInstanceShardNetworkName(instanceId)
    const existing = await this.docker.listNetworks({
      filters: { name: shardNameCandidates(networkName) },
    })
    const exact = existing.find(item => shardNameCandidates(networkName).includes(item.Name))
    if (exact?.Id) {
      return exact.Name
    }
    await this.docker.createNetwork({
      Name: networkName,
      Driver: 'bridge',
      CheckDuplicate: true,
    })
    return networkName
  }

  async removeShardNetwork(instanceId: string): Promise<void> {
    const networkName = buildInstanceShardNetworkName(instanceId)
    const existing = await this.docker.listNetworks({
      filters: { name: shardNameCandidates(networkName) },
    })
    const match = existing.find(item => shardNameCandidates(networkName).includes(item.Name))
    if (!match?.Id) {
      return
    }
    try {
      const network = this.docker.getNetwork(match.Id)
      await network.remove()
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.toLowerCase().includes('active endpoints')) {
        throw error
      }
    }
  }

  async createShardContainer(spec: ShardContainerSpec): Promise<ContainerRef> {
    if (spec.memoryParent && spec.memoryParent !== DST_MEMORY_SLICE) throw new Error('共享内存父组无效')
    if (spec.memoryParent && (await this.hostResources()).budget.state !== 'protected') throw new Error('共享内存预算无法核验，请重新检查宿主配置')
    const existing = await this.findByName(spec.name)
    if (existing) {
      spec = { ...spec, name: existing.name }
      await this.remove(existing)
    }
    const containerGameRoot = spec.containerGameRoot ?? '/game'
    const binds = spec.hostBinds?.length
      ? spec.hostBinds
      : [`${spec.hostInstallPath}:${containerGameRoot}`]
    const resourceLimits = resolveDstContainerResourceLimits(spec.resourceLimits)
    const container = await this.docker.createContainer({
      name: spec.name,
      Image: spec.image,
      Cmd: spec.cmd,
      WorkingDir: spec.workingDir,
      Env: spec.env
        ? Object.entries(spec.env).map(([key, value]) => `${key}=${value}`)
        : undefined,
      HostConfig: {
        Binds: binds,
        PortBindings: mapPortBindings(spec.ports),
        RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 5 },
        ...(spec.memoryParent ? { CgroupParent: spec.memoryParent } : {}),
        ...(spec.networkName ? { NetworkMode: spec.networkName } : {}),
        ...(resourceLimits?.memory ? { Memory: resourceLimits.memory, MemorySwap: -1 } : {}),
        ...(resourceLimits?.nanoCpus ? { NanoCpus: resourceLimits.nanoCpus } : {}),
      },
      Tty: false,
      OpenStdin: true,
      StdinOnce: false,
    })
    return { id: container.id, name: spec.name }
  }

  async start(ref: ContainerRef): Promise<void> {
    const container = this.docker.getContainer(ref.id)
    await container.start()
  }

  async stop(ref: ContainerRef, timeoutSec = 10): Promise<void> {
    const container = this.docker.getContainer(ref.id)
    try {
      await container.stop({ t: timeoutSec })
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.toLowerCase().includes('not running')) {
        throw error
      }
    }
  }

  async remove(ref: ContainerRef): Promise<void> {
    const container = this.docker.getContainer(ref.id)
    try {
      await container.stop({ t: 5 })
    }
    catch {
      // already stopped
    }
    try {
      await container.remove({ force: true })
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.toLowerCase().includes('no such container')) {
        throw error
      }
    }
  }

  async emergencyRemove(ref: ContainerRef): Promise<void> {
    // 使用不可复用的容器 ID，清理旧轮次不会删除同名的新容器。
    const container = this.docker.getContainer(ref.id)
    if (ref.runtimeIdentity && (await container.inspect()).State.StartedAt !== ref.runtimeIdentity) throw new Error('容器运行身份已变化，保护清理已取消')
    await container.update({ RestartPolicy: { Name: 'no' } }).catch(() => undefined)
    await this.remove(ref)
  }

  async hostResources() {
    const unknown = (reason: string) => buildHostResourceSnapshot({ source: 'unknown', reason })
    if (!this.localDaemon) return unknown('远程 Docker 无法核验宿主机内存，共享保护不可用')
    const root = '/run/bsp-host/cgroup'
    const ownName = process.env.HOSTNAME?.trim()
    const meminfo = readText('/run/bsp-host/meminfo')
    if (!ownName || !meminfo || !readText(`${root}/cgroup.controllers`)) return unknown('宿主指标挂载或面板容器身份缺失，共享保护不可用')
    try {
      const info = await this.docker.info()
      if (info.CgroupDriver !== 'systemd' || info.CgroupVersion !== '2' || info.SecurityOptions?.some((value: string) => value.includes('rootless'))) {
        return unknown('共享保护需要宿主 rootful Docker、systemd 驱动和 cgroup v2')
      }
      const panel = await this.docker.getContainer(ownName).inspect()
      const group = `/system.slice/docker-${panel.Id}.scope`
      const pids = readText(`${root}${group}/cgroup.procs`)?.split(/\s+/)
      if (!panel.State.Pid || !pids?.includes(String(panel.State.Pid))) return unknown('宿主指标挂载与 Docker 节点身份未核验，按现有配置启动')
      return buildHostResourceSnapshot({
        source: 'docker-host', meminfo, psi: readText('/run/bsp-host/memory-pressure'),
        panel: readCgroupMemory(root, group), pool: readCgroupMemory(root, `/${DST_MEMORY_SLICE}`), verified: true,
      })
    }
    catch { return unknown('无法核验 Docker 宿主指标；请在宿主执行 sudo bsp setup-memory-budget 并检查只读指标挂载') }
  }

  async *logs(ref: ContainerRef, opts: LogOpts = {}): AsyncIterable<LogLine> {
    const container = this.docker.getContainer(ref.id)
    const baseOptions = {
      stdout: true,
      stderr: true,
      tail: opts.tail ?? 200,
      since: opts.since,
      timestamps: false,
    }
    if (!opts.follow) {
      const buffer = await container.logs({
        ...baseOptions,
        follow: false,
      })
      const { text } = decodeDockerMultiplexLogChunk(Buffer.alloc(0), buffer)
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) {
          yield { stream: 'stdout', text: line }
        }
      }
      return
    }
    const stream = await container.logs({
      ...baseOptions,
      follow: true,
    })
    const queue: LogLine[] = []
    let frameCarry: Buffer = Buffer.alloc(0)
    let done = false
    let error: Error | undefined
    let notify: (() => void) | undefined
    const wake = () => {
      notify?.()
      notify = undefined
    }
    const finish = () => {
      done = true
      wake()
    }
    stream.on('data', (chunk: Buffer) => {
      const decoded = decodeDockerMultiplexLogChunk(frameCarry, chunk)
      frameCarry = decoded.carry
      const text = decoded.text
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) {
          queue.push({ stream: 'stdout', text: line })
        }
      }
      wake()
    })
    stream.on('end', finish)
    stream.on('close', finish)
    stream.on('error', (err: Error) => {
      error = err
      finish()
    })
    if (opts.signal) {
      const signal = opts.signal
      if (signal.aborted) {
        finish()
      }
      else {
        signal.addEventListener('abort', finish, { once: true })
      }
    }
    try {
      while (!done || queue.length > 0) {
        if (error) {
          throw error
        }
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            notify = resolve
          })
          continue
        }
        yield queue.shift()!
      }
    }
    finally {
      // 消费方 break/return/异常退出时必须销毁底层流，否则 docker 连接句柄泄漏
      // dockerode 的 ReadableStream 类型声明缺失 destroy（运行时为 Node 流），此处收窄
      ;(stream as unknown as { destroy?: () => void }).destroy?.()
      opts.signal?.removeEventListener('abort', finish)
    }
  }

  async exec(ref: ContainerRef, cmd: string[]): Promise<ExecResult> {
    const container = this.docker.getContainer(ref.id)
    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
    })
    const stream = await exec.start({ hijack: true, stdin: false })
    const output = await readDockerStream(stream)
    const inspect = await exec.inspect()
    return {
      exitCode: inspect.ExitCode ?? -1,
      output,
    }
  }

  async execStdin(ref: ContainerRef, input: string): Promise<ExecResult> {
    const payload = input.endsWith('\n') ? input : `${input}\n`
    const container = this.docker.getContainer(ref.id)
    const exec = await container.exec({
      Cmd: ['sh', '-c', 'cat > /proc/1/fd/0'],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
    })
    const stream = await exec.start({ hijack: true, stdin: true })
    stream.write(payload)
    stream.end()
    const output = await readDockerStream(stream)
    const inspect = await exec.inspect()
    return {
      exitCode: inspect.ExitCode ?? -1,
      output,
    }
  }

  async inspect(ref: ContainerRef): Promise<ContainerInspect> {
    try {
      const container = this.docker.getContainer(ref.id)
      const data = await container.inspect()
      const running = Boolean(data.State?.Running || data.State?.Restarting)
      const uptimeSeconds = resolveUptimeSecondsFromIso(data.State?.StartedAt)
      return {
        id: data.Id,
        name: data.Name?.replace(/^\//, '') ?? ref.name,
        running,
        restarting: Boolean(data.State?.Restarting),
        restarts: data.RestartCount ?? 0,
        exitCode: data.State?.ExitCode,
        oomKilled: Boolean(data.State?.OOMKilled),
        ...(data.State?.OOMKilled ? { exitResult: 'oom-kill' } : {}),
        startedAt: data.State?.StartedAt,
        ...(data.State?.StartedAt ? { runtimeIdentity: data.State.StartedAt } : {}),
        ...(uptimeSeconds !== undefined ? { uptimeSeconds } : {}),
      }
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isDockerUnavailableError(error) || message.toLowerCase().includes('no such container')) {
        return {
          id: ref.id,
          name: ref.name,
          running: false,
          ...(isDockerUnavailableError(error) ? { probeFailed: true } : {}),
        }
      }
      throw error
    }
  }

  async stats(ref: ContainerRef): Promise<ContainerStats> {
    const container = this.docker.getContainer(ref.id)
    const stats = await container.stats({ stream: false }) as {
      cpu_stats?: { cpu_usage?: { total_usage?: number }, system_cpu_usage?: number, online_cpus?: number }
      precpu_stats?: { cpu_usage?: { total_usage?: number }, system_cpu_usage?: number }
      memory_stats?: { usage?: number }
    }
    const cpuDelta = (stats.cpu_stats?.cpu_usage?.total_usage ?? 0)
      - (stats.precpu_stats?.cpu_usage?.total_usage ?? 0)
    const systemDelta = (stats.cpu_stats?.system_cpu_usage ?? 0)
      - (stats.precpu_stats?.system_cpu_usage ?? 0)
    const onlineCpus = stats.cpu_stats?.online_cpus ?? 1
    const cpuUsageRate = systemDelta > 0
      ? Math.min(100, Math.max(0, (cpuDelta / systemDelta) * onlineCpus * 100))
      : null
    const memoryMb = stats.memory_stats?.usage
      ? Math.round(stats.memory_stats.usage / 1024 / 1024)
      : null
    // 运行时长取容器自己的 StartedAt：容器被自动拉起后，面板记录的那个启动时刻不会更新，
    // 「刚崩过一次」会被读数盖住。问不到就为 null，由调用方退回面板记录的启动时刻。
    let uptimeSeconds: number | null = null
    try {
      uptimeSeconds = (await this.inspect(ref)).uptimeSeconds ?? null
    }
    catch {
      uptimeSeconds = null
    }
    return { cpuUsageRate, memoryMb, uptimeSeconds }
  }

  async resourceSnapshot(ref: ContainerRef): Promise<RuntimeResourceSnapshot> {
    const snapshot = emptyResourceSnapshot()
    try {
      const container = this.docker.getContainer(ref.id)
      const data = await container.inspect()
      const mb = (value: number | undefined): number | null => value === undefined || value < 0 ? null : Math.round(value / (1024 * 1024))
      snapshot.memoryMaxMb = data.HostConfig?.Memory ? mb(data.HostConfig.Memory) : null
      snapshot.memoryMaxState = data.HostConfig?.Memory == null ? 'unknown' : data.HostConfig.Memory > 0 ? 'finite' : 'unlimited'
      const totalSwap = data.HostConfig?.MemorySwap
      snapshot.swapMaxMb = totalSwap && totalSwap > 0 && data.HostConfig?.Memory
        ? mb(Math.max(0, totalSwap - data.HostConfig.Memory)) : null
      snapshot.exitCode = data.State?.ExitCode ?? null
      snapshot.restarts = data.RestartCount ?? null
      snapshot.oomKilled = data.State?.OOMKilled ?? null
      snapshot.memoryParent = data.HostConfig?.CgroupParent ?? null
      snapshot.runtimeIdentity = data.State?.StartedAt || null
      if (data.State?.Running) {
        const stats = await container.stats({ stream: false }) as {
          memory_stats?: { usage?: number, max_usage?: number, stats?: { swap?: number, total_swap?: number } }
          cpu_stats?: { throttling_data?: { throttled_time?: number } }
        }
        snapshot.memoryCurrentMb = mb(stats.memory_stats?.usage)
        snapshot.memoryPeakMb = mb(stats.memory_stats?.max_usage)
        snapshot.swapCurrentMb = mb(stats.memory_stats?.stats?.total_swap ?? stats.memory_stats?.stats?.swap)
        snapshot.throttledUsec = stats.cpu_stats?.throttling_data?.throttled_time === undefined
          ? null : stats.cpu_stats.throttling_data.throttled_time / 1000
        const host = await sampleHostResources(this)
        if (host?.source === 'docker-host') {
          const parent = data.HostConfig?.CgroupParent === DST_MEMORY_SLICE ? `/${DST_MEMORY_SLICE}` : '/system.slice'
          const group = `${parent}/docker-${data.Id}.scope`
          if (readText(`/run/bsp-host/cgroup${group}/cgroup.procs`)?.split(/\s+/).includes(String(data.State.Pid))) {
            const direct = readCgroupMemory('/run/bsp-host/cgroup', group)
            Object.assign(snapshot, direct, { exitCode: snapshot.exitCode, restarts: snapshot.restarts, oomKilled: snapshot.oomKilled, memoryParent: snapshot.memoryParent })
          }
        }
        if (snapshot.memoryCurrentMb != null && snapshot.swapCurrentMb != null) snapshot.memoryAndSwapPeakMb = snapshot.memoryCurrentMb + snapshot.swapCurrentMb
      }
    }
    catch { /* 运行时不支持或探测失败的字段保持 null。 */ }
    return snapshot
  }

  async findByName(name: string): Promise<ContainerRef | undefined> {
    const containers = await this.docker.listContainers({ all: true, filters: { name: shardNameCandidates(name) } })
    const names = shardNameCandidates(name)
    const match = names.map(candidate => containers.find(item => item.Names?.includes(`/${candidate}`))).find(Boolean)
    if (!match?.Id) {
      return undefined
    }
    return { id: match.Id, name: match.Names?.map(value => value.slice(1)).find(value => names.includes(value)) ?? name }
  }
}

async function readDockerStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.on('end', () => resolve())
    stream.on('error', reject)
  })
  return Buffer.concat(chunks).toString('utf8')
}
