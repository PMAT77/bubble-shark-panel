<script setup lang="ts">
import { useElementSize, useScroll } from '@vueuse/core'
import type { RouteLocationNormalizedLoaded } from 'vue-router'
import { useHotkeyBindings } from '@/hotkeys/useHotkeys'
import { useSlots } from '@/slots'
import { cn } from '@/utils'
import eventBus from '@/utils/eventBus'
import AppSetting from './components/AppSetting/index.vue'
import FloatingSidebarMenuButton from './components/FloatingSidebarMenuButton/index.vue'
import Header from './components/Header/index.vue'
import Hotkeys from './components/Hotkeys/index.vue'
import MainSidebar from './components/MainSidebar/index.vue'
import SubSidebar from './components/SubSidebar/index.vue'
import Topbar from './components/Topbar/index.vue'
import LinkView from './components/views/link.vue'
import { useGuestModeNotice } from '@/composables/useGuestModeNotice'
import { usePanelUpdateNotifier } from '@/composables/usePanelUpdateNotifier'
import { usePanelVersionGuard } from '@/composables/usePanelVersionGuard'
import { useScheduleRunNotifier } from '@/composables/useScheduleRunNotifier'

defineOptions({
  name: 'Layout',
})

const routeInfo = useRoute()

usePanelUpdateNotifier()
// 面板升级后旧标签页仍跑旧脚本：这里负责把它喊出来（只提示，不自动刷新）
usePanelVersionGuard()
useScheduleRunNotifier()
// 游客角色只读：右上角常驻一条提示，说清"为什么没有操作入口"，手动关闭
useGuestModeNotice()

const appSettingsStore = useAppSettingsStore()
const appKeepAliveStore = useAppKeepAliveStore()
const appMenuStore = useAppMenuStore()
const mainPage = useAppPage()

useHotkeyBindings({
  'system.info.open': () => {
    eventBus.emit('global-system-info-open')
  },
  'page.reload': () => {
    mainPage.reload()
  },
})

const layoutTopRef = useTemplateRef('layoutTopRef')
const { height: layoutTopHeight } = useElementSize(layoutTopRef)

const layoutBottomRef = useTemplateRef('layoutBottomRef')
const { height: layoutBottomHeight } = useElementSize(layoutBottomRef)

/** 主内容区（真正的滚动容器）：路由变化时把滚动位置归零 */
const mainContainerRef = useTemplateRef('mainContainerRef')

// 头部是否显示
const isHeaderEnable = computed(() => {
  return appSettingsStore.mode === 'pc'
    && appSettingsStore.settings.menu.mode === 'head'
})

const appAccountStore = useAppAccountStore()

// 侧边栏主导航是否显示
const isMainSidebarEnable = computed(() => {
  return appSettingsStore.settings.menu.mode === 'side'
    || (appSettingsStore.mode === 'mobile' && appSettingsStore.settings.menu.mode !== 'single')
})

// 侧边栏次导航是否显示
const isSubSidebarEnable = computed(() => {
  /**
   * 零权限账号的兜底。
   *
   * single 模式下主侧边栏（要求 mode === 'side'）与顶栏（要求 mode === 'head'）都不显示，
   * 次侧边栏又要满足 sidebarMenus 非空才显示 —— 于是还没被分配角色的账号
   * 在页面上**没有任何账号入口**，连退出登录都找不到。
   *
   * 判据用 `allMenus`（全部可见模块）而不是 `sidebarMenus`：后者是"当前选中主菜单的子菜单"，
   * 有权限的账号在某些情况下也会为空，用它会把正常账号也判成零权限。
   */
  const hasNoMenu = appAccountStore.isLogin && appMenuStore.allMenus.length === 0
  if (hasNoMenu && appSettingsStore.mode !== 'mobile' && appSettingsStore.settings.menu.mode === 'single') {
    return true
  }

  return appSettingsStore.mode === 'mobile'
    || (
      ['side', 'head'].includes(appSettingsStore.settings.menu.mode)
      && appMenuStore.sidebarMenus.length !== 0
      && (
        (
          appSettingsStore.settings.menu.mainMenuClickMode === 'switch'
          && !appMenuStore.sidebarMenus.every(item => item.meta?.menu === false)
        )
        || (
          appSettingsStore.settings.menu.mainMenuClickMode !== 'switch'
          && appMenuStore.sidebarMenus.some(item => item.meta?.menu !== false)
        )
      )
    )
    || (
      ['single'].includes(appSettingsStore.settings.menu.mode)
      && appMenuStore.sidebarMenus.length !== 0
      && !appMenuStore.sidebarMenus.every(item => item.meta?.menu === false)
    )
})

// 顶栏是否显示
const isTopbarEnable = computed(() => true)

// 标签栏是否显示
const isTabbarEnable = computed(() => {
  return appSettingsStore.settings.topbar.tabbar
})

// 工具栏是否显示
const isToolbarEnable = computed(() => {
  const { toolbar } = appSettingsStore.settings
  return appSettingsStore.settings.topbar.toolbar && [
    toolbar.breadcrumb,
    toolbar.menuSearch,
    toolbar.fullscreen,
    toolbar.pageReload,
    toolbar.colorScheme,
  ].some((item) => {
    if (typeof item === 'boolean') {
      return item
    }
    return item?.enable ?? false
  })
})

const isLink = computed(() => !!routeInfo.meta.link)

watch(() => appSettingsStore.settings.menu.subMenuCollapse, (val) => {
  if (appSettingsStore.mode === 'mobile') {
    if (!val) {
      document.body.classList.add('overflow-hidden')
    }
    else {
      document.body.classList.remove('overflow-hidden')
    }
  }
})

watch(() => routeInfo.path, () => {
  if (appSettingsStore.mode === 'mobile') {
    appSettingsStore.$patch((state) => {
      state.settings.menu.subMenuCollapse = true
    })
  }
  /**
   * 主内容区才是真正的滚动容器（`.main-container` 是 `overflow: auto`）：
   * 不同步归零的话，从长页面切到短页面会继承上一个页面的滚动位置、停在页面下方，
   * 看起来就是一片空白。`guards.ts` 里那句 `documentElement.scrollTop = 0` 打不到这里。
   */
  mainContainerRef.value?.scrollTo({ top: 0 })
})

const { y } = useScroll(window)
const { height: fixedContentBeforeAreaHeight } = useElementSize(useTemplateRef('fixedContentBeforeAreaRef'))
const { height: fixedContentAfterAreaHeight } = useElementSize(useTemplateRef('fixedContentAfterAreaRef'))
const topbarScrollVisibleOrHidden = ref(false)
eventBus.on('topbar-scroll-visible-or-hidden', (val) => {
  topbarScrollVisibleOrHidden.value = val
})

function resolveRouterViewKey(route: RouteLocationNormalizedLoaded) {
  if (route.name === 'nodeInstanceConsole') {
    // 控制台页按路由名复用实例：同实例回到页面不重复建连，切换实例由页面内部处理重连。
    return String(route.name)
  }
  return route.fullPath
}

const enableAppSetting = import.meta.env.VITE_APP_SETTING
</script>

<template>
  <div
    class="layout h-full" :style="{
      '--g-slots-layout-top-height': `${layoutTopHeight}px`,
      '--g-slots-layout-bottom-height': `${layoutBottomHeight}px`,
      '--g-header-actual-height': isHeaderEnable ? 'var(--g-header-height)' : '0px',
      '--g-main-sidebar-actual-width': isMainSidebarEnable ? 'var(--g-main-sidebar-width)' : '0px',
      '--g-sub-sidebar-actual-width': isSubSidebarEnable ? (appSettingsStore.settings.menu.subMenuCollapse && appSettingsStore.mode !== 'mobile' ? 'var(--g-sub-sidebar-collapse-width)' : 'var(--g-sub-sidebar-width)') : '0px',
      '--g-topbar-height': 'calc(var(--g-tabbar-actual-height) + var(--g-toolbar-actual-height))',
      '--g-topbar-actual-height': isTopbarEnable ? 'calc(var(--g-tabbar-actual-height) + var(--g-toolbar-actual-height))' : '0px',
      '--g-tabbar-actual-height': isTabbarEnable ? 'var(--g-tabbar-height)' : '0px',
      '--g-toolbar-actual-height': isToolbarEnable ? 'var(--g-toolbar-height)' : '0px',
      '--g-main-container-padding-top': `${fixedContentBeforeAreaHeight}px`,
      '--g-main-container-padding-bottom': `${fixedContentAfterAreaHeight}px`,
    }"
  >
    <div ref="layoutTopRef" class="slots-layout-top mx-auto bg-background w-full shadow-[-1px_0_0_0_oklch(var(--border)),1px_0_0_0_oklch(var(--border)),0_-1px_0_0_oklch(var(--border)),0_1px_0_0_oklch(var(--border))] transition-width-300 inset-t-0 fixed z-1030 empty:hidden">
      <Component :is="useSlots('layout-top')" />
    </div>
    <Header :enable="isHeaderEnable" />
    <div class="wrapper">
      <div class="sidebar-container" :class="{ show: appSettingsStore.mode === 'mobile' && !appSettingsStore.settings.menu.subMenuCollapse }">
        <MainSidebar :enable="isMainSidebarEnable" />
        <SubSidebar :enable="isSubSidebarEnable" />
      </div>
      <!-- 移动端下，展开侧边栏时的遮罩层 -->
      <div :class="cn('invisible fixed inset-0 z-1009 bg-black/50 op-0 backdrop-blur-sm transition-opacity', { 'op-100 visible': appSettingsStore.mode === 'mobile' && !appSettingsStore.settings.menu.subMenuCollapse })" @click="appSettingsStore.toggleSidebarCollapse()" />
      <FloatingSidebarMenuButton />
      <div ref="mainContainerRef" class="main-container pb-[calc(var(--g-slots-layout-bottom-height)+var(--g-main-container-padding-bottom,0px))] pt-[calc(var(--g-slots-layout-top-height)+var(--g-header-actual-height)+var(--g-topbar-actual-height))]">
        <div
          class="fixed-content-around-area w-full inset-t-[calc(var(--g-slots-layout-top-height)+var(--g-header-actual-height))] inset-inline-1/2 fixed z-1005" :style="{
            ...(appSettingsStore.settings.topbar.mode === 'static' && { marginTop: `calc(min(var(--g-topbar-actual-height), ${y}px) * -1)` }),
            ...(topbarScrollVisibleOrHidden && { translate: '0 calc(var(--g-topbar-actual-height) * -1)' }),
          }"
        >
          <Topbar :enable="isTopbarEnable" :enable-tabbar="isTabbarEnable" :enable-toolbar="isToolbarEnable" />
          <div id="fixed-content-before-area" ref="fixedContentBeforeAreaRef" class="shadow-[0_1px_0_0_oklch(var(--border)),0_-1px_0_0_oklch(var(--border))] relative z-1 empty:hidden" />
        </div>
        <div id="app-content" class="main">
          <RouterView v-slot="{ Component, route }">
            <!--
              这里不能写 mode="out-in"（也不能写 "in-out"），原因是它与本项目的 keepAlive 页面结构性冲突，
              不是“概率上偶尔撞上”，而是每次切走一个 keepAlive 页面都必然触发、且无法自愈的白屏：

              1. out-in（Vue 3.5 `runtime-core` BaseTransition）把“等上一页离场”记在一个布尔 `state.isLeaving` 上，
                 而它的 render 第一步就是 `if (state.isLeaving) return emptyPlaceholder(child)`——
                 这个分支排在所有其他判断之前，一旦为真，RouterView 区域从此只渲染一个空占位符，
                 后续任何导航都不会再 patch 页面组件，只有整页刷新能恢复。
              2. 清除它的唯一出口是 `leavingHooks.afterLeave`，而 `afterLeave` 全库唯一的调用点在
                 renderer 的 `remove()` 里——也就是**DOM 元素真的被移除**的那一刻。
              3. 但被 KeepAlive 缓存的页面切走时，`unmount` 会在 `shapeFlag & COMPONENT_SHOULD_KEEP_ALIVE`
                 分支直接 `deactivate(vnode); return`，deactivate 只是把节点 `move` 进一个隐藏容器：
                 没有 `hostRemove`，也就永远没有 `afterLeave`——开关就此永久卡在“正在离场”。

              `menu-routes.ts` 里有 5 个页面开了 `keepAlive`（监控台、实例详情、实例控制台、备份与恢复、计划任务），
              所以 out-in 在这个应用里没有可用场景。默认模式（交叉淡入淡出）根本不会置位 `state.isLeaving`
              ——整个 BaseTransition 里只有 out-in 一个分支写它，上面那类死锁在结构上不可能发生。
              in-out 不置位 `state.isLeaving`，但它同样把「旧节点何时从 DOM 移除」交给 `remove()`
              （`delayLeave` 的唯一调用点在那里），keepAlive 页面切走时这段时序也走不到：旧节点先被搬进隐藏
              容器，再在看不见的地方移除，离场动画等于没有。一并禁掉，别留下这种半失效的写法。
              离场节点靠 `.fade-leave-active` 的 `position: absolute` 脱离文档流，避免与入场节点叠出双倍高度。
              改这段之前请先看 `scripts/check-page-transition.mjs`：它会拦住 `KeepAlive` 与 out-in/in-out 同文件出现。
            -->
            <Transition :name="!appSettingsStore.isReloading ? 'fade' : ''" :duration="{ enter: 200, leave: 150 }">
              <KeepAlive :include="appKeepAliveStore.list">
                <Component :is="Component" v-show="!isLink" :key="resolveRouterViewKey(route)" />
              </KeepAlive>
            </Transition>
          </RouterView>
          <LinkView v-if="isLink" />
        </div>
        <div class="copyright">
          <AppCopyright />
        </div>
        <div class="fixed-content-around-area w-full inset-b-0 inset-inline-1/2 fixed z-1005">
          <div id="fixed-content-after-area" ref="fixedContentAfterAreaRef" class="shadow-[0_1px_0_0_oklch(var(--border)),0_-1px_0_0_oklch(var(--border))] relative z-1 empty:hidden" />
        </div>
      </div>
    </div>
    <div ref="layoutBottomRef" class="slots-layout-bottom mx-auto bg-background w-full shadow-[-1px_0_0_0_oklch(var(--border)),1px_0_0_0_oklch(var(--border)),0_-1px_0_0_oklch(var(--border)),0_1px_0_0_oklch(var(--border))] transition-width-300 inset-b-0 fixed z-1030 empty:hidden">
      <Component :is="useSlots('layout-bottom')" />
    </div>
    <Hotkeys />
    <template v-if="enableAppSetting">
      <div class="text-primary-foreground rounded-l-md bg-primary flex-center size-12 cursor-pointer inset-e-0 inset-t-[calc(50%+250px)] fixed z-10" @click="eventBus.emit('global-app-setting-toggle')">
        <FaIcon name="i-uiw:setting-o" class="size-6 animate-spin animate-duration-3000" />
      </div>
      <AppSetting />
    </template>
    <Component :is="useSlots('free-position')" />
  </div>
</template>

<style scoped>
[data-mode="mobile"] {
  .sidebar-container {
    transform: translateX(calc((var(--g-main-sidebar-width) + var(--g-sub-sidebar-width)) * -1));

    &.show {
      transform: translateX(0);
    }
  }

  .main-container {
    padding-inline-start: 0 !important;
  }

  &[data-menu-mode="single"] {
    .sidebar-container {
      transform: translateX(calc(var(--g-sub-sidebar-width) * -1));

      &.show {
        transform: translateX(0);
      }
    }
  }
}

.layout {
  width: 100%;
  height: 100%;
  margin: 0 auto;
  transition: width 0.3s;
}

.wrapper {
  position: relative;
  width: 100%;
  height: 100%;

  .sidebar-container {
    position: fixed;
    top: calc(var(--g-slots-layout-top-height) + var(--g-header-actual-height));
    bottom: var(--g-slots-layout-bottom-height);
    z-index: 1010;
    display: flex;
    width: calc(var(--g-main-sidebar-actual-width) + var(--g-sub-sidebar-actual-width));
    transition: width 0.3s, transform 0.3s, top 0.3s, box-shadow 0.15s;

    &:has(> .main-sidebar-container.main-sidebar-enter-active),
    &:has(> .main-sidebar-container.main-sidebar-leave-active),
    &:has(> .sub-sidebar-container.sub-sidebar-enter-active),
    &:has(> .sub-sidebar-container.sub-sidebar-leave-active) {
      overflow: hidden;
    }
  }

  .main-sidebar-container:not(.main-sidebar-leave-active) + .sub-sidebar-container {
    inset-inline-start: var(--g-main-sidebar-width);
  }

  .main-container {
    display: flex;
    flex-direction: column;
    min-height: 100%;
    padding-inline-start: calc(var(--g-main-sidebar-actual-width) + var(--g-sub-sidebar-actual-width));
    overflow: auto;
    background-color: var(--g-main-area-bg);
    box-shadow: -1px 0 0 0 oklch(var(--border)), 1px 0 0 0 oklch(var(--border));
    transition: padding-inline-start 0.3s, padding 0.3s, background-color 0.15s, box-shadow 0.15s;

    .fixed-content-around-area {
      width: calc(100% - var(--g-main-sidebar-actual-width) - var(--g-sub-sidebar-actual-width));
      padding-right: var(--scrollbar-width, 0);
      transform: translateX(-50%) translateX(calc(var(--g-main-sidebar-actual-width) / 2)) translateX(calc(var(--g-sub-sidebar-actual-width) / 2));
      transform-origin: left;
      transition: width 0.3s, transform 0.3s, translate 0.3s, top 0.3s;

      [data-mode="mobile"] & {
        width: 100% !important;
        transform: translateX(-50%) !important;
      }
    }

    .main {
      position: relative;
      /* 内容区高度由页面内容决定，不吸收 .main-container 的剩余高度；
         此前是 flex: auto + height: 100%，短内容页面（如监控台）会被拉到整屏，底部留出大片空白 */
      flex: none;
      /*
       * 铺满内容区的整屏页面（Mod 市场、Mod 详情）用这个变量自撑高度。
       * 主内容区高度既然由页面内容决定，页面就不能再靠 `absolute inset-0` 拿高度——
       * 那种写法的父级高度是 0，整页会被这里的 overflow: hidden 裁没。
       */
      --g-main-content-height: calc(100vh - var(--g-slots-layout-top-height) - var(--g-header-actual-height) - var(--g-topbar-actual-height));
      width: 100%;
      padding-top: var(--g-main-container-padding-top, 0);
      margin: 0 auto;
      overflow: hidden;
      background-color: var(--g-main-area-bg);
      box-shadow: -1px 0 0 0 oklch(var(--border)), 1px 0 0 0 oklch(var(--border));
      transition: padding-top 0.3s, width 0.3s, background-color 0.15s, box-shadow 0.15s;
    }

    .copyright {
      position: relative;
      width: 100%;
      /* 内容不足一屏时，版权信息仍贴在底部 */
      margin-top: auto;
      margin-inline: auto;
      background-color: oklch(var(--background));
      box-shadow: -1px 0 0 0 oklch(var(--border)), 1px 0 0 0 oklch(var(--border)), 0 -1px 0 0 oklch(var(--border));
    }
  }
}

/* 主内容区动画 */
.fade-enter-active {
  transition: 0.2s;
}

.fade-leave-active {
  /* 进出场同时进行：离场节点若留在文档流里，会跟进场节点叠出双倍高度，等它卸载时容器高度骤然收缩，
     看起来就是切页时那一下生硬的“上挤”。绝对定位后离场节点只负责淡出，不再参与高度计算。 */
  position: absolute;
  width: 100%;
  transition: 0.15s;
  pointer-events: none;
}

.fade-enter-from {
  opacity: 0;
}

.fade-leave-to {
  opacity: 0;
}
</style>
