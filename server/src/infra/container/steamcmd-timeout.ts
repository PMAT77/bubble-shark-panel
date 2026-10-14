import { formatSteamcmdTimeoutForLog } from '../../shared/config/steamcmd'
import { sanitizeSteamcmdLogLine, STEAMCMD_TIMEOUT_MARKER } from './steamcmd-errors'

export const STEAMCMD_BOOTSTRAP_TIMEOUT_MS = 60 * 60 * 1000
export type SteamcmdTimeoutPhase = 'bootstrap' | 'task'

/** Only explicit updater output grants a bootstrap budget; unrelated output keeps the task deadline. */
export class SteamcmdTimeout {
  private readonly startedAt = Date.now()
  private phase: SteamcmdTimeoutPhase = 'task'
  private taskStarted = false
  private stopped = false
  private timer?: ReturnType<typeof setTimeout>
  expiredPhase?: SteamcmdTimeoutPhase
  private readonly taskTimeoutMs: number
  private readonly expire: () => void

  constructor(taskTimeoutMs: number, expire: () => void) {
    this.taskTimeoutMs = taskTimeoutMs
    this.expire = expire
    this.arm(this.startedAt + taskTimeoutMs)
  }

  observe(raw: string): void {
    if (this.stopped || this.expiredPhase || this.taskStarted) return
    const line = sanitizeSteamcmdLogLine(raw).trim()
    if (line.startsWith('[SteamCMD 诊断]')) return
    if (/^Steam Console Client\b|^Loading Steam API\b|^Connecting anonymously\b|^Logging in\b|^Downloading item\s+\d+\b|^Success\.\s+Downloaded item\b/i.test(line)) {
      this.taskStarted = true
      if (this.phase === 'bootstrap') {
        this.phase = 'task'
        this.arm(Date.now() + this.taskTimeoutMs)
      }
    }
    else if (this.phase !== 'bootstrap' && /Checking for (?:available updates|update on startup)|Downloading update\b|Verifying installation\b|Installing update\b|Extracting package\b|Unpacking.*update|Restarting SteamCMD\b/i.test(line)) {
      this.phase = 'bootstrap'
      // Repeated progress and SteamCMD self-restarts cannot extend this absolute deadline.
      this.arm(this.startedAt + STEAMCMD_BOOTSTRAP_TIMEOUT_MS)
    }
  }

  private arm(deadline: number): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.expiredPhase = this.phase
      this.expire()
    }, Math.max(0, deadline - Date.now()))
  }

  dispose(): void {
    this.stopped = true
    clearTimeout(this.timer)
  }
}

export function formatSteamcmdTimeoutMessage(phase: SteamcmdTimeoutPhase, taskTimeoutMs: number, target: '进程' | '容器'): string {
  return phase === 'bootstrap'
    ? `${STEAMCMD_TIMEOUT_MARKER}: SteamCMD 自更新超过 ${formatSteamcmdTimeoutForLog(STEAMCMD_BOOTSTRAP_TIMEOUT_MS)} 上限，已终止${target}；未完成的自更新组件重试时可能重新下载`
    : `${STEAMCMD_TIMEOUT_MARKER}: SteamCMD 任务超过 ${formatSteamcmdTimeoutForLog(taskTimeoutMs)} 上限，已终止${target}；重试时未完成内容可能重新下载`
}
