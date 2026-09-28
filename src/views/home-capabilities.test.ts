import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { RouteLocationRaw } from 'vue-router'
import { FRONTEND_ROUTE_PATHS } from '../../shared/constants/frontend-routes.ts'
import { isKnownPermission } from '../../shared/constants/permissions.ts'
import { menuRouteList } from '../../server/src/shared/menu-routes.ts'
import { ROUTE_NAMES } from '@/navigation/game-routes'
import { HOME_CAPABILITIES } from './home-capabilities.ts'

/**
 * 首页核心能力卡片的约束。
 *
 * 这些约定靠肉眼维护必然漂移——加了一个菜单页忘了改主页、改名后两边不一致，
 * 而主页恰恰是最多人看的一屏。这里用三条断言把它钉住：
 *   1. 卡片顺序 = 左侧菜单顺序（去掉主页不展示的管理类页面）；
 *   2. 每张卡片的路由名真实存在于 `ROUTE_NAMES`（写错名字只会在点击时静默失败）；
 *   3. 卡片不重复、每条能力都有说明文字。
 */

/**
 * 主页不展示的管理类模块。新增系统设置组页面时要跟着补——
 * `home-capabilities.test.ts` 里那条"跳过的必须都是系统设置相关的页"会拦住漏掉的页面。
 *
 * 「插件」目前还以 `menu: false` 从侧边栏隐藏着，但它仍然算一个菜单模块
 * （路由与页面都在，只是入口收起来了），所以留在这份名单里：等它恢复成主导航项时，
 * 主页要不要给它一张卡片是一个需要重新做决定的问题，不该被顺手跳过。
 */
const ADMIN_ONLY_MODULES = new Set(['系统设置', '插件', '商业支持与 Pro', '成员与角色'])

/** 从菜单里取出「主页应该展示的任务顺序」：只保留面向日常使用的页面，跳过管理类 */
function expectedHomeOrder(): string[] {
  const order: string[] = []
  for (const group of menuRouteList) {
    const title = group.meta.title
    if (ADMIN_ONLY_MODULES.has(title)) {
      continue
    }
    // 同一任务可能由多个菜单项组成（如「实例管理」下还有详情与控制台），只取一次
    if (!order.includes(title)) {
      order.push(title)
    }
  }
  return order
}

function routeNameOf(route: RouteLocationRaw): string | undefined {
  return typeof route === 'object' && route !== null && 'name' in route
    ? String(route.name)
    : undefined
}

describe('首页核心能力卡片', () => {
  it('顺序与左侧菜单一致（跳过管理类页面）', () => {
    const menuOrder = expectedHomeOrder()
    const homeOrder = HOME_CAPABILITIES.map(card => card.name)

    /**
     * 「实例管理」在菜单里同时承载实例列表、详情与控制台三个页面，
     * 主页把它合成一张卡片，因此允许主页顺序是菜单顺序的**子序列**：
     * 每一项都要在菜单里按同样次序出现，但不要求数量相等。
     */
    const filtered = menuOrder.filter(name => homeOrder.includes(name))
    assert.deepEqual(homeOrder, filtered, `主页卡片顺序应与菜单一致。\n菜单：${menuOrder.join(' → ')}\n主页：${homeOrder.join(' → ')}`)
  })

  it('跳过的都是真实存在的模块，且没有别的模块被漏在主页之外', () => {
    const moduleTitles = menuRouteList.map(group => group.meta.title)
    for (const skipped of ADMIN_ONLY_MODULES) {
      assert.ok(
        moduleTitles.includes(skipped as never),
        `跳过的「${skipped}」在菜单里根本不存在，说明主页的跳过名单已经过期`,
      )
    }
    // 除了明确跳过的，其余模块都应当能在主页上被找到；新增模块忘了加卡片就会在这里失败
    const homeOrder = HOME_CAPABILITIES.map(card => card.name)
    const uncovered = moduleTitles.filter(title => !ADMIN_ONLY_MODULES.has(title) && !homeOrder.includes(title))
    assert.deepEqual(uncovered, [], `这些模块在主页上没有入口，且没有被列入跳过名单：${uncovered.join('、')}`)
  })

  it('每张卡片都包含用户点名要的模块', () => {
    const names = HOME_CAPABILITIES.map(card => card.name)
    for (const required of ['监控台', '实例管理', '房间管理', '世界管理', '玩家管理', '模组管理', '备份与恢复', '计划任务']) {
      assert.ok(names.includes(required), `主页缺少「${required}」卡片，实际：${names.join('、')}`)
    }
  })

  it('卡片名不重复，且每条能力都有说明', () => {
    const names = HOME_CAPABILITIES.map(card => card.name)
    assert.equal(new Set(names).size, names.length, `卡片名重复：${names.join('、')}`)
    for (const card of HOME_CAPABILITIES) {
      assert.ok(card.tagline.trim().length > 0, `${card.name} 缺少一句话说明`)
      assert.ok(card.features.length >= 3, `${card.name} 的能力点太少（${card.features.length} 条）`)
      for (const feature of card.features) {
        assert.ok(feature.trim().length > 0, `${card.name} 存在空的能力点`)
      }
    }
  })

  it('每张卡片的路由名都真实存在（写错只会在点击时静默失败）', () => {
    const known = new Set(Object.values(ROUTE_NAMES))
    const unknown: string[] = []
    for (const card of HOME_CAPABILITIES) {
      const name = routeNameOf(card.route)
      if (!name || !known.has(name as never)) {
        unknown.push(`${card.name} → ${name ?? '(无 name)'}`)
      }
    }
    assert.deepEqual(unknown, [], `卡片路由名不在 ROUTE_NAMES 中：\n${unknown.join('\n')}`)
  })

  it('每张卡片都声明了权限点，且都在权限点清单里', () => {
    for (const card of HOME_CAPABILITIES) {
      // 卡片是「点一下打开对应页面」的入口：缺权限点的卡片会让无权账号点进一个打不开的页面，
      // 而首页此前正是靠这张卡片在替用户判断"我能不能进"——所以一张都不许留空。
      assert.ok(card.permission, `${card.name} 应当声明权限点，否则任何登录用户都能进`)
      assert.ok(
        isKnownPermission(card.permission),
        `${card.name} 的权限点未在 shared/constants/permissions.ts 的清单里：${card.permission}`,
      )
    }
  })

  it('页面路径常量覆盖了卡片跳转到的菜单（避免只写 name 不写 path 的漂移）', () => {
    // 这几项是主页新增跳转的页面，必须同时有路径常量（菜单 activeMenu 与前端跳转都用它）
    for (const path of [
      FRONTEND_ROUTE_PATHS.consoleMonitor,
      FRONTEND_ROUTE_PATHS.nodeInstance,
      FRONTEND_ROUTE_PATHS.dstRooms,
      FRONTEND_ROUTE_PATHS.dstWorlds,
      FRONTEND_ROUTE_PATHS.dstPlayers,
      FRONTEND_ROUTE_PATHS.dstMods,
      FRONTEND_ROUTE_PATHS.opsBackups,
      FRONTEND_ROUTE_PATHS.opsSchedules,
    ]) {
      assert.match(path, /^\//, `路径常量必须是绝对路径：${path}`)
    }
  })
})
