import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { buildSteamcmdAppUpdateArgs, buildSteamcmdWorkshopDownloadArgs } from './steamcmd-args'
import { withSteamcmdAppUpdateLock } from './steamcmd-app-update-queue'
import { sanitizeSteamcmdLogLine, STEAMCMD_TIMEOUT_MARKER } from './steamcmd-errors'
import { getServerContainerConfig } from '../../shared/config/container'
import {
  formatSteamcmdTimeoutForLog,
  loadSteamcmdRuntimeConfig,
  resolveSteamcmdAppUpdateTimeoutMs,
} from '../../shared/config/steamcmd'
import { DST_WORKSHOP_APP_ID } from '../game-adapter/dst/constants'
import { SteamcmdOutput } from './steamcmd-output'

const STEAMCMD_APP_INFO_TIMEOUT_MS = 90_000
const DEFAULT_STEAMCMD_WORKSHOP_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000

const activeNativeSteamcmdJobs = new Map<string, ChildProcess>()
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
  if (config.downloadRegion) {
    env.STEAMCMD_FORCE_DOWNLOAD_REGION = 'china'
  }
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
  const { nativeSteamcmdPath } = getServerContainerConfig()
  if (!fs.existsSync(nativeSteamcmdPath)) {
    return {
      ok: false,
      output: `SteamCMD 不存在: ${nativeSteamcmdPath}`,
    }
  }
  const collected = new SteamcmdOutput(input.kind === 'app-info')
  const pushLine = (raw: string) => {
    const line = sanitizeSteamcmdLogLine(raw)
    if (!line) {
      return
    }
    collected.push(line)
    input.onLogLine?.(line)
  }
  const jobId = input.cancelKey?.trim()
  // 取消标记不在这里清除：排队取消依赖锁出队时检查（取消标记存活到出队）；
  // 重试场景的残留标记由 install-service.startInstallJob 在新任务启动时清理。
  const child = spawn(nativeSteamcmdPath, input.args, {
    cwd: path.dirname(nativeSteamcmdPath),
    env: buildSteamcmdEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  if (jobId) {
    activeNativeSteamcmdJobs.set(jobId, child)
  }

  let timedOut = false
  let spawnError: Error | undefined
  let stdoutCarry = ''
  let stderrCarry = ''
  const consume = (stream: 'stdout' | 'stderr', text: string) => {
    if (!collected.acceptChunk(text)) {
      stdoutCarry = ''
      stderrCarry = ''
      return
    }
    const previous = stream === 'stdout' ? stdoutCarry : stderrCarry
    const parts = `${previous}${text}`.split(/\r?\n/)
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
    child.kill('SIGTERM')
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000)
    killTimer.unref()
  }, input.timeoutMs)
  timeout.unref()

  const exitCode = await new Promise<number>((resolve) => {
    child.once('close', code => resolve(code ?? -1))
  })
  clearTimeout(timeout)
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
  const output = collected.output
    || (timedOut ? 'SteamCMD 任务超时' : cancelled ? 'SteamCMD 任务已取消' : 'SteamCMD 任务执行失败')
  return {
    ok: exitCode === 0 && !timedOut && !cancelled && !spawnError && !collected.overflowed,
    output,
    cancelled,
    timedOut,
  }
}

export async function runSteamcmdAppUpdateNative(input: {
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
    const result = await runNativeSteamcmdJob({
      args: buildSteamcmdAppUpdateArgs(
        input.hostInstallPath,
        input.appId,
        input.loginArgs,
        { downloadRegion: steamcmdConfig.downloadRegion || undefined },
      ),
      cancelKey: input.cancelKey,
      timeoutMs: resolveSteamcmdAppUpdateTimeoutMs(),
      onLogLine: input.onLogLine,
    })
    return {
      ok: result.ok,
      output: result.output,
      cancelled: result.cancelled,
    }
  }, { onQueued: input.onAwaitingSteamcmdLock })
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
    const result = await runNativeSteamcmdJob({
      args: buildSteamcmdWorkshopDownloadArgs(
        input.hostInstallPath,
        DST_WORKSHOP_APP_ID,
        workshopIds,
        ['+login', 'anonymous'],
        { downloadRegion: config.downloadRegion || undefined },
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
  activeNativeSteamcmdJobs.get(cancelKey)?.kill('SIGTERM')
}

export function isNativeSteamcmdJobRunning(jobId: string): boolean {
  const child = activeNativeSteamcmdJobs.get(jobId)
  return Boolean(child && child.exitCode === null && !child.killed)
}
