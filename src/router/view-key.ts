import type { RouteLocationNormalizedLoaded } from 'vue-router'

/** 页内查询参数变化不应重建工作台或丢失草稿。实例详情仍按实例隔离。 */
export function resolveRouterViewKey(route: Pick<RouteLocationNormalizedLoaded, 'name' | 'params' | 'fullPath'>) {
  if (route.name === 'nodeInstanceConsole' || route.name === 'dstModList') return String(route.name)
  if (route.name === 'nodeInstanceDetail') return `${route.name}:${String(route.params.instanceId ?? '')}`
  return route.fullPath
}
