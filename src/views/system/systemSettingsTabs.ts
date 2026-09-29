/**
 * 「系统设置」模块的页内 tab 定义。
 *
 * 单独成一个模块，是为了让 `system-pages.test.ts` 能**直接 import** 它做校验
 * （tab 与设置页的 slot 是否一一对应），而不是拿正则去 grep 组件源码——
 * 那种写法改个格式就会假失败。
 *
 * 三个 tab 服务的是同一件事——**面板怎么运行、被谁用过**：面板自身的参数、
 * 它往哪儿发告警、以及谁在什么时候改了什么。
 *
 * 这三个 tab **没有各自的路由**：切 tab 只改组件内的一个 ref，地址栏不动、
 * 页面不重建（理由见 `SystemSettingsTabs.vue` 的注释）。
 *
 * 「插件」页的插件调用审计不在这里：那个记的是**插件**调用了宿主什么能力，
 * 与插件列表是同一个对象，留在插件页。
 */

import type { PermissionKey } from '../../../shared/constants/permissions'

export type SystemSettingsTabName = 'settings' | 'notify' | 'audit'

export interface SystemSettingsTab {
  /** 对应 `settings.vue` 里同名插槽 */
  name: SystemSettingsTabName
  label: string
  /**
   * 进入这个 tab 需要的权限点（**每一项都要满足**）。
   *
   * 为什么必须有它：菜单对「系统设置」是**任一**语义（`['settings:read', 'audit:read']`），
   * 只勾「查看操作记录」的账号也进得来。此前三个 tab 无条件渲染，而页面挂载时无条件请求
   * `settings:read` 的接口——那些请求 403 后整页显示"无法加载系统设置"，
   * **有操作记录权限的账号反而看不到操作记录**。tab 按权限过滤 + 挂载时按需请求才闭环。
   */
  auth: PermissionKey[]
}

export const SYSTEM_SETTINGS_TABS: SystemSettingsTab[] = [
  {
    name: 'settings',
    label: '面板设置',
    // 这一屏的内容全来自 /app/system/settings 与面板更新状态，两者都是 settings:read
    auth: ['settings:read'],
  },
  {
    name: 'notify',
    label: '通知渠道',
    // 通知渠道的读取同样是 settings:read（增删改与测试发送另需 settings:write）
    auth: ['settings:read'],
  },
  {
    name: 'audit',
    label: '操作记录',
    // 操作记录是独立权限点：能读面板设置的人不一定该看到"谁改了什么"
    auth: ['audit:read'],
  },
]

/** 当前账号可见的 tab，顺序与定义一致 */
export function visibleSettingsTabs(
  has: (permission: PermissionKey) => boolean,
): SystemSettingsTab[] {
  return SYSTEM_SETTINGS_TABS.filter(tab => tab.auth.every(key => has(key)))
}

/**
 * 解析进入页面时该落在哪个 tab。
 *
 * - 深链 `?tab=notify` / 旧地址 `/system/notify` 指向的 tab **不可见时回落到第一个可见 tab**：
 *   落到无权内容的空白页比落到自己有权的那一屏更糟；
 * - 一个 tab 都不可见时返回 `null`（正常不会发生：菜单本身就要求这两个权限点之一）。
 */
export function resolveVisibleSettingsTab(
  requested: unknown,
  has: (permission: PermissionKey) => boolean,
): SystemSettingsTabName | null {
  const visible = visibleSettingsTabs(has)
  const matched = visible.find(tab => tab.name === requested)
  return (matched ?? visible[0])?.name ?? null
}
