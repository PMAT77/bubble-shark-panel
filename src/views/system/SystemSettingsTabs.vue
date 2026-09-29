<script setup lang="ts">
import { NTabPane, NTabs } from 'naive-ui'
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { resolveVisibleSettingsTab, visibleSettingsTabs } from './systemSettingsTabs'
import type { SystemSettingsTabName } from './systemSettingsTabs'

/**
 * 「系统设置」模块的页内 tab：面板设置 / 通知渠道 / 操作记录。
 *
 * 为什么是 tab 而不是各自一个页面：它们服务的是同一件事——**面板怎么运行、被谁用过**，
 * 一边是面板自身的参数，一边是它往哪儿发告警，一边是谁在什么时候改了什么。
 *
 * **切 tab 只改组件内的一个 ref，不写地址栏、不走路由。** 这不是"少写一行 router.replace"，
 * 而是因为写地址栏会连带两件代价：页面组件的 key 是 `route.fullPath`（`layouts/index.vue`），
 * query 一变整页卸载重建——表单回到服务端快照、通知渠道与操作记录重新拉数据；
 * 顶栏标签以 `route.fullPath` 为 id，每个 `?tab=` 取值还会多出一个标签。
 * 用本地状态后，切走再切回不丢未保存的输入，也不会平白多出标签页。
 *
 * 地址栏只在**进入时被读一次**：`?tab=notify` / `?tab=audit` 与旧地址 `/system/notify`
 * 的重定向仍能把人送到对应 tab（深链能力保留），随后这次参数会被一次性抹掉，
 * 地址栏稳定在 `/system/settings`。抹除用 `history.replaceState` 而不是 `router.replace`——
 * 后者正是上面那段代价的来源。
 *
 * 「插件」与「商业支持与 Pro」不走这里：它们已各自是一个主导航模块
 * （见 `server/src/shared/menu-routes.ts`）——装什么插件、需要什么支持，
 * 与"面板怎么运行"不是同一件事，塞在同一页会让两边都不好找。
 *
 * tab 清单与设置页的 slot 内容成对出现（`systemSettingsTabs.ts` ↔ `settings.vue`），
 * `system-pages.test.ts` 会检查两边是否一致。
 */

defineOptions({
  name: 'SystemSettingsTabs',
})

const route = useRoute()

/**
 * 只渲染当前账号有权限的 tab。
 *
 * 菜单对「系统设置」是任一语义（`settings:read` 或 `audit:read`），所以进得来不等于
 * 三个 tab 都能看：只勾「查看操作记录」的账号点「通知渠道」只会看到一堆 403。
 */
const { auth: hasPermission } = useAppAuth()
const tabs = computed(() => visibleSettingsTabs(hasPermission))

/**
 * 当前 tab。初始为 `null`（还没解析），挂载时由 `resolveVisibleSettingsTab` 定下来——
 * 用 `?tab=` 指向一个**自己无权**的 tab 时回落到第一个可见 tab，而不是落到空白页。
 */
const activeTab = ref<SystemSettingsTabName | null>(null)

/**
 * 点 tab：只切本地状态，不碰路由。
 * naive-ui 的 value 类型是 `string | number`，这里按清单收窄；对不上的值直接忽略，
 * 宁可停在当前 tab，也不要切到一个没有内容的空页。
 */
function selectTab(value: string | number) {
  const matched = tabs.value.find(tab => tab.name === value)
  if (matched) {
    activeTab.value = matched.name
  }
}

onMounted(() => {
  activeTab.value = resolveVisibleSettingsTab(route.query.tab, hasPermission)

  // 参数已消费，把地址栏收拾干净：不经过 vue-router，因此不会重建页面、也不会多出标签页。
  // history.state 是 vue-router 自己的状态，原样带回，否则前进/后退会错乱。
  if (route.query.tab === undefined) {
    return
  }
  try {
    if (typeof window !== 'undefined' && typeof window.history?.replaceState === 'function') {
      window.history.replaceState(window.history.state, '', window.location.pathname)
    }
  }
  catch (error) {
    // 个别嵌入式浏览器会拒绝改写历史：此时只是地址栏留着 ?tab=，不影响 tab 切换本身
    console.debug('[system-settings] 清理地址栏 tab 参数失败', error)
  }
})
</script>

<template>
  <NTabs :value="activeTab ?? tabs[0]?.name" type="line" size="small" @update:value="selectTab">
    <NTabPane
      v-for="item in tabs"
      :key="item.name"
      :name="item.name"
      :tab="item.label"
      display-directive="if"
    >
      <slot :name="item.name" />
    </NTabPane>
  </NTabs>
</template>
