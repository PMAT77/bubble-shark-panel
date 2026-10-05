<script setup lang="ts">
import type { CapabilityCard } from './home-capabilities'
import { HOME_CAPABILITIES } from './home-capabilities'
import { resolveHomeEntryPath } from './home-entry'

defineOptions({
  name: 'Home',
})

const router = useRouter()

const LINKS = {
  docs: 'https://github.com/PMAT77/bubble-shark-panel#readme',
  github: 'https://github.com/PMAT77/bubble-shark-panel',
} as const

/** 卡片数据在 `home-capabilities.ts`：顺序与菜单一致，且每张卡片跳面板内的对应页面 */
const capabilities = HOME_CAPABILITIES

const useCases = ref([
  { title: '个人开服', description: '在自己电脑或云服务器上一键开服' },
  { title: '小圈子联机', description: '在面板里看日志、发指令，不用 SSH' },
  { title: '社区服运营', description: '一眼看清机器负载与游戏服务状态' },
  { title: '进阶运维', description: 'Mod、备份恢复已内置；计划任务、告警等能力按版本路线图发布' },
])

function open(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer')
}

const appAccountStore = useAppAccountStore()
// 复用统一的权限判定（它同时处理「面板关闭登录」的场景），不要自己读 permissions 数组
const { auth: hasPermission } = useAppAuth()

/** 没登录就没有权限概念，点进页面只会被守卫弹到登录页——这里直接引导登录 */
function canOpen(card: CapabilityCard): boolean {
  if (!appAccountStore.isLogin) {
    return true
  }
  return card.permission ? hasPermission(card.permission) : true
}

function openCapability(card: CapabilityCard) {
  if (!appAccountStore.isLogin) {
    router.push('/login')
    return
  }
  if (!canOpen(card)) {
    return
  }
  router.push(card.route)
}

const appMenuStore = useAppMenuStore()
const appSettingsStore = useAppSettingsStore()

/**
 * 已登录、但一个可见模块都没有。
 *
 * 判据是「全部可见模块为空」。不要用 `sidebarMenus` —— 那是"当前选中主菜单的子菜单"，
 * 有权限的账号在某些情况下也会为空，用它会把正常账号也判成零权限。
 * 未登录时不提示（主页对匿名访客本来就是落地页）。
 */
const hasNoVisibleModule = computed(() => appAccountStore.isLogin && appMenuStore.allMenus.length === 0)

function logout() {
  appAccountStore.logout()
}

function goLogin() {
  if (!appAccountStore.isLogin) {
    router.push('/login')
    return
  }
  /**
   * 已登录：按账号实际能进的页面跳，不要写死实例管理。
   * 面板内的路由是按权限动态注册的，没权限的账号没有 `nodeInstance` 这条记录，
   * 按 name 跳会在 resolve 阶段直接抛 "No match"（守卫兜不住，见 home-entry.ts）。
   */
  const target = resolveHomeEntryPath({
    canReadInstance: hasPermission('instance:read'),
    firstAccessiblePath: appMenuStore.sidebarMenusFirstDeepestPath,
    homePath: appSettingsStore.settings.app.home.fullPath,
  })
  if (!target) {
    // 零权限：页面上方已有提示块，这里只说明按钮为什么没反应
    faToast.warning('当前账号还没有被分配任何模块权限')
    return
  }
  router.push(target)
}
</script>

<template>
  <!--
    这里不要再加 `absolute size-full`：主内容区（layout 的 .main）的高度由页面内容决定，
    绝对定位的根元素不贡献高度，会被 .main 的 overflow: hidden 整块裁掉——
    0.9.0 的「主页一片空白」就是这么来的。滚动由主内容区承担，与其他页面一致。
  -->
  <div class="bg-background">
    <div class="mx-auto px-4 py-6 max-w-7xl md-px-8 md-py-10">
      <!-- Top Bar -->
      <div class="mb-6 flex items-center justify-between">
        <div class="flex gap-3 items-center">
          <AppLogoMark size-class="h-[30px] w-[40px]" class="p-1 border rounded-lg" />
          <span class="tracking-tight font-semibold">BubbleShark Panel</span>
          <span class="text-xs text-muted-foreground px-2 py-0.5 border rounded-full">
            Community · MIT
          </span>
        </div>
      </div>

      <!--
        已登录却一个模块都看不到：多半是还没分配角色。
        这里必须给一个**看得见**的退出入口——侧边栏在菜单为空时整个不渲染，
        而退出按钮原本就在那条侧边栏里，只剩顶栏一个小头像可点。
      -->
      <div
        v-if="hasNoVisibleModule"
        class="mb-6 flex flex-wrap items-center justify-between gap-3 border border-dashed rounded-xl p-4"
      >
        <div class="space-y-1">
          <div class="text-sm font-medium">
            当前账号还没有被分配任何模块权限
          </div>
          <div class="text-sm text-muted-foreground">
            所以左侧没有菜单可显示。请联系管理员为你分配角色与可见实例。
          </div>
        </div>
        <button
          type="button"
          class="shrink-0 border rounded-md px-3 py-1.5 text-sm hover-bg-accent"
          @click="logout"
        >
          退出登录
        </button>
      </div>

      <!-- Hero: Asymmetric split -->
      <div class="mb-6 gap-4 grid items-stretch md-grid-cols-[3fr_2fr]">
        <!-- Left: Title & CTA -->
        <div class="hero-enter p-6 border rounded-xl relative overflow-hidden md-p-8">
          <div class="text-xs text-muted-foreground tracking-widest font-medium mb-3 uppercase">
            开源 · 自托管 · 免费
          </div>
          <h1 class="text-2xl leading-tight tracking-tight font-semibold mb-3 md-text-3xl">
            饥荒联机版专用服，可视化管理
            <div class="text-4xl tracking-tight font-semibold md-text-6xl">
              BubbleShark Panel
            </div>
          </h1>
          <p class="text-sm text-muted-foreground leading-relaxed mb-6 max-w-prose md-text-base">
            给自己的服务器装一个真正好用的饥荒后台。一条命令装好，3 分钟开服；在浏览器里管
            <span class="text-foreground font-medium">世界、Mod、玩家和存档备份</span>，升级面板时玩家不掉线。
          </p>
          <div class="flex flex-wrap gap-3">
            <FaButton size="lg" @click="goLogin">
              {{ appAccountStore.isLogin && hasPermission('instance:read') ? '进入实例管理' : '进入面板' }}
            </FaButton>
            <FaButton variant="outline" size="lg" @click="open(LINKS.docs)">
              项目文档
            </FaButton>
            <FaButton variant="outline" size="lg" @click="open(LINKS.github)">
              <FaIcon name="i-simple-icons:github" class="mr-1" />
              GitHub
            </FaButton>
          </div>
        </div>

        <!-- Right: Stats -->
        <div class="gap-4 grid grid-rows-2">
          <div class="stat-enter border rounded-xl bg-neutral-950/[.012] dark:bg-white/5" :style="{ animationDelay: '100ms' }">
            <div class="p-5 flex flex-col h-full justify-between">
              <div class="text-xs text-muted-foreground tracking-widest font-medium uppercase">
                3 分钟开服
              </div>
              <div>
                <div class="text-3xl tracking-tight font-semibold mb-1 md-text-4xl">
                  Linux
                </div>
                <div class="text-sm text-muted-foreground">
                  一条命令安装，不用预先配好运行环境
                </div>
              </div>
            </div>
          </div>
          <div class="stat-enter border rounded-xl bg-neutral-950/[.012] dark:bg-white/5" :style="{ animationDelay: '200ms' }">
            <div class="p-5 flex flex-col h-full justify-between">
              <div class="text-xs text-muted-foreground tracking-widest font-medium uppercase">
                升级不掉线
              </div>
              <div>
                <div class="text-3xl tracking-tight font-semibold mb-1 md-text-4xl">
                  互不影响
                </div>
                <div class="text-sm text-muted-foreground">
                  升级面板时玩家不掉线
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Use Cases -->
      <div class="mb-6">
        <div class="mb-3 flex gap-2 items-center">
          <div class="rounded-full bg-primary h-4 w-0.5" />
          <h2 class="text-xs text-muted-foreground tracking-widest font-semibold uppercase">
            应用场景
          </h2>
        </div>
        <div class="gap-3 grid grid-cols-2 md-grid-cols-4">
          <div
            v-for="(useCase, i) in useCases"
            :key="useCase.title"
            class="card-enter border rounded-xl bg-neutral-950/[.012] dark:bg-white/5"
            :style="{ animationDelay: `${i * 60}ms` }"
          >
            <div class="p-5">
              <div class="text-sm font-semibold mb-2">
                {{ useCase.title }}
              </div>
              <div class="text-xs text-muted-foreground leading-relaxed">
                {{ useCase.description }}
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Core capabilities -->
      <div>
        <div class="mb-4 flex gap-3 items-center">
          <div class="rounded-full bg-primary h-4 w-0.5" />
          <h2 class="text-xs text-muted-foreground tracking-widest font-semibold uppercase">
            核心能力
          </h2>
        </div>
        <div class="gap-4 grid md-grid-cols-2">
          <div
            v-for="(capability, i) in capabilities"
            :key="capability.name"
            class="group card-enter border rounded-xl bg-neutral-950/[.012] dark:bg-white/5"
            :style="{ animationDelay: `${i * 80}ms` }"
          >
            <div class="flex flex-col h-full">
              <div class="p-6 border-b flex gap-4 items-start">
                <AppLogoMark size-class="h-10 w-10" />
                <div>
                  <div class="text-sm tracking-tight font-semibold">
                    {{ capability.name }}
                  </div>
                  <div class="text-xs text-muted-foreground leading-relaxed mt-1">
                    {{ capability.tagline }}
                  </div>
                </div>
              </div>
              <div class="p-6 flex-col-start flex-1">
                <div class="mb-5 flex-1">
                  <ul class="space-y-1.5">
                    <li
                      v-for="feature in capability.features"
                      :key="feature"
                      class="text-xs text-muted-foreground flex gap-2 items-start"
                    >
                      <span class="text-primary mt-0.5 shrink-0">·</span>
                      <span>{{ feature }}</span>
                    </li>
                  </ul>
                </div>
                <FaButton
                  variant="link"
                  size="sm"
                  class="mt-auto active-scale-98"
                  :disabled="!canOpen(capability)"
                  @click="openCapability(capability)"
                >
                  {{ !appAccountStore.isLogin ? '登录后打开' : canOpen(capability) ? '打开页面 →' : '当前账号无权限' }}
                </FaButton>
              </div>
            </div>
          </div>
        </div>
        <p class="text-xs text-muted-foreground mt-4 text-center">
          当前以饥荒联机版为首个完整适配游戏，之后逐步扩展到更多 Steam 专用服务器
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hero-enter {
  animation: slide-up 1.5s cubic-bezier(0.16, 1, 0.3, 1) both;
}

.stat-enter {
  animation: slide-up 1.5s cubic-bezier(0.16, 1, 0.3, 1) both;
}

.card-enter {
  animation: fade-up 1.4s cubic-bezier(0.16, 1, 0.3, 1) both;
}

@keyframes slide-up {
  from {
    opacity: 0;
    transform: translateY(20px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes fade-up {
  from {
    opacity: 0;
    transform: translateY(10px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.active-scale-98:active {
  transform: scale(0.98);
}
</style>
