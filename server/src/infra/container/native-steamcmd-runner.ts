import fs from 'node:fs'
import { validateSteamcmdAppUpdateResult } from './steamcmd-app-update-result'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { buildSteamcmdAppUpdateArgs, buildSteamcmdWorkshopDownloadArgs } from './steamcmd-args'
import { withSteamcmdAppUpdateLock } from './steamcmd-app-update-queue'
import { redactSteamcmdLogLine, steamcmdLogSecrets, STEAMCMD_TIMEOUT_MARKER } from './steamcmd-errors'
import { getServerContainerConfig } from '../../shared/config/container'
import {
  formatSteamcmdTimeoutForLog,
  formatSteamcmdDownloadRegionForLog,
  loadSteamcmdRuntimeConfig,
  resolveSteamcmdAppUpdateTimeoutMs,
} from '../../shared/config/steamcmd'
import { DST_WORKSHOP_APP_ID } from '../game-adapter/dst/constants'
import { SteamcmdOutput } from './steamcmd-output'
import { NativeSteamcmdLogDiagnostics } from './steamcmd-log-diagnostics'
import { registerNativeSteamcmdProcess, cancelRecordedNativeSteamcmdProcess } from './native-steamcmd-process'

const STEAMCMD_APP_INFO_TIMEOUT_MS = 90_000
const DEFAULT_STEAMCMD_WORKSHOP_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000

const activeNativeSteamcmdJobs = new Map<string, { child: ChildProcess, terminate: () => void }>()
const cancelledNativeSteamcmdJobs = new Set<string>()

interface NativeSteamcmdJobInput {
  args: string[]
  kind?: 'app-info' | 'app-update'
  cancelKey?: string
  timeoutMs: number
  onLogLine?: (line: string) => void
}

function buildSteamcmdEnv(): NodeJS.ProcessEnv {
  const config = loadSteamcmdRuntimeConfig()
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (config.httpProxy) {
    env.http_proxy = config.httpProxy
    env.HTTP_PROXY = config.httpProxy
  }
  if (config.httpsProxy) {
    env.https_proxy = config.httpsProxy
    env.HTTPS_PROXY = config.httpsProxy
  }
  if (config.noProxy) {
    env.no_proxy = config.noProxy
    env.NO_PROXY = config.noProxy
  }
  delete env.STEAMCMD_FORCE_DOWNLOAD_REGION
  return env
}

function buildSteamcmdAppInfoArgs(appId: string): string[] {
  return [
    '+@ShutdownOnFailedCommand',
    '1',
    '+@NoPromptForPassword',
    '1',
    '+login',
    'anonymous',
    '+app_info_update',
    '1',
    '+app_info_print',
    appId,
    '+quit',
  ]
}

export async function runNativeSteamcmdJob(input: NativeSteamcmdJobInput): Promise<{
  ok: boolean
  output: string
  cancelled?: boolean
  timedOut?: boolean
}> {
  const jobId = input.cancelKey?.trim()
  if (jobId && cancelledNativeSteamcmdJobs.has(jobId)) {
    cancelledNativeSteamcmdJobs.delete(jobId)
    return { ok: false, output: 'SteamCMD 任务已取消（启动前被取消）', cancelled: true }
  }
  const { nativeSteamcmdPath } = getServerContainerConfig()
  if (!fs.existsSync(nativeSteamcmdPath)) {
    return {
      ok: false,
      output: `SteamCMD 不存在: ${nativeSteamcmdPath}`,
    }
  }
  const collected = new SteamcmdOutput(input.kind === 'app-info')
  const config = loadSteamcmdRuntimeConfig()
  const secrets = steamcmdLogSecrets(input.args, [config.httpProxy, config.httpsProxy])
  const diagnostics = input.kind === 'app-info' ? undefined : new NativeSteamcmdLogDiagnostics(nativeSteamcmdPath)
  let logError: Error | undefined
  const pushLine = (raw: string) => {
    diagnostics?.observe(raw)
    const line = redactSteamcmdLogLine(raw, secrets)
    if (!line) {
      return
    }
    collected.push(line)
    try { input.onLogLine?.(line) }
    catch (error) {
      if (!logError) {
        logError = error instanceof Error ? error : new Error(String(error))
        collected.push(redactSteamcmdLogLine('安装日志写入失败：' + logError.message, secrets))
      }
      terminate()
    }
  }
  // 取消标记不在这里清除：排队取消依赖锁出队时检查（取消标记存活到出队）；
  // 重试场景的残留标记由 install-service.startInstallJob 在新任务启动时清理。
  const child = spawn(nativeSteamcmdPath, input.args, {
    cwd: path.dirname(nativeSteamcmdPath),
    env: buildSteamcmdEnv(),
    detached: process.platform === 'linux',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let stopDeadline: ReturnType<typeof setTimeout> | undefined
  let rejectStop!: (error: Error) => void
  const stopFailure = new Promise<never>((_, reject) => { rejectStop = reject })
  let termination: Promise<void> | undefined
  const signal = (value: NodeJS.Signals) => {
    try {
      if (process.platform === 'linux' && child.pid) process.kill(-child.pid, value)
      else child.kill(value)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  const terminate = () => {
    if (killTimer) return
    try { signal('SIGTERM') }
    catch { rejectStop(new Error('无法确认 Native 安装进程组已停止，请再次停止实例')); return }
    termination = new Promise((resolve, reject) => {
      killTimer = setTimeout(() => {
        try { signal('SIGKILL'); resolve() }
        catch {
          const error = new Error('无法确认 Native 安装进程组已停止，请再次停止实例')
          rejectStop(error); reject(error)
        }
      }, 5000)
    })
    void termination.catch(() => {})
    stopDeadline = setTimeout(() => rejectStop(new Error('无法确认 Native 安装进程组已停止，请再次停止实例')), 10_000)
  }
  if (jobId) activeNativeSteamcmdJobs.set(jobId, { child, terminate })

  let timedOut = false
  let spawnError: Error | undefined
  let forgetProcess: (() => void) | undefined
  if (jobId && child.pid) {
    try { forgetProcess = registerNativeSteamcmdProcess(jobId, child.pid) }
    catch (error) { spawnError = error instanceof Error ? error : new Error(String(error)); terminate() }
  }
  let stdoutCarry = ''
  let stderrCarry = ''
  const consume = (stream: 'stdout' | 'stderr', text: string) => {
    if (!collected.acceptChunk(text)) {
      stdoutCarry = ''
      stderrCarry = ''
      return
    }
    const previous = stream === 'stdout' ? stdoutCarry : stderrCarry
    const parts = `${previous}${text}`.split(/\r\n|\r|\n/)
    const carry = parts.pop() ?? ''
    if (stream === 'stdout') {
      stdoutCarry = carry
    }
    else {
      stderrCarry = carry
    }
    parts.forEach(pushLine)
  }
  child.stdout.on('data', chunk => consume('stdout', String(chunk)))
  child.stderr.on('data', chunk => consume('stderr', String(chunk)))
  child.once('error', (error) => {
    spawnError = error
  })

  const timeout = setTimeout(() => {
    timedOut = true
    terminate()
  }, input.timeoutMs)
  timeout.unref()

  const closed = new Promise<number>((resolve) => {
    child.once('close', code => resolve(code ?? -1))
  })
  let exitCode: number
  try { exitCode = await Promise.race([closed, stopFailure]) }
  catch (error) {
    clearTimeout(timeout)
    clearTimeout(killTimer)
    clearTimeout(stopDeadline)
    // 进程未确认结束：保留进程记录与占用，停止旧任务的日志回调。
    child.stdout.removeAllListeners('data'); child.stdout.resume()
    child.stderr.removeAllListeners('data'); child.stderr.resume()
    throw error
  }
  clearTimeout(timeout)
  clearTimeout(stopDeadline)
  if (termination && process.platform === 'linux' && child.pid) {
    try {
      // 父进程退出不代表进程组内忽略 SIGTERM 的子进程也已退出。
      process.kill(-child.pid, 0)
      await termination
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  clearTimeout(killTimer)
  try { forgetProcess?.() } catch { /* 已确认进程停止；遗留记录由下次清理校验后删除。 */ }
  if (stdoutCarry.trim()) {
    pushLine(stdoutCarry)
  }
  if (stderrCarry.trim()) {
    pushLine(stderrCarry)
  }
  if (jobId) {
    activeNativeSteamcmdJobs.delete(jobId)
  }
  const cancelled = Boolean(jobId && cancelledNativeSteamcmdJobs.has(jobId))
  if (jobId) {
    cancelledNativeSteamcmdJobs.delete(jobId)
  }
  if (spawnError) {
    pushLine(`SteamCMD 启动失败: ${spawnError.message}`)
  }
  if (timedOut) {
    pushLine(
      `${STEAMCMD_TIMEOUT_MARKER}: SteamCMD 任务超过 ${formatSteamcmdTimeoutForLog(input.timeoutMs)} 上限，已终止进程；已下载内容保留，重试将断点续传`,
    )
  }
  if ((exitCode !== 0 && !spawnError || timedOut) && !cancelled) {
    diagnostics?.collect(raw => {
      const line = redactSteamcmdLogLine(raw, secrets)
      if (line) {
        collected.pushDiagnostic(line)
        input.onLogLine?.(line.startsWith('[SteamCMD 诊断]') ? line : `[SteamCMD 诊断] ${line}`)
      }
    })
  }
  const output = collected.output
    || (timedOut ? 'SteamCMD 任务超时' : cancelled ? 'SteamCMD 任务已取消' : 'SteamCMD 任务执行失败')
  return {
    ok: exitCode === 0 && !timedOut && !cancelled && !spawnError && !logError && !collected.overflowed,
    output,
    cancelled,
    timedOut,
  }
}

export async function runSteamcmdAppUpdateNative(input: {
  signal?: AbortSignal
  hostInstallPath: string
  appId: string
  loginArgs: string[]
  cancelKey?: string
  onLogLine?: (line: string) => void
  onAwaitingSteamcmdLock?: () => void | Promise<void>
}): Promise<{ ok: boolean, output: string, cancelled?: boolean }> {
  const jobId = input.cancelKey?.trim() || 'anonymous'
  return withSteamcmdAppUpdateLock(jobId, async () => {
    if (input.cancelKey && cancelledNativeSteamcmdJobs.has(input.cancelKey)) {
      // 出队即检查：排队期间被取消的任务直接跳过并消费取消标记（保证后续重试不受影响）。
      cancelledNativeSteamcmdJobs.delete(input.cancelKey)
      return { ok: false, output: 'SteamCMD 任务已取消（排队期间被取消）', cancelled: true }
    }
    const steamcmdConfig = loadSteamcmdRuntimeConfig()
    input.onLogLine?.(`使用 Native SteamCMD: ${getServerContainerConfig().nativeSteamcmdPath}`)
    input.onLogLine?.(`安装目录: ${input.hostInstallPath}`)
    input.onLogLine?.(formatSteamcmdDownloadRegionForLog(steamcmdConfig.downloadRegion))
    const result = validateSteamcmdAppUpdateResult(await runNativeSteamcmdJob({
      args: buildSteamcmdAppUpdateArgs(
        input.hostInstallPath,
        input.appId,
        input.loginArgs,
      ),
      cancelKey: input.cancelKey,
      timeoutMs: resolveSteamcmdAppUpdateTimeoutMs(),
      onLogLine: input.onLogLine,
    }), input.hostInstallPath, input.appId)
    return {
      ok: result.ok,
      output: result.output,
      cancelled: result.cancelled,
    }
  }, { onQueued: input.onAwaitingSteamcmdLock, signal: input.signal })
}

export async function runSteamcmdWorkshopDownloadNative(input: {
  hostInstallPath: string
  workshopIds: string[]
  cancelKey?: string
  onLogLine?: (line: string) => void
  onAwaitingSteamcmdLock?: () => void | Promise<void>
  onDownloadStart?: () => void | Promise<void>
  timeoutMs?: number
}): Promise<{ ok: boolean, output: string, cancelled?: boolean }> {
  const workshopIds = [...new Set(input.workshopIds.map(id => id.trim()).filter(Boolean))]
  if (workshopIds.length === 0) {
    return { ok: true, output: '' }
  }
  const jobId = input.cancelKey?.trim() || 'anonymous'
  return withSteamcmdAppUpdateLock(jobId, async () => {
    if (input.cancelKey && cancelledNativeSteamcmdJobs.has(input.cancelKey)) {
      // 出队即检查：排队期间被取消的任务直接跳过并消费取消标记（保证后续重试不受影响）。
      cancelledNativeSteamcmdJobs.delete(input.cancelKey)
      return { ok: false, output: 'SteamCMD 任务已取消（排队期间被取消）', cancelled: true }
    }
    await input.onDownloadStart?.()
    const config = loadSteamcmdRuntimeConfig()
    input.onLogLine?.(formatSteamcmdDownloadRegionForLog(config.downloadRegion))
    const result = await runNativeSteamcmdJob({
      args: buildSteamcmdWorkshopDownloadArgs(
        input.hostInstallPath,
        DST_WORKSHOP_APP_ID,
        workshopIds,
        ['+login', 'anonymous'],
      ),
      cancelKey: input.cancelKey,
      timeoutMs: input.timeoutMs ?? DEFAULT_STEAMCMD_WORKSHOP_DOWNLOAD_TIMEOUT_MS,
      onLogLine: input.onLogLine,
    })
    return {
      ok: result.ok,
      output: result.output,
      cancelled: result.cancelled,
    }
  }, { onQueued: input.onAwaitingSteamcmdLock })
}

export async function runSteamcmdAppInfoNative(appId: string): Promise<{ ok: boolean, output: string }> {
  const result = await runNativeSteamcmdJob({
    args: buildSteamcmdAppInfoArgs(appId.trim()),
    kind: 'app-info',
    timeoutMs: STEAMCMD_APP_INFO_TIMEOUT_MS,
  })
  return {
    ok: result.ok,
    output: result.output,
  }
}

export function clearNativeSteamcmdCancelFlag(cancelKey: string): void {
  cancelledNativeSteamcmdJobs.delete(cancelKey)
}

export async function cancelNativeSteamcmdJob(cancelKey: string): Promise<void> {
  cancelledNativeSteamcmdJobs.add(cancelKey)
  const active = activeNativeSteamcmdJobs.get(cancelKey)
  if (active) active.terminate()
  await cancelRecordedNativeSteamcmdProcess(cancelKey)
  if (active && !isNativeSteamcmdJobRunning(cancelKey)) activeNativeSteamcmdJobs.delete(cancelKey)
}

export function isNativeSteamcmdJobRunning(jobId: string): boolean {
  const child = activeNativeSteamcmdJobs.get(jobId)?.child
  return Boolean(child && child.exitCode === null && child.signalCode === null)
}

export function hasUnconfirmedNativeSteamcmdJob(jobId: string) { return activeNativeSteamcmdJobs.has(jobId) }
