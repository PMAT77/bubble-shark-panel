import { createRouter, createWebHashHistory, createWebHistory } from 'vue-router'
import pinia from '@/store'
import setupExtensions from './extensions'
import setupGuards from './guards'
// 路由相关数据
import { constantRoutes } from './routes'

const router = createRouter({
  history: useAppSettingsStore(pinia).settings.app.routeMode === 'hash' ? createWebHashHistory() : createWebHistory(),
  routes: constantRoutes,
  strict: true,
})

setupGuards(router)
setupExtensions(router)

router.onError(() => {
  if (window.__BSP_BOOTSTRAP__?.state !== 'ready') {
    window.__BSP_BOOTSTRAP__?.fail('页面初始化失败，请重新加载后重试。')
  }
  else {
    faToast.error('页面加载失败', { description: '请重新加载后重试。' })
  }
})

export default router
