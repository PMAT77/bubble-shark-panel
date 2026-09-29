/**
 * 权限快照是否过期。
 *
 * 背景：前端把"我能进哪些页面"固化成**登录时的一次快照**——`/app/route/list` 决定侧边栏
 * 与已注册的路由（`src/store/modules/app/route.ts`），`/app/account/permission` 决定
 * 按钮级判定（`src/store/modules/app/account.ts`）。而服务端鉴权是**每次请求都查库**。
 *
 * 于是管理员刚改完某个角色的权限，那个**已经登录且没刷新页面**的账号就进入一种错位状态：
 * 菜单与页面还在，请求却开始 403。此时该做的是刷新快照，而不是只弹一句"无权限"——
 * 用户完全没有线索知道自己该刷新页面。
 *
 * 判据必须精确到"快照确实变了"，不能见 403 就刷新：
 * - 权限没变而拿到 403，说明是这个功能本身无权（或实例授权不足），刷新只会白闪一次页面；
 * - 权限变了才刷新，刷新后两边一致，也就不会再触发第二次——天然不会成环。
 */
export function isPermissionSnapshotStale(
  local: readonly string[],
  fresh: readonly string[],
): boolean {
  const localSet = new Set(local)
  const freshSet = new Set(fresh)
  if (localSet.size !== freshSet.size) {
    return true
  }
  for (const key of localSet) {
    if (!freshSet.has(key)) {
      return true
    }
  }
  return false
}
