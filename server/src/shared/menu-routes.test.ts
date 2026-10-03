import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { FRONTEND_ROUTE_PATHS } from '../../../shared/constants/frontend-routes'
import { ALL_PERMISSIONS, GUEST_EXCLUDED_PERMISSIONS, GUEST_ROLE_PERMISSIONS, isKnownPermission } from '../../../shared/constants/permissions'
import { filterMenuRoutes, menuRouteList } from './menu-routes'
import type { MenuRouteItem } from './menu-routes'

/**
 * 菜单与路由的一致性检查。
 *
 * 菜单是后端驱动的：`component` 是 `src/views/` 下的相对路径，写错不会在编译期报错，
 * 只会在用户点进去时白屏——而这类错误恰恰最容易在"把某个卡片抽成独立页面"时发生。
 *
 * 这里钉住四件事：
 * 1. 每个 `component` 指向的文件真实存在；
 * 2. 页面路径（含 FRONTEND_ROUTE_PATHS 常量）与前端 activeMenu 对得上；
 * 3. 同级菜单项标题不重复（历史上出现过"控制台 > 控制台"式嵌套），
 *    且单页模块不再套同名容器（否则图标栏与二级导航各画一个同名入口）；
 * 4. 每个主导航模块都有可点入口：多页模块靠可见页面，单页模块（系统设置 / 成员管理 / 角色管理）靠页面本身，
 *    防止页面重新变成"路由可达但无处可点"。
 */

/**
 * 暂时从侧边栏隐藏的模块。
 *
 * 隐藏不是「删掉」：这些模块的路由、接口与页面组件都还在，只是入口收起来了，
 * 所以「主导航都有可点入口」那条检查对它们不适用——但必须**显式**列在这里，
 * 而不是靠测试漏过去。将来恢复时删掉名单里的一项，对应用例会立刻要求它重新可点。
 */
const TEMPORARILY_HIDDEN_MODULES = new Set(['插件'])

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/** 递归收集所有菜单项 */
function flatten(items: MenuRouteItem[], acc: MenuRouteItem[] = []): MenuRouteItem[] {
  for (const item of items) {
    acc.push(item)
    if (item.children) {
      flatten(item.children, acc)
    }
  }
  return acc
}

/** 收集所有需要落地的页面组件（Layout 是框架内置容器，不是 views 下的文件） */
function collectViewComponents(items: MenuRouteItem[]): Array<{ component: string, title: string }> {
  return flatten(items)
    .filter(item => typeof item.component === 'string' && item.component !== 'Layout')
    .map(item => ({ component: item.component as string, title: item.meta.title }))
}

/** 收集所有真实落地的页面（不含 Layout 容器） */
function collectPages(): MenuRouteItem[] {
  return flatten(menuRouteList).filter(item => item.component && item.component !== 'Layout')
}

describe('菜单与路由一致性', () => {
  /**
   * 权限体系的两条结构性护栏。
   *
   * 本项目的鉴权是**逐路由手写**的，没有任何全局兜底：忘写权限点即默认公开。
   * 菜单侧同样是手写的，所以这里用测试补上门禁——新增页面时若忘了声明权限点，
   * 或写了一个清单里没有的权限点，测试立刻失败，而不是等到某个账号登录后
   * 发现「他居然能进这一页」。
   */
  it('每个业务页面都声明了权限点，没有「登录即可访问」的页面', () => {
    const missing = collectPages()
      .filter(item => !item.meta.auth)
      .map(item => item.meta.title)
    assert.deepEqual(
      missing,
      [],
      `这些页面没有声明 auth，任何登录账号都能访问：${missing.join('、')}`,
    )
  })

  it('菜单里每一处 auth 都是权限点清单里的权限点', () => {
    const unknown: string[] = []
    for (const item of flatten(menuRouteList)) {
      const auth = item.meta.auth
      if (!auth) {
        continue
      }
      for (const key of Array.isArray(auth) ? auth : [auth]) {
        if (!isKnownPermission(key)) {
          unknown.push(`${item.meta.title} → ${key}`)
        }
      }
    }
    assert.deepEqual(unknown, [], `这些菜单项的权限点不在 shared/constants/permissions.ts 的清单里：\n${unknown.join('\n')}`)
  })

  it('每个菜单页面组件都真实存在', () => {
    const missing: string[] = []
    for (const { component, title } of collectViewComponents(menuRouteList)) {
      const filePath = path.join(repoRoot, 'src', 'views', component)
      if (!fs.existsSync(filePath)) {
        missing.push(`${title} → src/views/${component}`)
      }
    }
    assert.deepEqual(missing, [], `菜单指向了不存在的页面：\n${missing.join('\n')}`)
  })

  it('activeMenu 使用的路径都在前端路由常量里，且与页面路径能对上', () => {
    const knownPaths = new Set<string>(Object.values(FRONTEND_ROUTE_PATHS))
    // 容器自身的路径（如 /system、/console）不需要出现在常量表里，它们只用于分组
    const containerPaths = new Set(
      flatten(menuRouteList)
        .filter(item => item.component === 'Layout')
        .map(item => item.path)
        .filter((value): value is string => typeof value === 'string'),
    )

    const unknown: string[] = []
    for (const item of flatten(menuRouteList)) {
      const activeMenu = item.meta.activeMenu
      if (typeof activeMenu !== 'string') {
        continue
      }
      if (!knownPaths.has(activeMenu) && !containerPaths.has(activeMenu)) {
        unknown.push(`${item.meta.title} 的 activeMenu=${activeMenu}`)
      }
    }
    assert.deepEqual(unknown, [], `activeMenu 指向了未知路径：\n${unknown.join('\n')}`)
  })

  it('同级菜单标题不重复（避免「设置 > 设置」式嵌套）', () => {
    const duplicates: string[] = []
    const walk = (items: MenuRouteItem[], parent: string) => {
      const seen = new Set<string>()
      for (const item of items) {
        if (seen.has(item.meta.title)) {
          duplicates.push(`${parent || '根'} 下重复出现「${item.meta.title}」`)
        }
        seen.add(item.meta.title)
        if (item.children) {
          walk(item.children, item.meta.title)
        }
      }
    }
    walk(menuRouteList, '')
    assert.deepEqual(duplicates, [])
  })

  it('主导航的每个模块都有可点的入口（显示或单页模块；暂时隐藏的除外）', () => {
    // 真正的目标：页面不能是"路由可达但无处可点"。两种满足方式——
    // 多页模块：children 里有可见页面（容器会呈现为可点单项）；
    // 单页模块（当前的「系统设置」「成员管理」「角色管理」）：没有容器，页面本身就是模块入口，
    // 图标栏那一项直接点得进（`MainSidebar` 只要求 children 非空），因此页面可以保持隐藏。
    const unreachable: string[] = []
    const hidden: string[] = []
    for (const group of menuRouteList) {
      if (group.meta.menu === false) {
        hidden.push(group.meta.title)
        continue
      }
      const children = group.children ?? []
      const reachable = {
        visiblePage: flatten(children).some(item => item.meta.menu !== false),
        flatSinglePageModule: children.length === 1 && !!children[0]!.component,
      }
      if (!reachable.visiblePage && !reachable.flatSinglePageModule) {
        unreachable.push(group.meta.title)
      }
    }
    assert.deepEqual(
      unreachable,
      [],
      `以下模块在侧边栏里没有任何可点入口，页面只能靠内部按钮到达：\n${unreachable.join('、')}`,
    )
    // 隐藏名单与实现必须一致：多藏一个会让人以为入口丢了，少藏一个会留下点了没反应的入口
    assert.deepEqual(
      [...hidden].sort(),
      [...TEMPORARILY_HIDDEN_MODULES].sort(),
      `实际隐藏的模块与名单不一致。实际：${hidden.join('、') || '(无)'}`,
    )
  })

  it('暂时隐藏的模块仍然可访问，只是不在菜单里', () => {
    for (const title of TEMPORARILY_HIDDEN_MODULES) {
      const group = menuRouteList.find(item => item.meta.title === title)
      assert.ok(group, `隐藏名单里的「${title}」在菜单数据里不存在`)
      assert.equal(group.meta.menu, false, `「${title}」应当以 menu: false 隐藏，而不是被删掉`)
      // 路由与页面组件都还在：恢复时删掉 menu: false 即可，不必重新接线
      assert.ok((group.children ?? []).length > 0, `「${title}」的路由不该被一并删掉`)
      assert.ok(
        collectPages().some(item => item.meta.title === title),
        `「${title}」的页面组件应当仍然接线，恢复菜单时不需要重新找文件`,
      )
    }
  })

  it('系统设置以页面本身作模块入口：没有容器，页面上也不再出现第二个同名项', () => {
    const systemGroup = menuRouteList.find(item => item.meta.title === '系统设置')
    assert.ok(systemGroup, '应当存在「系统设置」菜单组')

    // 曾经的 bug：模块与子页面各画一个「系统设置」。原因是有 Layout 容器 + 同名子页面两层，
    // 而 `MainSidebar` 取 `children[0].meta.title` 作图标栏（hover）文字——它同样是「系统设置」。
    // 现在只有页面这一项，且它 `menu: false`：侧边栏里只留图标栏那一处，二级导航不再画同名项。
    const entries = systemGroup.children ?? []
    assert.deepEqual(
      entries.map(item => item.meta.title),
      ['系统设置'],
      `「系统设置」模块下应当只有页面这一项，实际：${entries.map(item => item.meta.title).join('、')}`,
    )
    assert.equal(
      entries[0]!.component,
      'system/settings.vue',
      '模块的唯一入口应当是系统设置页本身，而不是 Layout 容器',
    )
    assert.equal(
      entries[0]!.meta.menu,
      false,
      '单页模块的页面必须保持 menu: false，否则二级导航会画出第二个「系统设置」',
    )
    // 这一页含三个 tab（面板设置 / 通知渠道 / 操作记录）：数组是 some 语义，
    // 只给「操作记录」权限的账号也应当进得来，页内 tab 再各自按权限隐藏
    assert.deepEqual(
      entries[0]!.meta.auth,
      ['settings:read', 'audit:read'],
      '系统设置承载端口、更新与自检，应当是只读即可进入；操作记录另有独立权限点',
    )
    assert.equal(
      entries[0]!.meta.activeMenu,
      FRONTEND_ROUTE_PATHS.systemSettings,
      '设置页的 activeMenu 要与前端路径常量一致，否则侧边栏高亮会失效',
    )
    // 面包屑会依次渲染 route.matched 里每一层，这一层必须关掉，否则出现「首页 / 系统设置 / 系统设置」
    assert.equal(
      entries[0]!.meta.breadcrumb,
      false,
      '子页面与模块同名时必须隐藏自己的面包屑，否则面包屑会重复一层',
    )
    assert.equal(
      flatten(entries).some(item => item.component === 'Layout'),
      false,
      '系统设置只有一页，不需要 Layout 容器：容器与子页面同名会再画一个「系统设置」',
    )

    const legacyNamedPages = collectPages().filter(item => item.meta.title === '面板设置')
    assert.deepEqual(
      legacyNamedPages.map(item => item.meta.title),
      [],
      '二级菜单里的「面板设置」应当已被取消，页面标题统一为「系统设置」',
    )
  })

  /**
   * 成员管理 / 角色管理与系统设置同为**单页模块**：模块本身没有 path、没有 Layout 容器，
   * `children` 里只有页面这一项。这条同时挡住两种回归——
   * 又给单页模块套回容器（侧栏会多出一个点不开的空壳），或把页面 path 写成相对值
   * （路由层判定不出单页模块，页面会脱离布局：进这一页后侧栏与顶栏整条不渲染）。
   */
  it('单页模块以页面本身作入口', () => {
    const singlePageTitles = menuRouteList
      .filter((group) => {
        const children = group.children ?? []
        return children.length === 1 && !!children[0]!.component && children[0]!.component !== 'Layout'
      })
      .map(group => group.meta.title)

    const knownPaths = new Set<string>(Object.values(FRONTEND_ROUTE_PATHS))
    for (const group of menuRouteList.filter(item => singlePageTitles.includes(item.meta.title))) {
      const page = (group.children ?? [])[0]!
      const where = `「${group.meta.title}」`
      assert.equal(page.meta.title, group.meta.title, `${where}的页面应与模块同名：入口文字只有一处，不该出现第二个名字`)
      assert.equal(page.meta.menu, false, `${where}的页面必须保持 menu: false，否则二级导航会画出第二个同名项`)
      assert.equal(page.meta.breadcrumb, false, `${where}的容器由路由层补出且与页面同名，页面必须关掉自己的面包屑`)
      assert.ok(
        typeof page.path === 'string' && page.path.startsWith('/'),
        `${where}的页面路径必须是绝对路径：路由层靠它判定单页模块并补布局容器`,
      )
      assert.ok(knownPaths.has(page.path!), `${where}的页面路径 ${page.path} 不在 FRONTEND_ROUTE_PATHS 里`)
      assert.equal(page.meta.activeMenu, page.path, `${where}的 activeMenu 要指向页面自身路径，否则侧栏高亮会失效`)
      assert.ok(group.meta.icon, `${where}应当有图标：单页模块在图标栏/平铺菜单里靠它区分`)
    }
  })


  it('商业支持是独立的主导航模块，插件页面保留但暂从菜单隐藏', () => {
    const topTitles = menuRouteList.map(item => item.meta.title)
    assert.ok(
      topTitles.includes('商业支持与 Pro'),
      `「商业支持与 Pro」应当是主导航模块，实际顶级模块：${topTitles.join('、')}`,
    )
    // 插件仍在菜单数据里（页面可访问），但模块入口暂时收起——见 TEMPORARILY_HIDDEN_MODULES
    assert.ok(topTitles.includes('插件'), `「插件」的模块数据不应当被删掉，实际顶级模块：${topTitles.join('、')}`)

    const pages = collectPages()
    const plugins = pages.find(item => item.meta.title === '插件')
    assert.ok(plugins, '应当存在「插件」页面')
    assert.equal(plugins.meta.auth, 'plugin:read', '插件列表是只读信息；启停与导入另有 plugin:manage')

    const commercial = pages.find(item => item.meta.title === '商业支持与 Pro')
    assert.ok(commercial, '应当存在「商业支持与 Pro」页面')
    // 详情接口只要 license:read，菜单若要求管理权限，只读账号就会看不到自己的授权状态
    assert.equal(commercial.meta.auth, 'license:read', '授权状态是只读信息，应当是只读权限')
  })

  it('独立模块的路由路径与前端常量一致', () => {
    const pages = collectPages()
    const commercial = pages.find(item => item.meta.title === '商业支持与 Pro')
    const plugins = pages.find(item => item.meta.title === '插件')
    assert.equal(commercial?.meta.activeMenu, FRONTEND_ROUTE_PATHS.commercial)
    assert.equal(plugins?.meta.activeMenu, FRONTEND_ROUTE_PATHS.plugins)
    assert.equal(FRONTEND_ROUTE_PATHS.plugins, '/plugins')
    assert.equal(FRONTEND_ROUTE_PATHS.commercial, '/commercial')
    // 旧路径仍在常量表里：前端静态重定向拿它把 /system/notify 引到设置页的通知渠道 tab
    assert.equal(FRONTEND_ROUTE_PATHS.systemNotify, '/system/notify')
  })
})

describe('按权限过滤菜单', () => {
  /** 收集过滤结果里所有页面的标题（不含 Layout 容器） */
  function visiblePageTitles(items: MenuRouteItem[]): string[] {
    return flatten(items)
      .filter(item => item.component && item.component !== 'Layout')
      .map(item => item.meta.title)
  }

  function moduleTitles(items: MenuRouteItem[]): string[] {
    return items.map(item => item.meta.title)
  }

  it('权限齐全时原样返回，一个模块都不少', () => {
    const filtered = filterMenuRoutes(menuRouteList, new Set(ALL_PERMISSIONS))
    assert.deepEqual(
      moduleTitles(filtered),
      moduleTitles(menuRouteList),
      '管理员视角下菜单应当与定义完全一致',
    )
    assert.deepEqual(visiblePageTitles(filtered), visiblePageTitles(menuRouteList))
  })

  it('没有任何权限时，一个模块都不返回', () => {
    // 关键性质：模块的入口也有权限点，所以无权账号拿到的是空菜单，
    // 前端据此连路由都不会注册（routeBaseOn: 'backend'）
    assert.deepEqual(filterMenuRoutes(menuRouteList, new Set()), [])
  })

  it('只给房间权限时，只剩房间管理模块', () => {
    /**
     * 一个菜单项只由**它自己的**读权限决定。
     *
     * 房间列表的数据虽然来自实例，但那是接口的事（`/app/instance/room-summaries` 按
     * `room:read` 放行、只回房间字段）。菜单不因此要「查看实例」——否则取消「查看实例」
     * 会连带收走房间/世界/玩家/Mod/备份/计划任务/成员管理一大串菜单。
     */
    const filtered = filterMenuRoutes(menuRouteList, new Set(['room:read']))
    assert.deepEqual(moduleTitles(filtered), ['房间管理'])
    assert.deepEqual(visiblePageTitles(filtered), ['房间管理', '房间设置'])
  })

  it('取消「查看实例」只影响实例管理，不牵连其它模块', () => {
    // 除 instance:read 之外给全：只有实例管理该消失
    const allExceptInstanceRead = ALL_PERMISSIONS.filter(key => key !== 'instance:read')
    const titles = moduleTitles(filterMenuRoutes(menuRouteList, new Set(allExceptInstanceRead)))
    assert.equal(titles.includes('实例管理'), false, '没有 instance:read 时实例管理必须消失')
    for (const title of ['监控台', '房间管理', '世界管理', '玩家管理', '模组管理', '备份与恢复', '计划任务', '成员管理', '角色管理']) {
      assert.ok(titles.includes(title), `取消查看实例不该牵连「${title}」，实际菜单：${titles.join('、')}`)
    }
  })

  it('游客角色：除成员、角色、插件外，所有模块都看得见', () => {
    /**
     * 这条钉住「游客 = 能看不能改」里的**能看**那一半。
     *
     * 游客的权限集是代码固化的（`GUEST_ROLE_PERMISSIONS`），一旦有人新增了模块却忘了
     * 给它的 read 权限点，这里会立刻失败——否则表现是"游客少了一个页面"，
     * 而少一个页面没有任何报错。
     *
     * 期望值由 `GUEST_EXCLUDED_PERMISSIONS` 推导，而不是写死几个标题：
     * 那份清单是"游客不该看什么"的唯一真源，测试里再抄一遍就会漂移。
     * 逐个权限点对应的模块名不方便反推，所以这里只排除**已知会因此整块消失**的模块名，
     * 并用"清单里的权限点确实都没出现在菜单里"作为交叉校验。
     */
    const filtered = filterMenuRoutes(menuRouteList, new Set(GUEST_ROLE_PERMISSIONS))
    const titles = moduleTitles(filtered)
    const hiddenModules = ['成员管理', '角色管理', '插件']
    const expected = menuRouteList
      .map(item => item.meta.title)
      .filter(title => !hiddenModules.includes(title))
    assert.deepEqual(titles, expected, `游客应当看到除成员/角色/插件外的全部模块，实际：${titles.join('、')}`)

    // 交叉校验：被排除的权限点一个都不该在游客手上，否则"模块消失"就只是巧合
    for (const excluded of GUEST_EXCLUDED_PERMISSIONS) {
      assert.equal(
        GUEST_ROLE_PERMISSIONS.includes(excluded as never),
        false,
        `${excluded} 还在游客权限集里，上面"模块消失"的断言会掩盖它`,
      )
    }

    // 页面级也要对：模块在、页面被权限点挡掉同样会让游客点进去看到空壳
    const pageTitles = visiblePageTitles(filtered)
    const hiddenPages = [...hiddenModules, '实例控制台']
    const expectedPages = visiblePageTitles(menuRouteList).filter(title => !hiddenPages.includes(title))
    assert.deepEqual(pageTitles, expectedPages)
  })

  it('模块入口的权限是数组时按 some 判定：只给操作记录权限也能进系统设置', () => {
    const filtered = filterMenuRoutes(menuRouteList, new Set(['audit:read']))
    assert.deepEqual(
      moduleTitles(filtered),
      ['系统设置'],
      'audit:read 单独存在时系统设置模块必须可见，否则只有操作记录权限的账号无处可去',
    )
  })

  it('成员与角色拆开后，各按自己的权限点出现，谁也不带出谁', () => {
    // 成员页的角色下拉与实例授权走各自的最小投影接口（`/app/system/role-options`、
    // `/app/instance/options`，后者对 member:read 也放行），所以成员管理只需要 member:read。
    const memberOnly = filterMenuRoutes(menuRouteList, new Set(['member:read']))
    assert.deepEqual(moduleTitles(memberOnly), ['成员管理'], 'member:read 应当只带出「成员管理」')
    assert.deepEqual(visiblePageTitles(memberOnly), ['成员管理'], '单页模块的入口就是页面本身')

    const roleOnly = filterMenuRoutes(menuRouteList, new Set(['role:read']))
    assert.deepEqual(moduleTitles(roleOnly), ['角色管理'], 'role:read 应当只带出「角色管理」')

    // 拆开之后不再是「一个模块两个页面靠 some 语义共享入口」：
    // 只给其中一个权限点时，另一页既没有菜单项，前端也不会注册它的路由
    const neither = moduleTitles(filterMenuRoutes(menuRouteList, new Set(['room:read'])))
    assert.equal(
      neither.includes('成员管理') || neither.includes('角色管理'),
      false,
      '没有任何成员/角色权限时，两个模块都不该出现',
    )
  })

  it('过滤结果里每一个页面的权限点都被满足（不变式）', () => {
    const granted = new Set(['room:read', 'instance:read', 'backup:read', 'audit:read'])
    for (const item of flatten(filterMenuRoutes(menuRouteList, granted))) {
      const auth = item.meta.auth
      if (!auth) {
        continue
      }
      const keys = Array.isArray(auth) ? auth : [auth]
      assert.ok(
        keys.some(key => granted.has(key)),
        `${item.meta.title} 的权限点 ${keys.join('/')} 都不在授予集合里，但它出现在过滤结果中`,
      )
    }
  })
})
