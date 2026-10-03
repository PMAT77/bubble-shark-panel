import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { SYSTEM_SETTINGS_TABS } from '../../../src/views/system/systemSettingsTabs.ts'

/**
 * 系统设置页的页内 tab 不能变成"又一次跳转"。
 *
 * 背景：这一模块此前的四个页面在菜单里全是隐藏项，彼此只能靠页内按钮跳转，
 * 于是出现过"把设置页里的按钮挪走之后，商业支持与插件变成路由可达但无处可点"的问题。
 * 现在结构是——**商业支持是独立的主导航模块**（插件模块暂时以 `menu: false` 隐藏，
 * 页面与接口都还在），系统设置这一页用 `SystemSettingsTabs` 的三个 tab
 * （面板设置 / 通知渠道 / 操作记录）区分内容，且三个 tab 没有各自的路由。
 *
 * 这个文件钉住四件事：
 *   1. 设置页确实挂载了 tab 组件，可访问；
 *   2. tab 与 `settings.vue` 里的 slot 一一对应（加了 tab 忘了给内容会得到一片空白）；
 *   3. **切 tab 只改本地状态**：组件里不得出现 `router.push` / `router.replace`，
 *      页面上层的 tab 容器也不能带 `:key`（两者都会让整页按 `route.fullPath` 重建）；
 *   4. 地址栏的 `?tab=` 只在挂载时被读一次（深链与旧地址仍能落地），且抹除只走
 *      `history.replaceState`——用 `router.replace` 会让页面重建并多出一个顶栏标签。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const SETTINGS_PAGE_PATH = 'src/views/system/settings.vue'
const TABS_COMPONENT_PATH = 'src/views/system/SystemSettingsTabs.vue'

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

/** 只取 `<script setup>` 段：模板里的文案不该被当作代码断言的目标 */
function readScriptSection(source: string): string {
  const matched = source.match(/<script[^>]*>([\s\S]*?)<\/script>/)
  assert.ok(matched, '组件应当有 <script> 段')
  return matched[1]!
}

describe('系统设置页的页内 tab', () => {
  it('设置页挂载了 tab 组件', () => {
    const settingsSource = readRepoFile(SETTINGS_PAGE_PATH)
    assert.ok(
      settingsSource.includes('<SystemSettingsTabs'),
      '设置页应当挂载 SystemSettingsTabs，否则通知渠道没有任何入口',
    )
  })

  it('tab 与设置页里的 slot 一一对应', () => {
    const settingsSource = readRepoFile(SETTINGS_PAGE_PATH)
    const tabNames = SYSTEM_SETTINGS_TABS.map(tab => tab.name)

    const missingSlots = tabNames.filter(name => !settingsSource.includes(`<template #${name}>`))
    assert.deepEqual(
      missingSlots,
      [],
      `设置页缺少这些 tab 的内容插槽，点进去会是空白：${missingSlots.join('、')}`,
    )
  })

  it('切 tab 不写地址栏、不跳路由：组件里只有一次不带导航的历史改写', () => {
    const script = readScriptSection(readRepoFile(TABS_COMPONENT_PATH))

    for (const forbidden of ['router.push(', 'router.replace(']) {
      assert.equal(
        script.includes(forbidden),
        false,
        `tab 切换不得触发路由跳转（出现 ${forbidden}），否则地址栏一变整页会按 route.fullPath 重建`,
      )
    }

    const replaceStateCalls = script.match(/window\.history\.replaceState\(/g) ?? []
    assert.equal(
      replaceStateCalls.length,
      1,
      `地址栏整理只允许一处 history.replaceState（进入时去掉 ?tab=），实际 ${replaceStateCalls.length} 处`,
    )
    assert.ok(
      script.includes('route.query.tab'),
      '深链 ?tab= 与旧地址 /system/notify 的重定向仍要能落到对应 tab，挂载时应当读一次 query',
    )
  })

  it('设置页不给 tab 容器绑 key，也不自己改写地址栏', () => {
    const settingsSource = readRepoFile(SETTINGS_PAGE_PATH)

    // `<SystemSettingsTabs :key="..."` 这类写法会在切 tab 时换掉 key，等于强制重建整页
    assert.equal(
      /<SystemSettingsTabs[^>]*\s:key=/.test(settingsSource),
      false,
      '设置页不得给 tab 容器绑 key，否则切 tab 会重建整页并丢掉未保存的输入',
    )
    assert.equal(
      settingsSource.includes('history.replaceState'),
      false,
      '地址栏整理应当收在 tab 组件里，避免设置页在别处又写一次地址栏',
    )
  })
})
