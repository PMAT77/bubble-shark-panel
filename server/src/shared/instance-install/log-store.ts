import fs from 'node:fs'
import path from 'node:path'
import { instanceInstallProgressSchema, type InstanceInstallProgress } from '../../../../shared/contracts/instance'
import { STEAMCMD_FAILURE_LINE } from '../../infra/container/steamcmd-errors'
import { formatInstallLogContent, INSTALL_PHASE_LABELS, normalizeInstallLogLine, parseInstallLogPhase, parseSteamcmdProgressPercent, summarizeInstallFailure } from './log-format'
import { OverallInstallProgress, type InstallWork } from './overall-progress'

export const INSTALL_LOG_TAIL_BYTES = 64 * 1024
export const INSTALL_LOG_TAIL_LINES = 500

export function resolveInstallLogsDir(dbPath: string) {
  return path.join(path.dirname(dbPath), 'install-logs')
}

export function resolveInstallLogFilePath(installLogsDir: string, instanceId: string) {
  return path.join(installLogsDir, `${instanceId}.log`)
}

function progressFilePath(dir: string, id: string) {
  return path.join(dir, `${id}.progress.json`)
}

export function ensureInstallLogsDir(installLogsDir: string) {
  fs.mkdirSync(installLogsDir, { recursive: true })
}

/** 从磁盘尾部读取，摘要轮询不走这个路径。 */
export function readInstallLogTail(dir: string, id: string): { content: string, truncated: boolean } | null {
  const file = resolveInstallLogFilePath(dir, id)
  let fd: number
  try { fd = fs.openSync(file, 'r') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const size = fs.fstatSync(fd).size
    const offset = Math.max(0, size - INSTALL_LOG_TAIL_BYTES)
    const buffer = Buffer.alloc(size - offset)
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, offset)
    // 截去可能从 UTF-8 字符或行中间开始的首行。
    let raw = buffer.subarray(0, bytes).toString('utf8')
    if (offset > 0) {
      const boundary = raw.indexOf('\n')
      raw = boundary >= 0 ? raw.slice(boundary + 1) : ''
    }
    const lines = raw.replace(/\r\n?/g, '\n').trimEnd().split('\n')
    return { content: formatInstallLogContent(lines.slice(-INSTALL_LOG_TAIL_LINES).join('\n')), truncated: offset > 0 || lines.length > INSTALL_LOG_TAIL_LINES }
  }
  finally { fs.closeSync(fd) }
}

export function readInstallLogContent(dir: string, id: string): string | null {
  return readInstallLogTail(dir, id)?.content || null
}

export function readInstallProgress(dir: string, id: string): InstanceInstallProgress | null {
  try {
    const result = instanceInstallProgressSchema.safeParse(JSON.parse(fs.readFileSync(progressFilePath(dir, id), 'utf8')))
    return result.success ? result.data : null
  }
  catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export function deleteInstallLogFile(dir: string, id: string) {
  for (const file of [resolveInstallLogFilePath(dir, id), progressFilePath(dir, id), `${progressFilePath(dir, id)}.tmp`]) {
    fs.rmSync(file, { force: true })
  }
}

export class InstanceInstallLogWriter {
  private readonly filePath: string
  private readonly snapshotPath: string
  private timer?: ReturnType<typeof setTimeout>
  private lastSavedAt = 0
  private overall?: OverallInstallProgress
  progress: InstanceInstallProgress

  constructor(dir: string, id: string) {
    ensureInstallLogsDir(dir)
    this.filePath = resolveInstallLogFilePath(dir, id)
    this.snapshotPath = progressFilePath(dir, id)
    this.progress = readInstallProgress(dir, id) ?? this.initialProgress()
  }

  private initialProgress(): InstanceInstallProgress {
    return { phaseCode: 'prepare', phase: INSTALL_PHASE_LABELS.prepare, percent: null,
      updatedAt: null, attempt: 1, maxAttempts: 1, retryAt: null, status: 'running', failure: null, events: [] }
  }

  clear(maxAttempts = 1, task?: { taskId: string, kind: 'install' | 'update', runtimeMode: 'docker' | 'native', backup: boolean }) {
    this.dispose()
    this.progress = this.initialProgress()
    this.progress.maxAttempts = maxAttempts
    if (task) {
      this.overall = new OverallInstallProgress(task.runtimeMode, task.backup)
      Object.assign(this.progress, { taskId: task.taskId, kind: task.kind, runtimeMode: task.runtimeMode,
        startedAt: new Date().toISOString(), phaseStartedAt: new Date().toISOString(), overallPercent: 1, timings: {} })
    }
    fs.writeFileSync(this.filePath, '', 'utf8')
    this.event('安装任务已开始')
  }

  appendLine(line: string) {
    const text = formatInstallLogContent(line)
    if (!text) return
    fs.appendFileSync(this.filePath, `${text}\n`, 'utf8')
    if (this.progress.status !== 'running') return
    this.progress.updatedAt = new Date().toISOString()
    for (const part of text.split('\n')) {
      const code = parseInstallLogPhase(part)
      if (code) {
        this.setPhase(code)
        const percent = parseSteamcmdProgressPercent(part)
        if (percent !== null) this.progress.percent = percent
      }
      else if (!/^\[(?:SteamCMD 诊断|资源快照)/.test(part) && STEAMCMD_FAILURE_LINE.test(part)) {
        this.event('SteamCMD 返回异常，正在处理；可展开原始日志查看详情。', 'warning')
      }
    }
    this.scheduleSave()
    this.tick()
  }

  setPhase(code: InstanceInstallProgress['phaseCode']) {
    if (this.progress.status !== 'running' || this.progress.phaseCode === code) return
    if (this.progress.phaseStartedAt) {
      const timings = this.progress.timings ??= {}
      timings[this.progress.phaseCode] = (timings[this.progress.phaseCode] ?? 0) + Math.max(0, Date.now() - Date.parse(this.progress.phaseStartedAt))
    }
    this.progress.phaseStartedAt = new Date().toISOString()
    this.progress.phaseCode = code
    this.progress.phase = INSTALL_PHASE_LABELS[code]
    this.progress.percent = null
    this.overall?.observe(code, null)
    if (code !== 'retry') this.progress.retryAt = null
    this.event(this.progress.phase)
  }

  beginAttempt(attempt: number, maxAttempts: number, account = false) {
    if (this.progress.status !== 'running') return
    this.progress.attempt = attempt
    this.progress.maxAttempts = maxAttempts
    this.progress.percent = null
    this.overall?.beginAttempt()
    this.setPhase('connect')
    this.event(`第 ${attempt}/${maxAttempts} 次尝试，${account ? '使用 Steam 账号连接' : '匿名连接 Steam'}`)
  }

  completeWork(work: InstallWork) {
    if (this.progress.status !== 'running') return
    if (this.overall) this.progress.overallPercent = this.overall.complete(work)
    this.scheduleSave()
  }

  setMeasuredPercent(percent: number | null) {
    if (this.progress.status !== 'running') return
    this.progress.percent = percent === null ? null : Math.max(0, Math.min(100, percent))
    this.tick()
  }

  tick() {
    if (!this.overall || this.progress.status !== 'running') return
    this.progress.overallPercent = this.overall.observe(this.progress.phaseCode, this.progress.percent)
    this.scheduleSave()
  }

  recordBytes(completed: number, total: number) {
    if (this.progress.status !== 'running') return
    const bytes = this.progress.bytes ??= {}
    bytes[this.progress.phaseCode] = { completed, total }
  }

  waitForRetry(attempt: number, maxAttempts: number, delayMs: number) {
    if (this.progress.status !== 'running') return
    this.progress.attempt = attempt
    this.progress.maxAttempts = maxAttempts
    this.progress.retryAt = new Date(Date.now() + delayMs).toISOString()
    this.progress.percent = null
    this.setPhase('retry')
    this.event(`${Math.round(delayMs / 1000)} 秒后进行第 ${attempt}/${maxAttempts} 次尝试，保留已下载内容。`, 'warning')
  }

  event(message: string, level: 'info' | 'warning' | 'error' = 'info') {
    if (this.progress.status !== 'running') return
    const text = normalizeInstallLogLine(message)
    const previous = this.progress.events.at(-1)
    if (previous?.message === text && previous.level === level) return
    this.progress.events.push({ at: new Date().toISOString(), level, message: text })
    this.flush()
  }

  finish(status: 'success' | 'failed' | 'cancelled', message: string) {
    if (this.progress.status !== 'running') return
    if (this.progress.phaseStartedAt) {
      const timings = this.progress.timings ??= {}
      timings[this.progress.phaseCode] = (timings[this.progress.phaseCode] ?? 0) + Math.max(0, Date.now() - Date.parse(this.progress.phaseStartedAt))
    }
    if (status === 'success') {
      this.progress.phaseCode = 'complete'
      this.progress.phase = INSTALL_PHASE_LABELS.complete
      if (this.overall || this.progress.taskId) this.progress.overallPercent = 100
    }
    else if (status === 'failed') this.progress.failure = { ...summarizeInstallFailure(message), phase: this.progress.phaseCode }
    this.event(status === 'success' ? '安装完成，可以启动实例。' : status === 'cancelled' ? '安装已取消。' : this.progress.failure!.message, status === 'failed' ? 'error' : 'info')
    this.progress.status = status
    this.progress.percent = null
    this.progress.retryAt = null
    this.flush()
  }

  readContent(): string {
    return fs.existsSync(this.filePath) ? formatInstallLogContent(fs.readFileSync(this.filePath, 'utf8')) : ''
  }

  private scheduleSave() {
    if (this.timer) return
    const delay = Math.max(0, 1000 - (Date.now() - this.lastSavedAt))
    this.timer = setTimeout(() => {
      this.timer = undefined
      // 快照写入失败不能在定时器里抛出未捕获异常；同步终态保存会再次尝试。
      try { this.flush() } catch { /* 原始日志与数据库状态仍可用于兜底。 */ }
    }, delay)
    this.timer.unref()
  }

  flush() {
    this.dispose()
    // 原子替换，读取接口不会遇到写了一半的 JSON。
    fs.writeFileSync(`${this.snapshotPath}.tmp`, JSON.stringify(this.progress), 'utf8')
    fs.renameSync(`${this.snapshotPath}.tmp`, this.snapshotPath)
    this.lastSavedAt = Date.now()
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }
}
