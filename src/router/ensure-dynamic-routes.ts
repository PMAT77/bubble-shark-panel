import type { Router } from 'vue-router'
import { asyncRoutes } from './routes'

let ensureDynamicRoutesTask: Promise<void> | null = null

/**
 * 上次失败的原因；非空表示"本次会话里不再自动重试"。
 *
 * 为什么需要它：这个函数在路由守卫里被调用，而守卫会因为跳转再次触发。
 * **失败即重试会形成请求风暴** —— 曾经因为 /app/route/list 对待改密账号返回业务错误，
 * 页面连续发了几百次请求。失败一次就停下，等登录/改密成功或用户主动重试再清空。
 */
let ensureDynamicRoutesFailure: unknown = null

/** 清空失败标记：登录成功、改密成功、登出时调用，让下一次导航重新尝试 */
export function resetEnsureDynamicRoutes() {
  ensureDynamicRoutesFailure = null
}

/**
 * 拉取权限、生成并注册动态路由（幂等）。登录成功或刷新后首次进入前调用，避免菜单首次跳转才注册路由。
 */
export async function ensureDynamicRoutes(router: Router) {
  if (ensureDynamicRoutesFailure) {
    throw ensureDynamicRoutesFailure
  }
  if (ensureDynamicRoutesTask) {
    return ensureDynamicRoutesTask
  }
  ensureDynamicRoutesTask = (async () => {
  const appRouteStore = useAppRouteStore()
  if (appRouteStore.isGenerate) {
    return
  }

  const appSettingsStore = useAppSettingsStore()
  const appAccountStore = useAppAccountStore()

  if (appSettingsStore.settings.app.account.auth) {
    await appAccountStore.getPermissions()
  }

  switch (appSettingsStore.settings.app.routeBaseOn) {
    case 'frontend':
      appRouteStore.generateRoutesAtFront(asyncRoutes)
      break
    case 'backend':
      await appRouteStore.generateRoutesAtBack()
      break
  }

  const removeRoutes: (() => void)[] = []
  for (const route of appRouteStore.routes) {
    if (/^(?:https?:|mailto:|tel:)/.test(route.path)) {
      continue
    }
    if (route.name && router.hasRoute(route.name)) {
      continue
    }
    removeRoutes.push(router.addRoute(route))
  }
  for (const route of appRouteStore.systemRoutes) {
    if (route.name && router.hasRoute(route.name)) {
      continue
    }
    removeRoutes.push(router.addRoute(route))
  }
  appRouteStore.setCurrentRemoveRoutes(removeRoutes)
  })()
  try {
    await ensureDynamicRoutesTask
  }
  catch (error) {
    ensureDynamicRoutesFailure = error
    throw error
  }
  finally {
    ensureDynamicRoutesTask = null
  }
}
