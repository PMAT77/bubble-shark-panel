import type { ResourceSnapshot } from '../../../../shared/contracts/instance-resources'

/** 四个连续有效点构成三个 5 秒区间；未知、倒退、缺采都不能累积压力。 */
export class MemoryPressureWindow {
  private previous: { at: number, events: number | null } | null = null
  private since: number | null = null
  reset() { this.previous = null; this.since = null }
  observe(input: { at: number, severe: boolean | null, events?: number | null, requireReclaim?: boolean, lastProgressAt?: number }): boolean {
    const previous = this.previous
    const events = input.events ?? null
    const gap = previous ? input.at - previous.at : 0
    const valid = input.severe === true && (!input.requireReclaim || events != null)
    const continuous = valid && previous && gap > 0 && gap <= 7500
      && (!input.requireReclaim || (previous.events != null && events! > previous.events))
    if (!continuous) this.since = valid ? input.at : null
    this.previous = valid ? { at: input.at, events } : null
    return continuous === true && this.since != null && input.at - this.since >= 15000
      && (input.lastProgressAt == null || input.at - input.lastProgressAt >= 15000)
  }
}

export function shardPressure(snapshot: ResourceSnapshot | null): { severe: boolean | null, events: number | null } {
  if (!snapshot || snapshot.memoryCurrentMb == null || snapshot.memoryPressureFullAvg10 == null) return { severe: null, events: null }
  const limits = [snapshot.memoryMaxMb, snapshot.memoryHighMb].filter((v): v is number => v != null && v > 0)
  if (!limits.length) return { severe: null, events: null }
  const atHigh = snapshot.memoryHighMb != null && snapshot.memoryCurrentMb >= snapshot.memoryHighMb * .95
  return {
    severe: snapshot.memoryCurrentMb >= Math.min(...limits) * .95 && snapshot.memoryPressureFullAvg10 >= 20,
    events: atHigh ? snapshot.highEvents : snapshot.maxEvents,
  }
}

export function confirmedOom(snapshot: ResourceSnapshot | null, baseline: ResourceSnapshot | null): boolean {
  if (!snapshot || !baseline) return false
  return snapshot.oomKillCount != null && baseline.oomKillCount != null && snapshot.oomKillCount > baseline.oomKillCount
    || snapshot.oomKilled === true && baseline.oomKilled === false
}
