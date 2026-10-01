import { resolveDstContainerResourceLimits } from './dst-container-resources'
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

  constructor(dockerHost?: string) {
    this.docker = new Docker(resolveDockerConnectOptions(dockerHost))
  }

  async ensureShardNetwork(instanceId: string): Promise<string> {
    const networkName = buildInstanceShardNetworkName(instanceId)
    const existing = await this.docker.listNetworks({
      filters: { name: [networkName] },
    })
    const exact = existing.find(item => item.Name === networkName)
    if (exact?.Id) {
      return networkName
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
      filters: { name: [networkName] },
    })
    const match = existing.find(item => item.Name === networkName)
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
    const existing = await this.findByName(spec.name)
    if (existing) {
      await this.remove(existing)
    }
    const containerGameRoot = spec.containerGameRoot ?? '/game'
    const binds = spec.hostBinds?.length
      ? spec.hostBinds
      : [`${spec.hostInstallPath}:${containerGameRoot}`]
    const resourceLimits = resolveDstContainerResourceLimits()
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
        ...(spec.networkName ? { NetworkMode: spec.networkName } : {}),
        ...(resourceLimits?.memory ? { Memory: resourceLimits.memory } : {}),
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
      const running = Boolean(data.State?.Running)
      const uptimeSeconds = resolveUptimeSecondsFromIso(data.State?.StartedAt)
      return {
        id: data.Id,
        name: data.Name?.replace(/^\//, '') ?? ref.name,
        running,
        startedAt: data.State?.StartedAt,
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

  async findByName(name: string): Promise<ContainerRef | undefined> {
    try {
      const containers = await this.docker.listContainers({ all: true, filters: { name: [name] } })
      const match = containers.find(item => item.Names?.some(n => n === `/${name}` || n.endsWith(`/${name}`)))
      if (!match?.Id) {
        return undefined
      }
      return { id: match.Id, name }
    }
    catch (error) {
      if (isDockerUnavailableError(error)) {
        return undefined
      }
      throw error
    }
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
