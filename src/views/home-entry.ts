import { FRONTEND_ROUTE_PATHS } from '../../shared/constants/frontend-routes'

/**
 * 已登录后首页 Hero 按钮该进哪个页面。
 *
 * 面板内的页面路由是**按权限动态注册**的（后端 `/app/route/list` 已按权限过滤）：
 * 没有 `instance:read` 的账号，`nodeInstance` 这条记录根本不存在，而
 * `router.push({ name: 'nodeInstance' })` 会在 resolve 阶段就抛
 * `No match for {"name":"nodeInstance"}` —— 抛在路由守卫之前，守卫兜不住，
 * 表现为控制台一串 Uncaught Error 且页面毫无反应。
 * 所以这里返回**路径**，并在没有实例管理权限时退到第一个可访问模块。
 *
 * 返回 null 表示这个账号一个模块都进不去（首页此时会显示「未分配任何模块权限」提示），
 * 不要跳转：跳过去只会落在 404 页。
 */
export function resolveHomeEntryPath(options: {
  /** 是否有实例管理权限（`instance:read`，与首页「实例管理」卡片同一个权限点） */
  canReadInstance: boolean
  /** 第一个可访问模块的最深路径（`menu store` 的 `sidebarMenusFirstDeepestPath`） */
  firstAccessiblePath: string
  /** 首页路径；`firstAccessiblePath` 等于它说明当前账号没有任何可访问模块 */
  homePath: string
}): string | null {
  if (options.canReadInstance) {
    return FRONTEND_ROUTE_PATHS.nodeInstance
  }
  return options.firstAccessiblePath === options.homePath ? null : options.firstAccessiblePath
}
