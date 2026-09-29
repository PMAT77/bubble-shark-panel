import type { PermissionKey } from '../../../../shared/constants/permissions'

/**
 * 「实例详情」页首屏每个数据请求 → 它需要的读权限。
 *
 * 为什么单独抽成模块：详情页只要求 `instance:read`，但它会并发拉房间配置、世界分片、
 * 在线玩家、Mod 列表、连接信息与世界状态——这几项各有自己的权限点。此前无条件并发，
 * 只有实例读权限的账号一进详情页就刷出 5–6 个 403，`Promise.allSettled` 把失败吞成
 * `null`，卡片只好显示"—"——**看起来像"这里没有数据"，而不是"你没有权限"**。
 *
 * 判据（与菜单同一条）：**写在外面的请求，必须是这个账号有权发的**。区块权限不足时
 * 干脆不发，由卡片显示"需要 XX 权限"。
 */
export const INSTANCE_DETAIL_REQUEST_PERMISSIONS = {
  /** 房间配置（房间名、游戏模式、洞穴开关、联网模式） */
  cluster: 'room:read',
  /** 世界分片列表（地上 / 洞穴） */
  shardList: 'world:read',
  /** 在线玩家读数 */
  onlinePlayers: 'player:read',
  /** Mod 概览（已生效 / 总数） */
  modList: 'mod:read',
  /** 直连信息、连接地址 */
  connectInfo: 'instance.console:read',
  /**
   * 世界运行天数 / 季节：**实际会向游戏下发一条 print 指令**，服务端按控制台读权限把关；
   * 而且游客角色即使"看得见"这个权限点也拿不到它（服务端按"会改状态的读接口"一律拒绝），
   * 详见 `planInstanceDetailRequests` 的 `isGuestRole` 参数。
   */
  worldState: 'instance.console:read',
} as const satisfies Record<string, PermissionKey>

export type InstanceDetailRequestKey = keyof typeof INSTANCE_DETAIL_REQUEST_PERMISSIONS

/** 每一项表示"这次要不要发这个请求" */
export type InstanceDetailRequestPlan = Record<InstanceDetailRequestKey, boolean>

/**
 * 游客（只读预览）角色也**不能**发的请求。
 *
 * `worldState` 的权限点是读，但它会向运行中的游戏下发一条 `print` 指令（属于"会改状态的读接口"），
 * 而服务端已经把这类接口和写操作一视同仁地拒绝（`resolveAuthorizedContext` 用
 * `isStateChangingPermission` 判定）。因此游客点进详情页时，这一项必须标成"不发"——
 * 否则页面上会出现一条必然 403 的静默失败，而用户看到的是"世界进程"—"。
 *
 * 这里没有用"权限点的 `sideEffect` 标记"自动推导：那份清单在 `shared/` 里，
 * 前端运行时读的是构建期产物，而这份计划表要能被单测直接喂参数。
 */
const GUEST_BLOCKED_REQUESTS: readonly InstanceDetailRequestKey[] = ['worldState']

/**
 * 按权限决定详情页这次该发起哪些请求。
 *
 * @param has `useAppAuth().auth`（或测试里的等价判定）
 * @param isGuestRole 当前账号是不是内置游客角色；默认 `false`（普通账号不受影响）
 */
export function planInstanceDetailRequests(
  has: (permission: PermissionKey) => boolean,
  isGuestRole = false,
): InstanceDetailRequestPlan {
  const plan = {} as InstanceDetailRequestPlan
  for (const key of Object.keys(INSTANCE_DETAIL_REQUEST_PERMISSIONS) as InstanceDetailRequestKey[]) {
    plan[key] = has(INSTANCE_DETAIL_REQUEST_PERMISSIONS[key])
  }
  if (isGuestRole) {
    for (const key of GUEST_BLOCKED_REQUESTS) {
      plan[key] = false
    }
  }
  return plan
}
