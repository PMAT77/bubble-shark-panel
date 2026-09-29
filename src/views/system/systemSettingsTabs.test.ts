import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PermissionKey } from '../../../shared/constants/permissions.ts'
import { isKnownPermission } from '../../../shared/constants/permissions.ts'
import { resolveVisibleSettingsTab, SYSTEM_SETTINGS_TABS, visibleSettingsTabs } from './systemSettingsTabs.ts'

/**
 * 「系统设置」页内 tab 的权限过滤。
 *
 * 这一模块的菜单是**任一**语义（`['settings:read', 'audit:read']`）：只勾「查看操作记录」
 * 的账号照样进得来。此前三个 tab 无条件渲染，而页面挂载时无条件请求 `settings:read`
 * 的接口——那些请求 403 后整页显示"无法加载系统设置"，于是**有操作记录权限的账号
 * 反而看不到操作记录**。这些用例把「谁能看到哪个 tab」与「深链落到哪」钉住。
 */

/** 用权限集合构造 `hasPermission` 判定 */
function has(permissions: readonly string[]) {
  const set = new Set<string>(permissions)
  return (permission: PermissionKey) => set.has(permission)
}

describe('系统设置页内 tab 的权限', () => {
  it('每个 tab 都声明了清单里的权限点', () => {
    for (const tab of SYSTEM_SETTINGS_TABS) {
      assert.ok(tab.auth.length > 0, `tab ${tab.name} 没有声明权限点，等于任何登录账号都能看`)
      for (const key of tab.auth) {
        assert.ok(isKnownPermission(key), `tab ${tab.name} 的权限点未登记：${key}`)
      }
    }
  })

  it('面板设置与通知渠道归 settings:read，操作记录归 audit:read', () => {
    const byName = new Map(SYSTEM_SETTINGS_TABS.map(tab => [tab.name, tab.auth]))
    assert.deepEqual(byName.get('settings'), ['settings:read'])
    assert.deepEqual(byName.get('notify'), ['settings:read'])
    assert.deepEqual(byName.get('audit'), ['audit:read'])
  })

  it('按权限过滤可见 tab', () => {
    assert.deepEqual(visibleSettingsTabs(has([])).map(tab => tab.name), [], '一个权限都没有时没有任何 tab')
    assert.deepEqual(
      visibleSettingsTabs(has(['audit:read'])).map(tab => tab.name),
      ['audit'],
      '只有操作记录权限时不该看到面板设置与通知渠道（那两个 tab 的读取都要 settings:read）',
    )
    assert.deepEqual(
      visibleSettingsTabs(has(['settings:read'])).map(tab => tab.name),
      ['settings', 'notify'],
    )
    assert.deepEqual(
      visibleSettingsTabs(has(['settings:read', 'audit:read'])).map(tab => tab.name),
      ['settings', 'notify', 'audit'],
      '权限齐全时顺序与定义一致',
    )
  })

  it('深链指向无权 tab 时回落到第一个可见 tab', () => {
    assert.equal(resolveVisibleSettingsTab('notify', has(['audit:read'])), 'audit')
    assert.equal(resolveVisibleSettingsTab('audit', has(['settings:read'])), 'settings')
    assert.equal(resolveVisibleSettingsTab('bogus', has(['audit:read'])), 'audit')
    assert.equal(resolveVisibleSettingsTab(undefined, has(['settings:read'])), 'settings')
  })

  it('深链指向有权 tab 时原样落地（深链能力不能被权限过滤吃掉）', () => {
    assert.equal(
      resolveVisibleSettingsTab('audit', has(['settings:read', 'audit:read'])),
      'audit',
      '旧地址 /system/notify 与 ?tab=audit 都要能落到对应 tab',
    )
    assert.equal(resolveVisibleSettingsTab('notify', has(['settings:read', 'audit:read'])), 'notify')
  })

  it('一个 tab 都不可见时返回 null（由菜单保证不会发生）', () => {
    assert.equal(resolveVisibleSettingsTab('settings', has([])), null)
  })
})
