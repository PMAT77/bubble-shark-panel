import type { RouteLocationRaw, Router } from 'vue-router'
import pinia from '@/store'

function getId(router: Router) {
  return router.currentRoute.value.fullPath
}

function extendPush(router: Router) {
  const originalPush = router.push
  router.push = function (to: RouteLocationRaw) {
    const appSettingsStore = useAppSettingsStore(pinia)
    if (appSettingsStore.settings.topbar.tabbar) {
      const appTabbarStore = useAppTabbarStore(pinia)
      const index = appTabbarStore.list.findIndex(item => item.tabId === getId(router))
      appTabbarStore.$patch({
        leaveIndex: index,
      })
    }
    return originalPush(to)
  }
}

function extendReplace(router: Router) {
  const originalReplace = router.replace
  router.replace = function (to: RouteLocationRaw) {
    const appSettingsStore = useAppSettingsStore(pinia)
    if (appSettingsStore.settings.topbar.tabbar) {
      const tabId = getId(router)
      const appTabbarStore = useAppTabbarStore(pinia)
      const previous = router.currentRoute.value
      return originalReplace(to).then((result) => {
        if (result) return result
        const current = router.currentRoute.value
        if (previous.name === current.name && previous.path === current.path
          && (current.name === 'nodeInstanceDetail' || current.name === 'dstModList')) {
          appTabbarStore.replaceQuery(tabId, current.fullPath)
        }
        else appTabbarStore.remove(tabId)
      })
    }
    else {
      return originalReplace(to)
    }
  }
}

function extendGo(router: Router) {
  const originalGo = router.go
  router.go = function (delta: number) {
    const appSettingsStore = useAppSettingsStore(pinia)
    if (appSettingsStore.settings.topbar.tabbar) {
      const tabId = getId(router)
      const appTabbarStore = useAppTabbarStore(pinia)
      originalGo(delta)
      if (delta < 0) {
        appTabbarStore.remove(tabId)
      }
    }
    else {
      originalGo(delta)
    }
  }
}

function shouldUseHistoryBack(router: Router, to?: RouteLocationRaw) {
  const historyBack = window.history.state?.back
  if (typeof historyBack !== 'string' || !historyBack) {
    return false
  }
  if (!to) {
    return true
  }
  const backRoute = router.resolve(historyBack)
  const targetRoute = router.resolve(to)
  if (backRoute.name && targetRoute.name) {
    return backRoute.name === targetRoute.name
  }
  return (backRoute.matched.at(-1)?.path ?? backRoute.path) === (targetRoute.matched.at(-1)?.path ?? targetRoute.path)
}

function extendBack(router: Router) {
  const originalBack = router.back
  router.back = function (to?: RouteLocationRaw) {
    const appSettingsStore = useAppSettingsStore(pinia)
    const tabId = getId(router)
    const fallbackTo = to ?? appSettingsStore.settings.app.home.fullPath
    if (shouldUseHistoryBack(router, to)) {
      originalBack()
      if (appSettingsStore.settings.topbar.tabbar) {
        const appTabbarStore = useAppTabbarStore(pinia)
        appTabbarStore.remove(tabId)
      }
      return Promise.resolve()
    }
    else {
      return router.replace(fallbackTo).then(() => {
        if (appSettingsStore.settings.topbar.tabbar) {
          const appTabbarStore = useAppTabbarStore(pinia)
          appTabbarStore.remove(tabId)
        }
      })
    }
  }
}

// 注：原框架扩展 router.close/close（关闭标签页并跳转）已迁移为
// composables/app/tabbar.ts 内的 closeCurrentTo()。vue-router 5.3 的公开
// Router 类型改为条件类型且其实现接口被混淆导出，实例扩展（monkey-patch
// 新增方法）已无法通过模块扩充获得类型支持，故不再提供 router.close。
// extendBack 保留：其仅覆写既有方法签名，类型兼容。

export default function setupExtensions(router: Router) {
  extendPush(router)
  extendReplace(router)
  extendGo(router)
  extendBack(router)
}
