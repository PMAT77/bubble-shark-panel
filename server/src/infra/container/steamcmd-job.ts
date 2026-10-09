import type Docker from 'dockerode'
import DockerClient from 'dockerode'
import { resolveDockerConnectOptions } from '../docker-connect'
import { getServerContainerConfig } from '../../shared/config/container'
import { buildSteamcmdContainerEnv, loadSteamcmdRuntimeConfig } from '../../shared/config/steamcmd'
import { decodeDockerMultiplexLogChunk } from './docker-log'
import { redactSteamcmdLogLine, steamcmdLogSecrets, STEAMCMD_TIMEOUT_MARKER, STEAMCMD_OOM_MARKER } from './steamcmd-errors'
import { formatSteamcmdTimeoutForLog } from '../../shared/config/steamcmd'
import { resolveSteamcmdContainerMemoryLimits } from './steamcmd-container-resources'
import { SteamcmdOutput } from './steamcmd-output'
import { collectDockerSteamcmdDiagnostics, steamcmdLogDirectory } from './steamcmd-log-diagnostics'
import { abortable } from '../../shared/abort'

export const STEAMCMD_LABEL_MANAGED = 'bsp.managed'
export const STEAMCMD_LABEL_MANAGED_VALUE = 'steamcmd-install'
export const STEAMCMD_LABEL_JOB = 'bsp.steamcmd.job'
export const STEAMCMD_LABEL_KIND = 'bsp.steamcmd.kind'


async function listManagedContainers(docker: Docker, options: { all?: boolean, filters: { label: string[] } }) {
  const current = await docker.listContainers(options)
  const legacy = await docker.listContainers({ ...options, filters: { label: options.filters.label.map(label => label.replace(/^bsp\./, 'gsh.')) } })
  return [...new Map([...current, ...legacy].map(item => [item.Id, item])).values()]
}

const activeSteamcmdInstallContainers = new Map<string, Docker.Container>()
const cancelledSteamcmdInstallKeys = new Set<string>()

function resolveDocker(): Docker {
  const { dockerHost } = getServerContainerConfig()
  return new DockerClient(resolveDockerConnectOptions(dockerHost))
}

function isDockerContainerNotRunningError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  return normalized.includes('not running')
    || normalized.includes('is not running')
    || normalized.includes('already stopped')
}

async function safeKillContainer(container: Docker.Container): Promise<void> {
  try {
    const inspect = await container.inspect()
    if (!inspect.State.Running) {
      return
    }
    await container.kill()
  }
  catch (error) {
    if (!isDockerContainerNotRunningError(error)) {
      throw error
    }
  }
}

export async function forceRemoveSteamcmdContainer(container: Docker.Container): Promise<boolean> {
  try {
    await safeKillContainer(container)
  }
  catch {
    // ignore cleanup errors
  }
  try {
    await container.remove({ force: true })
    return true
  }
  catch (error) {
    return (error as { statusCode?: number }).statusCode === 404
  }
}

function buildSteamcmdInstallContainerName(jobId?: string): string | undefined {
  if (!jobId?.trim()) {
    return undefined
  }
  const safeId = jobId.trim().replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 20)
  const suffix = Date.now().toString(36).slice(-6)
  return `bsp-steamcmd-${safeId || 'job'}-${suffix}`
}

/** 面板启动后回收受管 SteamCMD 容器，包括采集前重启留下的已停止任务。 */
export async function cleanupAllRunningSteamcmdInstallContainers(): Promise<number> {
  try {
    const docker = resolveDocker()
    const running = await listManagedContainers(docker, {
      all: true,
      filters: {
        label: [`${STEAMCMD_LABEL_MANAGED}=${STEAMCMD_LABEL_MANAGED_VALUE}`],
      },
    })
    let removed = 0
    for (const item of running) {
      try {
        await forceRemoveSteamcmdContainer(docker.getContainer(item.Id))
        removed += 1
      }
      catch {
        // best-effort
      }
    }
    return removed
  }
  catch {
    return 0
  }
}

/** 仅清理指定 job 的已停止 SteamCMD 任务容器（不扫全局镜像） */
export async function cleanupOrphanedSteamcmdInstallContainers(jobId?: string): Promise<number> {
  if (!jobId?.trim()) {
    return 0
  }
  try {
    const docker = resolveDocker()
    const byLabel = await listManagedContainers(docker, {
      all: true,
      filters: {
        label: [
          `${STEAMCMD_LABEL_MANAGED}=${STEAMCMD_LABEL_MANAGED_VALUE}`,
          `${STEAMCMD_LABEL_JOB}=${jobId.trim()}`,
        ],
      },
    })
    let removed = 0
    for (const item of byLabel) {
      if (item.State === 'running') {
        continue
      }
      try {
        await forceRemoveSteamcmdContainer(docker.getContainer(item.Id))
        removed += 1
      }
      catch {
        // best-effort
      }
    }
    return removed
  }
  catch {
    return 0
  }
}

/** 清理已停止的 app_info 一次性容器 */
export async function cleanupStoppedSteamcmdAppInfoContainers(): Promise<number> {
  try {
    const docker = resolveDocker()
    const byLabel = await listManagedContainers(docker, {
      all: true,
      filters: {
        label: [
          `${STEAMCMD_LABEL_MANAGED}=${STEAMCMD_LABEL_MANAGED_VALUE}`,
          `${STEAMCMD_LABEL_KIND}=app-info`,
        ],
      },
    })
    let removed = 0
    for (const item of byLabel) {
      if (item.State === 'running') {
        continue
      }
      try {
        await forceRemoveSteamcmdContainer(docker.getContainer(item.Id))
        removed += 1
      }
      catch {
        // best-effort
      }
    }
    return removed
  }
  catch {
    return 0
  }
}

export async function isSteamcmdJobRunning(jobId: string): Promise<boolean> {
  if (!jobId.trim()) {
    return false
  }
  try {
    const docker = resolveDocker()
    const containers = await listManagedContainers(docker, {
      filters: {
        label: [
          `${STEAMCMD_LABEL_MANAGED}=${STEAMCMD_LABEL_MANAGED_VALUE}`,
          `${STEAMCMD_LABEL_JOB}=${jobId.trim()}`,
        ],
      },
    })
    return containers.some(item => item.State === 'running')
  }
  catch {
    return false
  }
}

export function clearSteamcmdJobCancelFlag(jobId: string): void {
  cancelledSteamcmdInstallKeys.delete(jobId)
}

export async function cancelSteamcmdInstallContainer(cancelKey: string, verifyOrphans = false): Promise<void> {
  cancelledSteamcmdInstallKeys.add(cancelKey)
    const tracked = activeSteamcmdInstallContainers.get(cancelKey)
    if (tracked) {
      const removed = await abortable(forceRemoveSteamcmdContainer(tracked), AbortSignal.timeout(15_000))
      if (!removed) throw new Error('无法确认 Docker 安装任务已停止，请恢复 Docker 连接后再次停止')
      activeSteamcmdInstallContainers.delete(cancelKey)
    }
    if (!tracked && verifyOrphans) {
      const docker = resolveDocker()
      const containers = await abortable(listManagedContainers(docker, { all: true, filters: {
        label: [`${STEAMCMD_LABEL_MANAGED}=${STEAMCMD_LABEL_MANAGED_VALUE}`, `${STEAMCMD_LABEL_JOB}=${cancelKey}`],
      } }), AbortSignal.timeout(15_000))
      for (const item of containers) {
        const container = docker.getContainer(item.Id)
        activeSteamcmdInstallContainers.set(cancelKey, container)
        const removed = await abortable(forceRemoveSteamcmdContainer(container), AbortSignal.timeout(15_000))
        if (!removed) throw new Error('无法确认 Docker 安装任务已停止，请恢复 Docker 连接后再次停止')
        activeSteamcmdInstallContainers.delete(cancelKey)
      }
    }
}

export function hasUnconfirmedSteamcmdJob(jobId: string): boolean { return activeSteamcmdInstallContainers.has(jobId) }

export interface SteamcmdJobSpec {
  signal?: AbortSignal
  image: string
  cmd: string[]
  hostBinds?: string[]
  /** 与 install-path 中 chown 的 steam(1000) 一致；root 镜像若以 root 跑易出现 Missing file permissions */
  user?: string
  jobId?: string
  kind?: 'app-update' | 'app-info'
  timeoutMs: number
  onLogLine?: (line: string) => void
}

export interface SteamcmdJobResult {
  ok: boolean
  exitCode: number
  output: string
  cancelled?: boolean
  timedOut?: boolean
  /** undefined 表示 Docker 状态检查失败，不能据退出码推断。 */
  oomKilled?: boolean
}

async function followContainerLogs(
  container: Docker.Container,
  pushLine: (line: string) => void,
  acceptChunk: (text: string) => boolean,
): Promise<void> {
  const stream = await container.logs({
    follow: true,
    stdout: true,
    stderr: true,
    timestamps: false,
  })
  let buffer = ''
  let frameCarry: Buffer = Buffer.alloc(0)
  try {
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        try {
        const decoded = decodeDockerMultiplexLogChunk(frameCarry, chunk)
        frameCarry = decoded.carry
        if (!acceptChunk(decoded.text)) {
          buffer = ''
          return
        }
        buffer += decoded.text
        const lines = buffer.split(/\r\n|\r|\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const text = line.trim()
          if (text) {
            pushLine(text)
          }
        }
        }
        catch (error) { reject(error) }
      })
      stream.on('end', () => resolve())
      stream.on('error', reject)
    })
  }
  finally {
    // 容器被强杀/移除等异常路径下同样要销毁日志流，避免连接泄漏
    // dockerode 的 ReadableStream 类型声明缺失 destroy（运行时为 Node 流），此处收窄
    ;(stream as unknown as { destroy?: () => void }).destroy?.()
  }
  const tail = buffer.trim()
  if (tail) {
    pushLine(tail)
  }
}

export async function runSteamcmdJob(spec: SteamcmdJobSpec): Promise<SteamcmdJobResult> {
  spec.signal?.throwIfAborted()
  const docker = resolveDocker()
  const collected = new SteamcmdOutput(spec.kind === 'app-info')
  const steamcmdConfig = loadSteamcmdRuntimeConfig()
  const secrets = steamcmdLogSecrets(spec.cmd, [steamcmdConfig.httpProxy, steamcmdConfig.httpsProxy])
  let logDirectory: string | undefined
  const pushLine = (line: string) => {
    logDirectory = steamcmdLogDirectory(line) ?? logDirectory
    const text = redactSteamcmdLogLine(line, secrets)
    if (!text) {
      return
    }
    collected.push(text)
    spec.onLogLine?.(text)
  }

  const jobId = spec.jobId?.trim()
  const kind = spec.kind ?? 'app-update'

  if (jobId && cancelledSteamcmdInstallKeys.has(jobId)) {
    // 出队即检查：排队期间被取消的任务直接跳过并消费取消标记（保证后续重试不受影响）。
    cancelledSteamcmdInstallKeys.delete(jobId)
    return {
      ok: false,
      exitCode: -1,
      output: 'SteamCMD 任务已取消（排队期间被取消）',
      cancelled: true,
    }
  }

  if (jobId) {
    await cleanupOrphanedSteamcmdInstallContainers(jobId)
  }
  else if (kind === 'app-info') {
    await cleanupStoppedSteamcmdAppInfoContainers()
  }

  const labels: Record<string, string> = {
    [STEAMCMD_LABEL_MANAGED]: STEAMCMD_LABEL_MANAGED_VALUE,
    [STEAMCMD_LABEL_KIND]: kind,
  }
  if (jobId) {
    labels[STEAMCMD_LABEL_JOB] = jobId
  }

  const memoryLimits = resolveSteamcmdContainerMemoryLimits(
    spec.kind === 'app-info' ? 'app-info' : 'app-update',
  )
  const hostConfig: NonNullable<Docker.ContainerCreateOptions['HostConfig']> = {
    Binds: spec.hostBinds,
    AutoRemove: false,
    Ulimits: [{ Name: 'nofile', Soft: 65536, Hard: 65536 }],
    ...(memoryLimits
      ? { Memory: memoryLimits.Memory, MemorySwap: memoryLimits.MemorySwap }
      : {}),
    ...(steamcmdConfig.networkMode === 'host' ? { NetworkMode: 'host' } : {}),
    ...(steamcmdConfig.networkMode !== 'host' && [steamcmdConfig.httpProxy, steamcmdConfig.httpsProxy].some(proxy => {
      try { return new URL(proxy).hostname === 'host.docker.internal' } catch { return false }
    }) ? { ExtraHosts: ['host.docker.internal:host-gateway'] } : {}),
  }

  const containerEnv = buildSteamcmdContainerEnv(steamcmdConfig)

  if (jobId && cancelledSteamcmdInstallKeys.has(jobId)) {
    cancelledSteamcmdInstallKeys.delete(jobId)
    return { ok: false, exitCode: -1, output: 'SteamCMD 任务已取消（创建前被取消）', cancelled: true }
  }

  const containerName = buildSteamcmdInstallContainerName(jobId)
  spec.signal?.throwIfAborted()
  // 创建请求失败时不能证明 Docker 未创建资源，保留可按名称清理的占用记录。
  const provisional = containerName ? docker.getContainer(containerName) : undefined
  if (jobId && provisional) activeSteamcmdInstallContainers.set(jobId, provisional)
  let container: Docker.Container
  try {
  container = await docker.createContainer({
    name: containerName,
    Image: spec.image,
    Cmd: spec.cmd,
    User: spec.user,
    // v0.2.0 统一镜像 WORKDIR=/app；显式固定 steamcmd 工作目录以兼容 uid 1000 写入需求（与旧 steamcmd-base 镜像一致）。
    WorkingDir: '/home/steam/steamcmd',
    Env: containerEnv.length > 0 ? containerEnv : undefined,
    Labels: labels,
    HostConfig: hostConfig,
    AttachStdout: true,
    AttachStderr: true,
    abortSignal: spec.signal ? AbortSignal.any([spec.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  } as Docker.ContainerCreateOptions)
  }
  catch (error) {
    if (jobId && provisional) activeSteamcmdInstallContainers.set(jobId, provisional)
    throw error
  }

  if (jobId) {
    activeSteamcmdInstallContainers.set(jobId, container)
  }

  let exitCode = -1
  let timedOut = false
  let oomKilled: boolean | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let started = false
  let taskFailed = false
  const isCancelled = () => Boolean(spec.signal?.aborted || (jobId && cancelledSteamcmdInstallKeys.has(jobId)))
  const execution = new AbortController()
  const cancel = () => execution.abort(new Error('SteamCMD 任务已取消'))
  spec.signal?.addEventListener('abort', cancel, { once: true })
  if (spec.signal?.aborted) cancel()

  try {
    if (!isCancelled()) {
      await abortable(container.start(), AbortSignal.any([execution.signal, AbortSignal.timeout(15_000)]))
      started = true
      pushLine('SteamCMD 容器已启动')
      if (isCancelled()) await safeKillContainer(container)
      timeout = setTimeout(() => {
        timedOut = true
        execution.abort(new Error('SteamCMD 任务超时'))
        void safeKillContainer(container).catch(() => {})
      }, spec.timeoutMs)
      const waitPromise = container.wait().then(result => result.StatusCode ?? -1)
      const logsPromise = followContainerLogs(container, pushLine, text => collected.acceptChunk(text))
      try {
        const [code] = await abortable(Promise.all([waitPromise, logsPromise]), execution.signal)
        exitCode = code
      }
      catch (error) {
        await abortable(safeKillContainer(container), AbortSignal.timeout(15_000)).catch(() => {})
        const [waitResult] = await Promise.allSettled([abortable(waitPromise, AbortSignal.timeout(15_000)), abortable(logsPromise, AbortSignal.timeout(15_000))])
        if (waitResult.status === 'fulfilled') exitCode = waitResult.value
        throw error
      }
    }
  }
  catch (error) {
    taskFailed = true
    const message = error instanceof Error ? error.message : String(error)
    pushLine(`SteamCMD ${started ? '任务异常' : '容器启动失败'}: ${message}`)
  }
  finally {
    clearTimeout(timeout)
    spec.signal?.removeEventListener('abort', cancel)
    try {
      if (started) {
        try {
          const inspect = await abortable(container.inspect(), AbortSignal.timeout(15_000))
          oomKilled = inspect.State.OOMKilled
          if (oomKilled) pushLine(`${STEAMCMD_OOM_MARKER}: Docker 确认容器被 OOM 终止`)
        }
        catch {
          pushLine('[SteamCMD 诊断] Docker OOM 状态未知，不能据退出码推断')
        }
        if (timedOut) {
          pushLine(`${STEAMCMD_TIMEOUT_MARKER}: SteamCMD 任务超过 ${formatSteamcmdTimeoutForLog(spec.timeoutMs)} 上限，已终止容器；已下载内容保留，重试将断点续传`)
        }
        if (kind !== 'app-info' && (exitCode !== 0 || timedOut || oomKilled || taskFailed) && !isCancelled()) {
          await abortable(collectDockerSteamcmdDiagnostics(container, logDirectory, line => {
            const text = redactSteamcmdLogLine(line, secrets)
            if (text) {
              collected.pushDiagnostic(text)
              spec.onLogLine?.(text.startsWith('[SteamCMD 诊断]') ? text : `[SteamCMD 诊断] ${text}`)
            }
          }), AbortSignal.timeout(15_000)).catch(() => {})
        }
      }
    }
    finally {
      const removed = await abortable(forceRemoveSteamcmdContainer(container), AbortSignal.timeout(15_000)).catch(() => false)
      if (!removed) {
        taskFailed = true
        collected.push('无法确认 Docker 安装任务已停止，请恢复 Docker 连接后再次停止')
      }
      if (jobId && removed) activeSteamcmdInstallContainers.delete(jobId)
      if (jobId) {
        await abortable(cleanupOrphanedSteamcmdInstallContainers(jobId), AbortSignal.timeout(15_000)).catch(() => {})
      }
      else if (kind === 'app-info') {
        await cleanupStoppedSteamcmdAppInfoContainers()
      }
    }
  }

  const wasCancelled = isCancelled()
  if (wasCancelled && jobId) {
    cancelledSteamcmdInstallKeys.delete(jobId)
  }

  const output = collected.output
    || (timedOut ? 'SteamCMD 任务超时' : wasCancelled ? 'SteamCMD 任务已取消' : 'SteamCMD 任务执行失败')

  return {
    ok: exitCode === 0 && !timedOut && !wasCancelled && !oomKilled && !taskFailed && !collected.overflowed,
    exitCode,
    output,
    cancelled: wasCancelled,
    timedOut,
    oomKilled,
  }
}
