import type { ModAccessObservation } from '../../../../../shared/contracts/mod'

const unknown = (): ModAccessObservation => ({ status: 'unknown', observedAt: null, message: null })
let market = unknown()
let metadata = unknown()
const files = new Map<string, ModAccessObservation>()

/** 只保存脱敏后的事实，不保存 URL、请求头、代理地址或 SteamCMD 原始输出。 */
export function observeSteamAccess(kind: 'market' | 'metadata' | 'files', observation: Omit<ModAccessObservation, 'observedAt'>, instanceId?: string) {
  const value = { ...observation, observedAt: new Date().toISOString() }
  if (kind === 'market') market = value
  else if (kind === 'metadata') metadata = value
  else if (instanceId) files.set(instanceId, value)
}
export function getSteamAccessObservations(instanceId: string) {
  return { market: { ...market }, metadata: { ...metadata }, files: { ...(files.get(instanceId) ?? unknown()) } }
}
export function observeSteamMarketCache(cached: boolean, fetchedAt: number) {
  market = { ...market, cached, fetchedAt: new Date(fetchedAt).toISOString() }
}
