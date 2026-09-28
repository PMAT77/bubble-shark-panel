import type { RouteMetaRaw } from '../../../packages/types/types'
import { FRONTEND_ROUTE_PATHS } from '../../../shared/constants/frontend-routes'
import type { PermissionKey } from '../../../shared/constants/permissions'
import {
  NODE_INSTANCE_MANAGE_PERMISSION,
  OPS_MANAGE_PERMISSION,
  OPS_READ_PERMISSION,
  SYSTEM_MANAGE_PERMISSION,
  SYSTEM_READ_PERMISSION,
} from '../../../shared/constants/permissions'

/**
 * 与前端 `vue-router` RouteMeta（RouteMetaRaw）对齐。
 *
 * `auth` 被收窄成 `PermissionKey`（权限点清单里的字面量联合）：菜单是权限体系的第二个消费方
 * （第一个是路由鉴权），写错一个字符就会让「这个角色怎么点都进不去」，而这类错误在运行时
 * 只表现为菜单少一项——所以让 `tsc` 在第一道就拦住它。
 * 数组是 `some` 语义（任一满足即显示），用于「成员与角色」这类两个页面权限不同的模块。
 */
export type MenuRouteMeta = Omit<RouteMetaRaw, 'auth'> & {
  title: string
  auth?: PermissionKey | PermissionKey[]
}

/**
 * 按权限点过滤菜单。
 *
 * 为什么这一步是「直接输地址也进不去」的关键：本项目 `routeBaseOn: 'backend'`
 * （`src/settings.ts`），前端路由**完全由这份菜单生成**——被过滤掉的页面根本不会注册路由，
 * 用户手工输地址只会落到 404 分支。这比「路由注册了但页面靠前端守卫拦」更硬：
 * 后者只要守卫漏一个分支就破功。
 *
 * 过滤规则：
 * - 单项的 `auth` 不满足 → 整项去掉（含它的子树）；
 * - 有子项的模块 → 子项过滤后一个不剩，模块本身也去掉（否则侧边栏会留一个点不开的空壳）；
 * - `auth` 数组是 some 语义，与前端 `useAppAuth().auth()` 保持一致。
 */
export function filterMenuRoutes(items: MenuRouteItem[], granted: ReadonlySet<string>): MenuRouteItem[] {
  const satisfied = (auth: MenuRouteMeta['auth']): boolean => {
    if (!auth) {
      return true
    }
    const keys = Array.isArray(auth) ? auth : [auth]
    return keys.length === 0 || keys.some(key => granted.has(key))
  }

  const result: MenuRouteItem[] = []
  for (const item of items) {
    if (!satisfied(item.meta.auth)) {
      continue
    }
    if (!item.children || item.children.length === 0) {
      result.push(item)
      continue
    }
    const children = filterMenuRoutes(item.children, granted)
    if (children.length === 0) {
      continue
    }
    result.push({ ...item, children })
  }
  return result
}

export interface MenuRouteItem {
  path?: string
  component?: string
  name?: string
  /** vue-router 重定向（用于「单页组」的 Layout 容器直达页面） */
  redirect?: string
  meta: MenuRouteMeta
  children?: MenuRouteItem[]
}

/**
 * 权限点定义在 `shared/constants/permissions.ts`（前端也要用同一份），
 * 这里原样转出，避免既有 import 路径（`server/src/shared/menu-routes`）失效。
 */
export {
  NODE_INSTANCE_MANAGE_PERMISSION,
  OPS_MANAGE_PERMISSION,
  OPS_READ_PERMISSION,
  SYSTEM_MANAGE_PERMISSION,
  SYSTEM_READ_PERMISSION,
}

/**
 * 后端驱动的动态菜单与路由（component 为 views/ 下相对路径）。
 *
 * 菜单组织约定（扁平化，杜绝「控制台>控制台>监控台」式同名嵌套）：
 * - 主导航（图标栏）每一项对应一个页面任务：监控台 / 实例管理 / 房间管理 / 世界管理 / 玩家管理 /
 *   模组管理 / 备份与恢复 / 计划任务 / 商业支持与 Pro / 系统设置——
 *   管理类三项排在最后：前八个是天天要点的，而「系统设置」改完就很少回来，放最末不挡常用项；
 * - **插件模块暂时以 `menu: false` 隐藏**（页面与接口都在，只是不占主导航槽位），
 *   待呈现打磨完再放开；它与「商业支持与 Pro」原本各占一个槽位，服务的是
 *   "我要装什么、我需要什么支持"，与"面板怎么运行"不是同一件事；
 * - 设置页（`system/settings.vue`）用页内 tab 收纳「通知渠道」与「操作记录」，因此系统设置组下只有一个页面；
 * - **多页模块的页面挂在 Layout 容器下**（`component: 'Layout'`），页面自身 `meta.menu: false`，
 *   使容器在菜单中呈现为可点击的单项；容器用 redirect 指向真实页面；
 * - **仅有一个页面的模块不套容器**（当前的「系统设置」）：容器与它唯一的子页面同名时，图标栏已经写着这个名字，
 *   二级导航又照 hover 的名称画一遍同样的文字，看起来就是两个「系统设置」。
 *   直接以页面作模块入口后，侧边栏只剩图标栏那一处；页面自身保持 `menu: false`，否则二级导航会画出第二个同名项；
 * - 列表页 `meta.breadcrumb: false` 避免与容器标题重复；
 * - 房间/世界/Mod 的设置页保持隐藏路由（menu: false），面包屑正常展示，activeMenu 归属列表项。
 */
export const menuRouteList: MenuRouteItem[] = [
  {
    meta: {
      title: '监控台',
      icon: 'ri:pulse-line',
      auth: 'console.monitor:read',
    },
    children: [
      {
        path: '/console',
        component: 'Layout',
        name: 'console',
        redirect: '/console/monitor',
        meta: {
          title: '监控台',
          icon: 'ri:pulse-line',
          auth: 'console.monitor:read',
        },
        children: [
          {
            path: 'monitor',
            name: 'consoleMonitor',
            component: 'console/monitor/index.vue',
            meta: {
              title: '监控台',
              icon: 'ri:pulse-line',
              auth: 'console.monitor:read',
              menu: false,
              breadcrumb: false,
              activeMenu: FRONTEND_ROUTE_PATHS.consoleMonitor,
              keepAlive: true,
            },
          },
        ],
      },
    ],
  },
  {
    meta: {
      title: '实例管理',
      icon: 'ri:stack-line',
    },
    children: [
      {
        path: '/node',
        component: 'Layout',
        name: 'node',
        redirect: FRONTEND_ROUTE_PATHS.nodeInstance,
        meta: {
          title: '实例管理',
          icon: 'ri:stack-line',
          auth: 'instance:read',
        },
        children: [
          {
            path: 'instance',
            name: 'nodeInstance',
            component: 'node/instance/index.vue',
            meta: {
              title: '实例管理',
              icon: 'ri:stack-line',
              auth: 'instance:read',
              menu: false,
              breadcrumb: false,
              activeMenu: FRONTEND_ROUTE_PATHS.nodeInstance,
            },
          },
          {
            path: 'instance/detail/:instanceId',
            name: 'nodeInstanceDetail',
            component: 'node/instance/detail.vue',
            meta: {
              title: '实例详情',
              icon: 'ri:stack-line',
              auth: 'instance:read',
              activeMenu: FRONTEND_ROUTE_PATHS.nodeInstance,
              menu: false,
              keepAlive: true,
            },
          },
          {
            path: 'instance/console/:instanceId',
            name: 'nodeInstanceConsole',
            component: 'node/instance/console.vue',
            meta: {
              title: '实例控制台',
              icon: 'ri:terminal-line',
              auth: 'instance.console:read',
              activeMenu: FRONTEND_ROUTE_PATHS.nodeInstance,
              menu: false,
              keepAlive: true,
            },
          },
        ],
      },
    ],
  },
  {
    meta: {
      title: '房间管理',
      icon: 'ri:home-wifi-line',
    },
    children: [
      {
        path: FRONTEND_ROUTE_PATHS.dstRooms,
        component: 'Layout',
        name: 'dstRooms',
        meta: {
          title: '房间管理',
          icon: 'ri:home-wifi-line',
          auth: 'room:read',
        },
        children: [
          {
            path: '',
            name: 'dstRoomList',
            component: 'games/dst/cluster/index.vue',
            meta: {
              title: '房间管理',
              icon: 'ri:home-wifi-line',
              auth: 'room:read',
              menu: false,
              breadcrumb: false,
              activeMenu: FRONTEND_ROUTE_PATHS.dstRooms,
            },
          },
          {
            path: ':instanceId/settings',
            name: 'dstRoomSettings',
            component: 'games/dst/cluster/settings.vue',
            meta: {
              title: '房间设置',
              icon: 'ri:settings-3-line',
              auth: 'room:read',
              activeMenu: FRONTEND_ROUTE_PATHS.dstRooms,
              menu: false,
            },
          },
        ],
      },
    ],
  },
  {
    meta: {
      title: '世界管理',
      icon: 'ri:earth-line',
    },
    children: [
      {
        path: FRONTEND_ROUTE_PATHS.dstWorlds,
        component: 'Layout',
        name: 'dstWorlds',
        meta: {
          title: '世界管理',
          icon: 'ri:earth-line',
          auth: 'world:read',
        },
        children: [
          {
            path: '',
            name: 'dstWorldList',
            component: 'games/dst/shard/index.vue',
            meta: {
              title: '世界管理',
              icon: 'ri:earth-line',
              auth: 'world:read',
              menu: false,
              breadcrumb: false,
              activeMenu: FRONTEND_ROUTE_PATHS.dstWorlds,
            },
          },
          {
            path: ':instanceId/settings',
            name: 'dstWorldSettings',
            component: 'games/dst/shard/settings.vue',
            meta: {
              title: '世界设置',
              icon: 'ri:landscape-line',
              auth: 'world:read',
              activeMenu: FRONTEND_ROUTE_PATHS.dstWorlds,
              menu: false,
            },
          },
        ],
      },
    ],
  },
  {
    meta: {
      title: '玩家管理',
      icon: 'ri:user-star-line',
    },
    children: [
      {
        path: FRONTEND_ROUTE_PATHS.dstPlayers,
        component: 'Layout',
        name: 'dstPlayers',
        meta: {
          title: '玩家管理',
          icon: 'ri:user-star-line',
          auth: 'player:read',
        },
        children: [
          {
            path: '',
            name: 'dstPlayerList',
            component: 'games/dst/player/index.vue',
            meta: {
              title: '玩家管理',
              icon: 'ri:user-star-line',
              auth: 'player:read',
              menu: false,
              breadcrumb: false,
              activeMenu: FRONTEND_ROUTE_PATHS.dstPlayers,
            },
          },
          {
            path: ':instanceId/manage',
            name: 'dstPlayerManage',
            component: 'games/dst/player/manage.vue',
            meta: {
              // 与列表页「玩家管理」区分开：面包屑与标签页才不会出现两个同名层级
              title: '房间玩家',
              icon: 'ri:user-settings-line',
              auth: 'player:read',
              activeMenu: FRONTEND_ROUTE_PATHS.dstPlayers,
              menu: false,
            },
          },
        ],
      },
    ],
  },
  {
    meta: {
      title: '模组管理',
      icon: 'ri:puzzle-line',
    },
    children: [
      {
        path: FRONTEND_ROUTE_PATHS.dstMods,
        component: 'Layout',
        name: 'dstMods',
        meta: {
          title: '模组管理',
          icon: 'ri:puzzle-line',
          auth: 'mod:read',
        },
        children: [
          {
            path: '',
            name: 'dstModList',
            component: 'games/dst/mod/index.vue',
            meta: {
              title: '模组管理',
              icon: 'ri:puzzle-line',
              auth: 'mod:read',
              menu: false,
              breadcrumb: false,
              activeMenu: FRONTEND_ROUTE_PATHS.dstMods,
            },
          },
          {
            path: ':workshopId/detail',
            name: 'dstModDetail',
            component: 'games/dst/mod/detail.vue',
            meta: {
              title: 'Mod 详情',
              icon: 'ri:puzzle-line',
              auth: 'mod:read',
              activeMenu: FRONTEND_ROUTE_PATHS.dstMods,
              menu: false,
            },
          },
        ],
      },
    ],
  },
  {
    meta: {
      title: '备份与恢复',
      icon: 'ri:archive-line',
    },
    children: [
      {
        path: '/ops',
        component: 'Layout',
        name: 'ops',
        redirect: FRONTEND_ROUTE_PATHS.opsBackups,
        meta: {
          title: '备份与恢复',
          icon: 'ri:archive-line',
          auth: 'backup:read',
        },
        children: [
          {
            path: 'backups',
            name: 'opsBackups',
            component: 'ops/backups/index.vue',
            meta: {
              title: '备份与恢复',
              icon: 'ri:archive-line',
              auth: 'backup:read',
              menu: false,
              breadcrumb: false,
              activeMenu: FRONTEND_ROUTE_PATHS.opsBackups,
              keepAlive: true,
            },
          },
        ],
      },
    ],
  },
  {
    meta: {
      title: '计划任务',
      icon: 'ri:timer-line',
    },
    children: [
      {
        path: '/ops-schedule',
        component: 'Layout',
        name: 'opsSchedule',
        redirect: FRONTEND_ROUTE_PATHS.opsSchedules,
        meta: {
          title: '计划任务',
          icon: 'ri:timer-line',
          auth: 'schedule:read',
        },
        children: [
          {
            path: 'schedules',
            name: 'opsSchedules',
            component: 'ops/schedules/index.vue',
            meta: {
              title: '计划任务',
              icon: 'ri:timer-line',
              auth: 'schedule:read',
              menu: false,
              breadcrumb: false,
              activeMenu: FRONTEND_ROUTE_PATHS.opsSchedules,
              keepAlive: true,
            },
          },
        ],
      },
    ],
  },
  {
    meta: {
      title: '插件',
      icon: 'ri:plug-line',
      /**
       * 暂时从侧边栏隐藏。
       *
       * 插件页（商店形态 + 插件包导入）本身是可用的，只是这一轮的呈现还要再打磨，
       * 所以先把入口收起来。用 `menu: false` 而不是删掉路由，是为了**保留一条可回退的路**：
       * 路由、接口、页面组件都留在原处，后续优化完删掉这一行就恢复成主导航项，
       * 不需要重新接线（`menu-routes.test.ts` 钉住了「页面存在但不在菜单里」这个状态）。
       *
       * 副作用要清楚：插件页此后只能靠直接输地址到达。这正是隐藏的意图，
       * 但别在任何地方留下指向它的链接——那会变成一个点了没反应的入口。
       */
      menu: false,
    },
    children: [
      {
        path: FRONTEND_ROUTE_PATHS.plugins,
        component: 'Layout',
        name: 'plugins',
        redirect: FRONTEND_ROUTE_PATHS.plugins,
        meta: {
          title: '插件',
          icon: 'ri:plug-line',
          auth: 'plugin:read',
        },
        children: [
          {
            path: '',
            name: 'systemPlugins',
            component: 'system/plugins.vue',
            meta: {
              title: '插件',
              icon: 'ri:plug-line',
              auth: 'plugin:read',
              menu: false,
              breadcrumb: false,
              activeMenu: FRONTEND_ROUTE_PATHS.plugins,
            },
          },
        ],
      },
    ],
  },
  {
    meta: {
      title: '商业支持与 Pro',
      icon: 'ri:shield-star-line',
    },
    children: [
      {
        path: FRONTEND_ROUTE_PATHS.commercial,
        component: 'Layout',
        name: 'commercial',
        redirect: FRONTEND_ROUTE_PATHS.commercial,
        meta: {
          title: '商业支持与 Pro',
          icon: 'ri:shield-star-line',
          // 授权状态与人工服务说明本身是只读信息，与详情接口的 license:read 对齐：
          // 有只读权限的账号也该看得到「我买的授权还有多久到期」
          auth: 'license:read',
        },
        children: [
          {
            path: '',
            name: 'systemCommercial',
            component: 'system/commercial.vue',
            meta: {
              title: '商业支持与 Pro',
              icon: 'ri:shield-star-line',
              auth: 'license:read',
              menu: false,
              breadcrumb: false,
              activeMenu: FRONTEND_ROUTE_PATHS.commercial,
            },
          },
        ],
      },
    ],
  },
  {
    meta: {
      title: '成员与角色',
      icon: 'ri:team-line',
    },
    children: [
      {
        path: FRONTEND_ROUTE_PATHS.members,
        component: 'Layout',
        name: 'members',
        redirect: FRONTEND_ROUTE_PATHS.membersList,
        meta: {
          title: '成员与角色',
          icon: 'ri:team-line',
          // 数组是 some 语义：只给「角色管理」权限的账号也该看到这个模块入口，
          // 否则它只能靠直接输地址到达角色页——那是个没有入口的死页面。
          auth: ['member:read', 'role:read'],
        },
        children: [
          {
            path: 'list',
            name: 'membersList',
            component: 'system/members.vue',
            meta: {
              title: '成员管理',
              icon: 'ri:user-settings-line',
              auth: 'member:read',
              menu: false,
              breadcrumb: false,
              activeMenu: FRONTEND_ROUTE_PATHS.membersList,
            },
          },
          {
            path: 'roles',
            name: 'membersRoles',
            component: 'system/roles.vue',
            meta: {
              title: '角色管理',
              icon: 'ri:shield-user-line',
              auth: 'role:read',
              menu: false,
              breadcrumb: false,
              activeMenu: FRONTEND_ROUTE_PATHS.roles,
            },
          },
        ],
      },
    ],
  },
  {
    meta: {
      title: '系统设置',
      icon: 'ri:settings-3-line',
    },
    children: [
      // 这一组**不再有 Layout 中间层**：它只有一个页面，套一层同名容器会让二级导航
      // 在图标栏已经写了「系统设置」的情况下再画一遍「系统设置」，看起来就是两个嵌套的同名菜单。
      // 直接以页面作模块唯一入口后，侧边栏里只剩图标栏那一处（`MainSidebar` 用 children 渲染它）。
      {
        path: FRONTEND_ROUTE_PATHS.systemSettings,
        name: 'systemSettings',
        component: 'system/settings.vue',
        meta: {
          title: '系统设置',
          icon: 'ri:settings-3-line',
          // 这一页含三个 tab（面板设置 / 通知渠道 / 操作记录），权限要求不同：
          // 只给「操作记录」权限的账号也该进得来，页内 tab 再按各自的权限点隐藏。
          auth: ['settings:read', 'audit:read'],
          breadcrumb: false,
          activeMenu: FRONTEND_ROUTE_PATHS.systemSettings,
          // 单页模块的页面在菜单里保持隐藏：容器已经没有了，若让它可见，
          // 二级导航又会画出第二个「系统设置」（`Menu/index.vue` 的单项分支）。
          // 图标栏那一项照样可点：`MainSidebar` 只要求模块的 children 非空。
          menu: false,
        },
      },
    ],
  },
]
