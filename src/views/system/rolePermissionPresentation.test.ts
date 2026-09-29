import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import {
  ALL_PERMISSIONS,
  findPermissionSpec,
  GUEST_ROLE_PERMISSIONS,
  isKnownPermission,
  PERMISSION_GROUPS,
  PERMISSION_SPECS,
} from '../../../shared/constants/permissions.ts'
import {
  buildPermissionGroupViews,
  countSelection,
  DANGEROUS_PERMISSION_KEYS,
  isDangerousPermission,
  isPresetApplied,
  MODULE_MENU_REQUIREMENTS,
  normalizedSelection,
  PERMISSION_GROUP_HINTS,
  PERMISSION_PRESETS,
} from './rolePermissionPresentation.ts'
import { menuRouteList } from '../../../server/src/shared/menu-routes.ts'

/** 折叠区的实现方式要对着组件源码断言，所以这里直接读文件 */
const pickerSourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'components/RolePermissionPicker.vue')

/**
 * 角色权限选择器的展示逻辑。
 *
 * 这里钉住的是「界面为什么看起来是这样」的判据：分组说明是否齐全、起点模板会不会引用到
 * 不存在的权限点、搜索能否按用途命中、以及最要紧的一条——**勾了写权限却没勾查看权限**时
 * 必须给出提示（服务端菜单按 read 权限点过滤，这种组合会让权限实际不生效）。
 */

function groupView(views: ReturnType<typeof buildPermissionGroupViews>, group: string) {
  return views.find(view => view.group === group)
}

function allItems(views: ReturnType<typeof buildPermissionGroupViews>) {
  return views.flatMap(view => view.items)
}

describe('角色权限选择器的展示逻辑', () => {
  it('每个模块分组都有说明文案', () => {
    assert.equal(Object.keys(PERMISSION_GROUP_HINTS).length, PERMISSION_GROUPS.length)
    for (const group of PERMISSION_GROUPS) {
      assert.ok(PERMISSION_GROUP_HINTS[group]?.trim(), `分组「${group}」缺少说明`)
    }
  })

  it('起点模板与危险清单只引用清单里存在的权限点', () => {
    for (const preset of PERMISSION_PRESETS) {
      assert.ok(preset.label.trim(), '起点模板缺少名称')
      assert.ok(preset.description.trim(), `起点「${preset.label}」缺少说明`)
      assert.ok(preset.permissions.length > 0, `起点「${preset.label}」不该是空集合`)
      for (const key of preset.permissions) {
        assert.ok(isKnownPermission(key), `起点「${preset.label}」引用了未知权限点 ${key}`)
      }
    }

    for (const key of DANGEROUS_PERMISSION_KEYS) {
      assert.ok(isKnownPermission(key), `危险清单引用了未知权限点 ${key}`)
      // 只读权限点不该标成「会影响线上或不可恢复」
      assert.equal(findPermissionSpec(key)?.action, 'write', `${key} 是只读权限点，不该标成危险`)
      assert.equal(isDangerousPermission(key), true)
    }
    assert.equal(isDangerousPermission('room:read'), false)
  })

  it('「只读看板」与「完全管理」直接复用权限点真源里的既有清单', () => {
    const readonlyPreset = PERMISSION_PRESETS.find(preset => preset.key === 'readonly')
    const fullPreset = PERMISSION_PRESETS.find(preset => preset.key === 'full')
    assert.ok(readonlyPreset && fullPreset)
    assert.deepEqual([...readonlyPreset.permissions], [...GUEST_ROLE_PERMISSIONS])
    assert.deepEqual([...fullPreset.permissions], [...ALL_PERMISSIONS])
  })

  it('计数以权限点清单为准，未知权限点被忽略', () => {
    assert.equal(countSelection([]).total, PERMISSION_SPECS.length)
    assert.equal(countSelection([]).total, 53)
    assert.equal(countSelection([]).selected, 0)
    assert.equal(countSelection(['room:read', 'bogus:permission']).selected, 1)
    assert.deepEqual([...normalizedSelection(['bogus:permission', 'room:read'])], ['room:read'])
  })

  it('未搜索时每个分组都返回全部权限点，并带三态与说明', () => {
    const views = buildPermissionGroupViews([])
    assert.equal(views.length, PERMISSION_GROUPS.length)

    const player = groupView(views, '玩家')
    assert.ok(player)
    assert.equal(player.total, 5)
    assert.equal(player.selectedCount, 0)
    assert.equal(player.allSelected, false)
    assert.equal(player.partiallySelected, false)
    assert.ok(player.hint.trim())

    const partial = groupView(buildPermissionGroupViews(['player:read', 'player:kick']), '玩家')
    assert.ok(partial)
    assert.equal(partial.selectedCount, 2)
    assert.equal(partial.partiallySelected, true)
    assert.equal(partial.allSelected, false)

    const whole = groupView(
      buildPermissionGroupViews(['player:read', 'player:write', 'player:kick', 'player:ban', 'player.profile:write']),
      '玩家',
    )
    assert.ok(whole)
    assert.equal(whole.allSelected, true)
    assert.equal(whole.partiallySelected, false)

    for (const item of allItems(views)) {
      assert.ok(item.label.trim(), `${item.key} 缺少名称`)
      assert.ok(item.summary.trim(), `${item.key} 缺少说明`)
    }
  })

  it('视图里的危险标记与危险清单一致', () => {
    const dangerous = allItems(buildPermissionGroupViews([]))
      .filter(item => item.dangerous)
      .map(item => item.key)
    assert.deepEqual([...dangerous].sort(), [...DANGEROUS_PERMISSION_KEYS].sort())
  })

  it('勾了写权限却没勾查看权限时，分组自己带出提示标记', () => {
    // 提示只落在分组上（组头的感叹号），不再有抽屉底部的整块警告
    const file = groupView(buildPermissionGroupViews(['file:delete']), '文件')
    assert.ok(file)
    assert.equal(file.needsReadHint, true)

    const player = groupView(buildPermissionGroupViews(['player:read', 'player:ban']), '玩家')
    assert.ok(player)
    assert.equal(player.needsReadHint, false)

    assert.equal(groupView(buildPermissionGroupViews([]), '房间')?.needsReadHint, false)
  })

  it('搜索按名称与用途命中，支持多词', () => {
    const kick = buildPermissionGroupViews([], '踢')
    assert.deepEqual(kick.map(view => view.group), ['玩家'])
    assert.deepEqual(kick[0]?.items.map(item => item.key), ['player:kick', 'player:ban'])

    const backup = buildPermissionGroupViews([], '备份')
    const backupKeys = groupView(backup, '备份')?.items.map(item => item.key) ?? []
    assert.ok(backupKeys.includes('backup:read'))
    assert.ok(backupKeys.includes('backup:restore'))

    const settings = buildPermissionGroupViews([], '面板设置')
    assert.deepEqual(settings.map(view => view.group), ['系统'])
    assert.deepEqual(settings[0]?.items.map(item => item.key), ['settings:read', 'settings:write'])

    // 多词之间是「都要命中」：只靠「玩家」匹配不到的两项被滤掉
    const andSearch = buildPermissionGroupViews([], '踢 玩家')
    assert.deepEqual(andSearch.map(view => view.group), ['玩家'])
    assert.deepEqual(andSearch[0]?.items.map(item => item.key), ['player:kick', 'player:ban'])

    assert.deepEqual(buildPermissionGroupViews([], '不存在的权限'), [])
    // 只有空格视为没搜索
    assert.equal(buildPermissionGroupViews([], '   ').length, PERMISSION_GROUPS.length)
  })

  it('套用判断只认完全相等的选择', () => {
    const ops = PERMISSION_PRESETS.find(preset => preset.key === 'ops')
    assert.ok(ops)
    assert.equal(isPresetApplied([...ops.permissions], ops), true)
    assert.equal(isPresetApplied([...ops.permissions, 'settings:write'], ops), false)
    assert.equal(isPresetApplied([], ops), false)
  })
})

/**
 * 权限组 ↔ 侧边栏入口的对应表。
 *
 * 这张表只服务于「分组里写一行『对应菜单：房间管理』」这句文案，所以在勾选阶段就要和菜单
 * 定义对齐——漂移的表现是"提示的入口和实际出现的入口不是同一个"，没有任何报错。
 *
 * 注意它**只**表达"一个读权限 ↔ 一个菜单"：跨模块数据由接口按各自权限放行
 * （`/app/instance/room-summaries`、`/app/instance/options`…），不写在菜单依赖里。
 */
describe('菜单入口与分组的对应表', () => {
  it('MODULE_MENU_REQUIREMENTS 与菜单声明逐条一致', () => {
    assert.deepEqual(
      MODULE_MENU_REQUIREMENTS.map(item => item.title),
      menuRouteList.map(item => item.meta.title),
      '模块清单与顺序都要跟菜单一致，否则界面上会漏掉或凭空多出入口',
    )

    for (const module of MODULE_MENU_REQUIREMENTS) {
      const menuModule = menuRouteList.find(item => item.meta.title === module.title)
      assert.ok(menuModule, `菜单里没有模块「${module.title}」`)
      // 模块入口就是它的第一个子项：多页模块是 Layout 容器，单页模块是页面本身
      const entry = menuModule.children?.[0]
      assert.ok(entry, `模块「${module.title}」没有入口项`)
      const auth = entry.meta.auth
      assert.deepEqual(
        module.anyOf,
        typeof auth === 'string' ? [auth] : (auth ?? []),
        `「${module.title}」的 anyOf 与菜单的 auth 不一致`,
      )
      assert.equal(
        module.hidden === true,
        menuModule.meta.menu === false,
        `「${module.title}」的隐藏状态与菜单的 menu:false 不一致`,
      )
    }
  })

  it('每个权限组都有模块承载，且菜单入口只用读权限点', () => {
    const covered = new Set(MODULE_MENU_REQUIREMENTS.flatMap(module => module.groups))
    for (const group of PERMISSION_GROUPS) {
      assert.ok(covered.has(group), `分组「${group}」没有任何模块承载，界面上说不出它对应哪个菜单`)
    }
    for (const module of MODULE_MENU_REQUIREMENTS) {
      for (const key of module.anyOf) {
        assert.equal(
          findPermissionSpec(key)?.action,
          'read',
          `「${module.title}」的入口权限里出现了写权限点 ${key}：菜单可见性只由读权限决定`,
        )
      }
    }
  })

  it('插件页当前不在侧边栏里，不当作一个入口', () => {
    assert.equal(MODULE_MENU_REQUIREMENTS.find(module => module.title === '插件')?.hidden, true)
  })
})

/**
 * 折叠区的实现方式也要钉住。
 *
 * 这不是「风格问题」：naive 的 `NCollapseItem` 会把内容插槽标记成 `SlotFlags.STABLE`
 * （`naive-ui/es/collapse/src/CollapseItemContent.mjs`），父组件重渲染时新的插槽内容传不下去，
 * 展开区里的复选框会停在打开那一刻的状态——用户看到的就是「点了只有数字变、勾选框不动，
 * 折叠再展开才对」。换回 naive 的折叠面板等于把这个 bug 再引进来一次。
 */
describe('权限选择器的折叠区', () => {
  it('折叠面板由组件自己实现，不用 naive 的 NCollapse', () => {
    const source = fs.readFileSync(pickerSourcePath, 'utf8')
    assert.equal(
      source.includes('<NCollapse'),
      false,
      '展开区不能换回 NCollapse / NCollapseItem：它的插槽被标记成稳定插槽，展开区不会随数据刷新',
    )
    assert.ok(
      source.includes('expandedGroups'),
      '折叠状态应当由组件自己维护（expandedGroups），否则没法保证展开区跟着数据走',
    )
  })
})
