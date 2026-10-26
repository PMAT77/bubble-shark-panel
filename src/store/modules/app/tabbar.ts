import type { TabbarRecordRaw } from '@fantastic-admin/types'
import type { RouteLocationNormalized } from 'vue-router'
import { findTabbarRecord, replaceTabbarQuery } from '@/utils/tabbarQuery'

const TABBAR_MEMORY_STORAGE_KEY = 'app-tabbar-memory'

export const useAppTabbarStore = defineStore(
  'appTabbar',
  () => {
    const appKeepAliveStore = useAppKeepAliveStore()
    const appSettingsStore = useAppSettingsStore()

    const list = ref<TabbarRecordRaw[]>([])
    const leaveIndex = ref(-1)

    function isMemoryEnabled() {
      return appSettingsStore.settings.topbar.tabbar && appSettingsStore.settings.tabbar.memory === true
    }

    function updateStorage() {
      if (!isMemoryEnabled()) {
        sessionStorage.removeItem(TABBAR_MEMORY_STORAGE_KEY)
        return
      }
      sessionStorage.setItem(TABBAR_MEMORY_STORAGE_KEY, JSON.stringify(list.value))
    }

    function recoveryStorage() {
      if (!isMemoryEnabled()) {
        return
      }
      const raw = sessionStorage.getItem(TABBAR_MEMORY_STORAGE_KEY)
      if (!raw) {
        return
      }
      try {
        const parsed = JSON.parse(raw) as TabbarRecordRaw[]
        if (Array.isArray(parsed)) {
          list.value = parsed
        }
      }
      catch {
        sessionStorage.removeItem(TABBAR_MEMORY_STORAGE_KEY)
      }
    }

    // 添加标签页
    function add(route: RouteLocationNormalized) {
      const names: string[] = []
      route.matched.forEach((v, i) => {
        if (i > 0) {
          v.components?.default.name && names.push(v.components.default.name)
        }
      })
      const meta = route.matched.at(-1)?.meta
      const tabId = route.fullPath
      if (route.name !== 'reload') {
        const findTab = findTabbarRecord(list.value, route)
        // 新增标签页
        if (!findTab) {
          const listItem = {
            tabId,
            fullPath: route.fullPath,
            activeMenu: meta?.activeMenu,
            title: typeof meta?.title === 'function' ? meta.title() : meta?.title,
            icon: meta?.icon ?? route.matched?.findLast(item => item.meta?.icon)?.meta?.icon,
            name: names,
          }
          if (leaveIndex.value >= 0) {
            list.value.splice(leaveIndex.value + 1, 0, listItem)
            leaveIndex.value = -1
          }
          else {
            list.value.push(listItem)
          }
        }
        // 更新标签页
        else {
          findTab.tabId = tabId
          findTab.fullPath = route.fullPath
          findTab.activeMenu = meta?.activeMenu
          findTab.title = typeof meta?.title === 'function' ? meta.title() : meta?.title
          findTab.icon = meta?.icon ?? route.matched?.findLast(item => item.meta?.icon)?.meta?.icon
        }
      }
      updateStorage()
    }
    function replaceQuery(previousId: string, fullPath: string) {
      list.value = replaceTabbarQuery(list.value, previousId, fullPath)
      updateStorage()
    }

    // 删除指定标签页
    function remove(tabId: TabbarRecordRaw['tabId']) {
      const keepName: string[] = []
      const removeName: string[] = []
      list.value.forEach((v) => {
        if (v.tabId === tabId) {
          removeName.push(...v.name)
        }
        else {
          keepName.push(...v.name)
        }
      })
      const name: string[] = []
      removeName.forEach((v) => {
        if (!keepName.includes(v)) {
          name.push(v)
        }
      })
      // 如果是手动点击关闭 tab 标签页，则删除页面保活
      appKeepAliveStore.remove(name)
      list.value = list.value.filter((item) => {
        return item.tabId !== tabId
      })
      updateStorage()
    }
    // 删除两侧标签页
    function removeOtherSide(tabId: TabbarRecordRaw['tabId']) {
      const keepName: string[] = []
      const removeName: string[] = []
      list.value.forEach((v) => {
        if (v.tabId !== tabId) {
          removeName.push(...v.name)
        }
        else {
          keepName.push(...v.name)
        }
      })
      const name: string[] = []
      removeName.forEach((v) => {
        if (!keepName.includes(v)) {
          name.push(v)
        }
      })
      appKeepAliveStore.remove(name)
      list.value = list.value.filter((item) => {
        return item.tabId === tabId
      })
      updateStorage()
    }
    // 删除左侧标签页
    function removeLeftSide(tabId: TabbarRecordRaw['tabId']) {
      // 查找指定路由对应在标签页列表里的下标
      const index = list.value.findIndex(item => item.tabId === tabId)
      const keepName: string[] = []
      const removeName: string[] = []
      list.value.forEach((v, i) => {
        if (i < index) {
          removeName.push(...v.name)
        }
        else {
          keepName.push(...v.name)
        }
      })
      const name: string[] = []
      removeName.forEach((v) => {
        if (!keepName.includes(v)) {
          name.push(v)
        }
      })
      appKeepAliveStore.remove(name)
      list.value = list.value.filter((_, i) => {
        return i >= index
      })
      updateStorage()
    }
    // 删除右侧标签页
    function removeRightSide(tabId: TabbarRecordRaw['tabId']) {
      // 查找指定路由对应在标签页列表里的下标
      const index = list.value.findIndex(item => item.tabId === tabId)
      const keepName: string[] = []
      const removeName: string[] = []
      list.value.forEach((v, i) => {
        if (i > index) {
          removeName.push(...v.name)
        }
        else {
          keepName.push(...v.name)
        }
      })
      const name: string[] = []
      removeName.forEach((v) => {
        if (!keepName.includes(v)) {
          name.push(v)
        }
      })
      appKeepAliveStore.remove(name)
      list.value = list.value.filter((_, i) => {
        return i <= index
      })
      updateStorage()
    }
    // 清空所有标签页，登出的时候需要清空
    function clean() {
      list.value = []
      sessionStorage.removeItem(TABBAR_MEMORY_STORAGE_KEY)
    }

    recoveryStorage()

    watch(() => appSettingsStore.settings.tabbar.memory, (enabled) => {
      if (enabled) {
        updateStorage()
      }
      else {
        sessionStorage.removeItem(TABBAR_MEMORY_STORAGE_KEY)
      }
    })

    return {
      list,
      leaveIndex,
      add,
      replaceQuery,
      remove,
      removeOtherSide,
      removeLeftSide,
      removeRightSide,
      clean,
    }
  },
)
