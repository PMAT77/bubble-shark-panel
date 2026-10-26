import type { TabbarRecordRaw } from '@fantastic-admin/types'
import type { RouteLocationNormalized } from 'vue-router'

export function findTabbarRecord(list: TabbarRecordRaw[], route: Pick<RouteLocationNormalized, 'name' | 'path' | 'fullPath'>) {
  const queryWorkspace = route.name === 'nodeInstanceDetail' || route.name === 'dstModList'
  return list.find(item => item.tabId === route.fullPath
    || (queryWorkspace && item.fullPath.split(/[?#]/, 1)[0] === route.path))
}

/** 原位替换页内查询参数，不清理正在使用的页面缓存。 */
export function replaceTabbarQuery(list: TabbarRecordRaw[], previousId: string, fullPath: string) {
  const previous = list.find(item => item.tabId === previousId)
  if (!previous) return list
  const next = list.filter(item => item === previous || item.tabId !== fullPath)
  previous.tabId = fullPath
  previous.fullPath = fullPath
  return next
}
