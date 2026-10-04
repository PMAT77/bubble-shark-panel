import type { RouteLocationRaw } from 'vue-router'
import { FRONTEND_ROUTE_PATHS } from '../../shared/constants/frontend-routes'

/** 与后端 menu-routes、auth 动态路由 name 保持一致 */
export const ROUTE_NAMES = {
  consoleMonitor: 'consoleMonitor',
  nodeInstance: 'nodeInstance',
  nodeInstanceDetail: 'nodeInstanceDetail',
  nodeInstanceConsole: 'nodeInstanceConsole',
  dstRoomList: 'dstRoomList',
  dstRoomSettings: 'dstRoomSettings',
  dstPlayerList: 'dstPlayerList',
  dstPlayerManage: 'dstPlayerManage',
  dstWorldList: 'dstWorldList',
  dstWorldSettings: 'dstWorldSettings',
  dstModList: 'dstModList',
  dstModDetail: 'dstModDetail',
  opsBackups: 'opsBackups',
  opsSchedules: 'opsSchedules',
  // 系统设置：通知渠道是设置页的页内 tab，`systemNotify` 只用于旧地址 `/system/notify` 的重定向
  systemSettings: 'systemSettings',
  systemCommercial: 'systemCommercial',
  systemPlugins: 'systemPlugins',
  systemNotify: 'systemNotify',
} as const

export { FRONTEND_ROUTE_PATHS }

export function routeToConsoleMonitor(): RouteLocationRaw {
  return { name: ROUTE_NAMES.consoleMonitor }
}

export function routeToNodeInstance(): RouteLocationRaw {
  return { name: ROUTE_NAMES.nodeInstance }
}

export function routeToInstanceDetail(instanceId: string): RouteLocationRaw {
  return { name: ROUTE_NAMES.nodeInstanceDetail, params: { instanceId } }
}

export function routeToInstanceConsole(instanceId: string): RouteLocationRaw {
  return { name: ROUTE_NAMES.nodeInstanceConsole, params: { instanceId } }
}

export function routeToDstRoomList(): RouteLocationRaw {
  return { name: ROUTE_NAMES.dstRoomList }
}

export function routeToDstRoomSettings(instanceId: string): RouteLocationRaw {
  return { name: ROUTE_NAMES.dstRoomSettings, params: { instanceId } }
}

export function routeToDstPlayerList(): RouteLocationRaw {
  return { name: ROUTE_NAMES.dstPlayerList }
}

export function routeToDstPlayerManage(instanceId: string): RouteLocationRaw {
  return { name: ROUTE_NAMES.dstPlayerManage, params: { instanceId } }
}

export function routeToDstWorldList(): RouteLocationRaw {
  return { name: ROUTE_NAMES.dstWorldList }
}

export function routeToDstWorldSettings(
  instanceId: string,
  query?: Record<string, string>,
): RouteLocationRaw {
  return { name: ROUTE_NAMES.dstWorldSettings, params: { instanceId }, query }
}

export function routeToDstModList(instanceId?: string, tab?: 'market' | 'subscribed'): RouteLocationRaw {
  return { name: ROUTE_NAMES.dstModList, query: { ...(instanceId ? { instanceId } : {}), ...(tab ? { tab } : {}) } }
}

export function routeToDstModDetail(workshopId: string, instanceId: string): RouteLocationRaw {
  return {
    name: ROUTE_NAMES.dstModDetail,
    params: { workshopId },
    query: { instanceId },
  }
}

/** 传 instanceId 时备份页会预选该实例（实例详情 →「查看本实例的备份」） */
export function routeToOpsBackups(instanceId?: string): RouteLocationRaw {
  return instanceId
    ? { name: ROUTE_NAMES.opsBackups, query: { instanceId } }
    : { name: ROUTE_NAMES.opsBackups }
}

export function routeToOpsSchedules(): RouteLocationRaw {
  return { name: ROUTE_NAMES.opsSchedules }
}
