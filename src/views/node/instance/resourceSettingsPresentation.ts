import type { InstanceResourcesPayload, InstanceStartupSnapshot, ResourceSnapshot } from '@/api/modules/instance'
import { isStartupActive } from './startupPresentation'

export function resourceRecommendationWarning(
  effective: InstanceResourcesPayload['effective'],
  recommendation: InstanceResourcesPayload['recommendation'],
  cavesEnabled: boolean,
): string | null {
  const below = (limit: number | null, recommended: number) => limit !== null && limit > 0 && limit < recommended
  const shards = [
    ...(below(effective.masterMemoryMb, recommendation.masterMemoryMb) ? ['主世界'] : []),
    ...(cavesEnabled && below(effective.cavesMemoryMb, recommendation.cavesMemoryMb) ? ['洞穴'] : []),
  ]
  return shards.length ? `已保存的${shards.join('、')}内存上限低于推荐值，加载期间可能因硬限触发 OOM。可填入推荐值后保存，下次启动生效。` : null
}

/** 活跃启动只展示本轮增量；未读取基线时不回退到运行时累计值。 */
export function resourceOomKillCount(
  startup: InstanceStartupSnapshot | null | undefined,
  shard: 'master' | 'caves',
  current: ResourceSnapshot | null,
): number | null {
  return isStartupActive(startup) ? startup?.[shard].resourceDeltas?.oomKillCount ?? null : current?.oomKillCount ?? null
}
