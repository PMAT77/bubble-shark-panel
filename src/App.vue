<script setup lang="ts">
import dayjs from '@/utils/dayjs'
import { APP_TITLE } from '@/utils/app-title'
import Provider from './ui/provider/index.vue'
import 'dayjs/locale/zh-cn'
import type { PermissionKey } from '../shared/constants/permissions'

const route = useRoute()

const appSettingsStore = useAppSettingsStore()

const { auth } = useAppAuth()
const { generateTitle } = useAppMenu()

function resolveDynamicPageTitle() {
  if (!appSettingsStore.title) {
    return ''
  }
  const normalizedTitle = String(generateTitle(appSettingsStore.title) ?? '').trim()
  if (!normalizedTitle) {
    return ''
  }
  const normalizedLowerTitle = normalizedTitle.toLowerCase()
  if (normalizedLowerTitle === 'undefined' || normalizedLowerTitle === 'null') {
    return ''
  }
  return normalizedTitle
}

/** 路由 meta 上权限点的形态；空串 = 无需权限 */
type RouteAuth = PermissionKey | PermissionKey[] | ''

const isAuth = computed(() => {
  return route.matched.every((item) => {
    // 路由 meta 的权限点由服务端菜单决定（menu-routes 侧已收窄到 PermissionKey）；
    // vue-router 的 meta 是松散类型，这里断言一次。空串表示"这项不需要权限"。
    return auth((item.meta.auth ?? '') as RouteAuth)
  })
})

// 设置网页 title
watch([
  () => appSettingsStore.settings.app.dynamicTitle,
  () => appSettingsStore.title,
], () => {
  nextTick(() => {
    const dynamicPageTitle = resolveDynamicPageTitle()
    if (appSettingsStore.settings.app.dynamicTitle && dynamicPageTitle) {
      document.title = `${dynamicPageTitle} - ${APP_TITLE}`
    }
    else {
      document.title = APP_TITLE
    }
  })
}, {
  immediate: true,
  deep: true,
})

onMounted(() => {
  appSettingsStore.setMode(document.documentElement.clientWidth)
  dayjs.locale('zh-cn')
  window.addEventListener('resize', () => {
    appSettingsStore.setMode(document.documentElement.clientWidth)
  })
})
</script>

<template>
  <Provider>
    <RouterView v-slot="{ Component }">
      <AppNotSupportedMobile v-if="!appSettingsStore.settings.app.mobile && appSettingsStore.mode === 'mobile'" />
      <Component :is="Component" v-else-if="isAuth" />
      <AppNotAllowed v-else />
    </RouterView>
    <AppBackToTop />
    <FaToast :theme="appSettingsStore.currentColorScheme" />
    <AppSystemInfo />
  </Provider>
</template>
