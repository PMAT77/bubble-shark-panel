import type { PermissionKey } from '../../../../shared/constants/permissions'
import type { MenuRecordMainRaw, MenuRecordRaw, RouteRecordMainRaw } from '@fantastic-admin/types'
import { cloneDeep } from 'es-toolkit'
import type { MenuRouteItemLike } from './route-layout'
import { convertRouteToMenuRecursive, flattenModuleChildrenForSingleMode } from './menu-flatten'
import { isRouteOnlyLayoutContainer } from './route-layout'
import { resolveRoutePath } from '@/utils'

export const useAppMenuStore = defineStore(
  'appMenu',
  () => {
    const appSettingsStore = useAppSettingsStore()
    const appRouteStore = useAppRouteStore()

    // 将原始路由转换成导航菜单
    function convertRouteToMenu(routes: RouteRecordMainRaw[]): MenuRecordMainRaw[] {
      const returnMenus: MenuRecordMainRaw[] = []
      routes.forEach((item) => {
        if (item.children.length > 0) {
          /**
           * 以 `meta.menu === false` 隐藏整个模块（后端 `menuRouteList` 里就能这样声明）。
           *
           * 为什么在这里过滤，而不是像子菜单那样带着 `menu` 标记交给渲染层判断：
           * 框架类型把主导航的 meta 限制成 `Pick<RouteMetaRaw, 'auth' | 'title' | 'icon'>`
           * （见 `packages/types/types.ts` 的 `MenuRecordMainRaw`），**`menu` 在这个层级
           * 根本无法用类型表达**。硬塞需要断言，而断言会让下一个人以为这是类型疏忽，
           * 再顺手删掉——那样菜单又会自己冒出来，且编译、单测都不会报错。
           *
           * 由此产生的行为差异要记住：模块只是从**前端菜单**里消失，路由本身仍在
           * `routesRaw` 中，所以直接输地址照样打得开；代价是该页面不会有主导航项高亮
           * （`setActived` 找不到对应的菜单索引，会保持当前索引不变）。
           */
          if ((item.meta as { menu?: boolean } | undefined)?.menu === false) {
            return
          }
          /**
           * 跳过路由层为单页模块补出来的**纯容器层**（`src/store/modules/app/route-layout.ts` 的
           * `mountLayoutForSinglePageModules`）：它只为把页面放进布局容器，自身没有意义，
           * 若照常渲染，侧栏会同时出现容器与页面两个同名入口——正是这个单页模块当初被
           * 改成扁平结构的原因。页面本身仍是模块下唯一的可见项（见下方 single 分支）。
           *
           * 注入出来的容器实际落在**模块的 children 里**，到不了这一层；真正剥掉它的是
           * `flattenModuleChildrenForSingleMode`（单栏模式）与 Menu 的 `menu === false` 过滤
           * （side / head 模式）。这里保留判断，是为了模块自己哪天真的成了一个容器层。
           */
          if (isRouteOnlyLayoutContainer(item as unknown as MenuRouteItemLike)) {
            return
          }
          if (appSettingsStore.settings.menu.mode === 'single') {
            returnMenus.length === 0 && returnMenus.push({
              meta: {},
              children: [],
            })
            // 必须以模块容器 path 作为 basePath：否则子菜单项 path 是相对值
            // （如 'instance'、''），router.push 时会相对当前页面解析，
            // 从深层页面（实例详情等）点击菜单会解析出错误 URL。
            // 单页模块（系统设置）在这里被标记为可见——single 模式没有图标栏兜底，
            // 详见 flattenModuleChildrenForSingleMode 的注释。
            returnMenus[0].children.push(...flattenModuleChildrenForSingleMode(
              item.children,
              item.path ?? '',
              appSettingsStore.settings.menu.mode,
              // `RouteMetaRaw.title` 允许函数式动态标题（`string | (() => string)`），
              // 而菜单项文字只接受字符串：取函数时退回可用值，别把函数当标题传下去。
              typeof item.meta?.title === 'string' ? item.meta.title : item.meta?.title?.(),
            ))
          }
          else {
            const menuItem: MenuRecordMainRaw = {
              meta: {
                title: item?.meta?.title,
                icon: item?.meta?.icon,
                auth: item?.meta?.auth,
              },
              children: [],
            }
            menuItem.children = convertRouteToMenuRecursive(item.children, item.path)
            returnMenus.push(menuItem)
          }
        }
      })
      return returnMenus
    }

    // 完整导航数据
    const allMenus = computed(() => filterAsyncMenus(convertRouteToMenu(appRouteStore.routesRaw)))

    function normalizeActivedIndex(index: number) {
      if (allMenus.value.length === 0) {
        return 0
      }
      if (Number.isNaN(index) || index < 0) {
        return 0
      }
      if (index >= allMenus.value.length) {
        return allMenus.value.length - 1
      }
      return index
    }
    // 原始记录值：保存最近一次被设置的主导航索引
    // 当 allMenus 变化后，它可能暂时变成过期值，因此不应该直接在外部使用
    const activedOriginal = ref(0)
    // 对外可用值：始终基于 allMenus 当前长度做安全修正
    // 外部读取 actived 时，拿到的一定是当前有效索引
    const actived = computed({
      get: () => normalizeActivedIndex(activedOriginal.value),
      set: value => activedOriginal.value = normalizeActivedIndex(value),
    })

    // 次导航数据
    const sidebarMenus = computed<MenuRecordMainRaw['children']>(() => {
      return allMenus.value.length > 0
        ? allMenus.value[normalizeActivedIndex(actived.value)].children
        : []
    })
    // 次导航第一层最深路径
    const sidebarMenusFirstDeepestPath = computed(() => {
      return sidebarMenus.value.length > 0
        ? getDeepestPath(sidebarMenus.value[0])
        : appSettingsStore.settings.app.home.fullPath
    })
    function getDeepestPath(menu: MenuRecordRaw, rootPath = '') {
      let retnPath = ''
      if (menu.children?.some(item => item.meta?.menu !== false)) {
        const item = menu.children.find(item => item.meta?.menu !== false)
        if (item) {
          retnPath = getDeepestPath(item, resolveRoutePath(rootPath, menu.path))
        }
        else {
          retnPath = getDeepestPath(menu.children[0], resolveRoutePath(rootPath, menu.path))
        }
      }
      else {
        retnPath = resolveRoutePath(rootPath, menu.path)
      }
      return retnPath
    }
    // 次导航是否有且只有一个可访问的菜单
    const sidebarMenusHasOnlyMenu = computed(() => {
      return isSidebarMenusHasOnlyMenu(sidebarMenus.value)
    })
    function isSidebarMenusHasOnlyMenu(menus: MenuRecordRaw[]) {
      let count = 0
      let isOnly = true
      menus.forEach((menu) => {
        if (menu.meta?.menu !== false) {
          count++
        }
        if (menu.children) {
          isOnly = isSidebarMenusHasOnlyMenu(menu.children)
        }
      })
      return count <= 1 && isOnly
    }

    function getExpandPaths(menus: MenuRecordRaw[], rootPath = '') {
      const expandPaths: string[] = []
      menus.forEach((item) => {
        if (item.children) {
          if (item.meta?.expand) {
            expandPaths.push(resolveRoutePath(rootPath, item.path))
          }
          const childrenExpandPaths = getExpandPaths(item.children, resolveRoutePath(rootPath, item.path))
          if (childrenExpandPaths.length > 0) {
            expandPaths.push(...childrenExpandPaths)
          }
        }
      })
      return expandPaths
    }
    // 默认展开的导航路径
    const defaultExpandPaths = computed(() => {
      const defaultExpandPaths: string[] = []
      allMenus.value.forEach((item) => {
        defaultExpandPaths.push(...getExpandPaths(item.children))
      })
      return defaultExpandPaths
    })

    const auth = useAppAuth()
    // 根据权限过滤导航
    function filterAsyncMenus<T extends MenuRecordMainRaw[] | MenuRecordRaw[]>(menus: T): T {
      const res: any = []
      menus.forEach((menu) => {
        /**
         * 菜单的可见性只看 `auth`：一个菜单项由它**自己的**读权限决定
         * （跨模块数据由接口按各自权限放行，不给菜单加别的模块的权限）。
         * 服务端 `filterMenuRoutes` 已经按同一套规则过滤过一遍，这里是第二道闸：
         * `routeBaseOn: 'frontend'` 的部署形态下没有服务端菜单接口兜底。
         */
        if (auth.auth((menu.meta?.auth ?? '') as PermissionKey | PermissionKey[] | '')) {
          const tmpMenu = cloneDeep(menu)
          if (tmpMenu.children && tmpMenu.children.length > 0) {
            tmpMenu.children = filterAsyncMenus(tmpMenu.children) as MenuRecordRaw[]
            tmpMenu.children.length > 0 && res.push(tmpMenu)
          }
          else {
            delete tmpMenu.children
            res.push(tmpMenu)
          }
        }
      })
      return res
    }
    // 设置主导航
    function isPathMatchMenu(path: string, menuPath: string) {
      return path.indexOf(`${menuPath}/`) === 0 || path === menuPath
    }
    function isPathInMenus(menus: MenuRecordRaw[], path: string): boolean {
      return menus.some((item): boolean => {
        if (!item.path) {
          if (item.children?.length) {
            return isPathInMenus(item.children, path)
          }
          return false
        }
        const matched = isPathMatchMenu(path, item.path)
        if (item.children?.length) {
          return matched || isPathInMenus(item.children, path)
        }
        return matched
      })
    }
    /** 根据当前路由解析用于主导航定位的路径（优先 activeMenu） */
    function resolveActivedPathFromRoute(route: { path: string, meta?: { activeMenu?: string } }) {
      const activeMenu = route.meta?.activeMenu
      return typeof activeMenu === 'string' && activeMenu.length > 0 ? activeMenu : route.path
    }
    function setActived(indexOrPath: number | string) {
      if (typeof indexOrPath === 'number') {
        // 如果是 number 类型，则认为是主导航的索引
        actived.value = indexOrPath
      }
      else {
        // 如果是 string 类型，则认为是路由，需要查找对应的主导航索引
        const findIndex = allMenus.value.findIndex(item => isPathInMenus(item.children, indexOrPath))
        if (findIndex >= 0) {
          actived.value = findIndex
        }
      }
    }

    return {
      actived,
      allMenus,
      sidebarMenus,
      sidebarMenusFirstDeepestPath,
      sidebarMenusHasOnlyMenu,
      defaultExpandPaths,
      setActived,
      resolveActivedPathFromRoute,
    }
  },
)
