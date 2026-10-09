import type { InstanceInstallProgress } from '../../../../shared/contracts/instance'

type Phase = InstanceInstallProgress['phaseCode']
export type InstallWork = 'prepare' | 'steamcmd_image' | 'source' | 'connect' | 'files' | 'layout' | 'runtime' | 'backup' | 'complete'
const STEAM_WEIGHTS = { download: 0.75, verify: 0.18, stage: 0.04, commit: 0.03 }
const EXPECTED_SECONDS: Partial<Record<Phase, number>> = {
  prepare: 10, steamcmd_image: 90, source: 15, connect: 30, backup: 60,
  download: 300, verify: 90, stage: 20, commit: 20, copy: 300, finalize: 5, runtime: 90,
}

/** 工作量估算，不是剩余时间预测；阶段乱序和自动重试均不能让整体倒退。 */
export class OverallInstallProgress {
  readonly weights: Record<InstallWork, number>
  private fractions: Record<InstallWork, number> = { prepare: 0, steamcmd_image: 0, source: 0, connect: 0, files: 0, layout: 0, runtime: 0, backup: 0, complete: 0 }
  private steam = { download: 0, verify: 0, stage: 0, commit: 0 }
  private phase: Phase = 'prepare'
  private started: number
  private actual: number | null = null
  private steamAttempt = false
  private highest = 1
  private readonly now: () => number

  constructor(mode: 'docker' | 'native', backup: boolean, now = Date.now) {
    this.now = now
    this.started = now()
    this.weights = mode === 'docker'
      ? { prepare: 5, steamcmd_image: 15, source: 5, connect: 5, files: 55, layout: 5, runtime: 9, complete: 1, backup: 0 }
      : { prepare: 8, steamcmd_image: 0, source: 5, connect: 7, files: 70, layout: 9, runtime: 0, complete: 1, backup: 0 }
    if (backup) { this.weights.backup = 5; this.weights.files -= 5 }
  }

  beginAttempt() {
    this.steamAttempt = true
    this.steam = { download: 0, verify: 0, stage: 0, commit: 0 }
    this.fractions.files = 0
    this.observe('connect', null)
  }

  observe(phase: Phase, percent: number | null) {
    if (phase !== this.phase) { this.phase = phase; this.started = this.now(); this.actual = null }
    this.actual = percent
    if (phase in STEAM_WEIGHTS) this.complete('connect')
    return this.value()
  }

  complete(work: InstallWork) { this.fractions[work] = 1; return this.value() }

  private work(): InstallWork | null {
    if (this.phase === 'prepare') return this.steamAttempt ? 'connect' : 'prepare'
    if (this.phase === 'finalize') return this.fractions.files === 1 ? 'layout' : null
    if (this.phase === 'copy' || this.phase in STEAM_WEIGHTS) return 'files'
    return this.phase in this.fractions ? this.phase as InstallWork : null
  }

  value() {
    const work = this.work()
    if (work && work !== 'complete') {
      const seconds = Math.max(0, this.now() - this.started) / 1000
      let fraction = this.actual === null
        ? Math.min(0.9, seconds / (seconds + (EXPECTED_SECONDS[this.phase] ?? 30)))
        : Math.max(0, Math.min(1, this.actual / 100))
      if (this.phase in STEAM_WEIGHTS) {
        const phase = this.phase as keyof typeof STEAM_WEIGHTS
        this.steam[phase] = Math.max(this.steam[phase], fraction)
        fraction = Object.entries(STEAM_WEIGHTS).reduce((sum, [key, weight]) => sum + weight * this.steam[key as keyof typeof this.steam], 0)
      }
      else if (this.phase === 'copy') fraction *= 0.9
      // 镜像下载完成还需解压/落位，测得字节占比最多贡献本阶段的 90%。
      else if (work === 'steamcmd_image' || work === 'runtime') fraction *= 0.9
      this.fractions[work] = Math.max(this.fractions[work], fraction)
    }
    const sum = Object.entries(this.weights).reduce((total, [key, weight]) => total + weight * this.fractions[key as InstallWork], 0)
    this.highest = Math.max(this.highest, Math.min(99, Math.floor(sum)))
    return this.highest
  }
}
