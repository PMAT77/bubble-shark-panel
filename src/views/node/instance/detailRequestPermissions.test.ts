import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PermissionKey } from '../../../../shared/constants/permissions.ts'
import { findPermissionSpec, isKnownPermission } from '../../../../shared/constants/permissions.ts'
import {
  INSTANCE_DETAIL_REQUEST_PERMISSIONS,
  planInstanceDetailRequests,
} from './detailRequestPermissions.ts'

/**
 * 实例详情页「这次该发哪些请求」。
 *
 * 这一页只要求 `instance:read`，但首屏会牵动房间、世界、玩家、Mod、控制台五个权限点。
 * 此前无条件并发，只有实例读权限的账号一进来就是 5–6 个 403，失败被吞成 `null`，
 * 卡片显示"—"——看起来像"这里没有数据"。这些用例把"没权限就不发请求"钉住。
 */

/** 用权限集合构造与 `useAppAuth().auth` 等价的判定 */
function has(permissions: readonly string[]) {
  const set = new Set<string>(permissions)
  return (permission: PermissionKey) => set.has(permission)
}

describe('实例详情页的按权限请求计划', () => {
  it('映射表里的权限点都在清单里，且必须是读权限点', () => {
    for (const [section, permission] of Object.entries(INSTANCE_DETAIL_REQUEST_PERMISSIONS)) {
      assert.ok(isKnownPermission(permission), `${section} 映射到了未登记的权限点：${permission}`)
      assert.equal(
        findPermissionSpec(permission)?.action,
        'read',
        `${section} 用了写权限点把关读请求：${permission}。详情页的区块可见性必须由读权限决定`,
      )
    }
  })

  it('只有实例读权限时一个请求都不发', () => {
    const plan = planInstanceDetailRequests(has(['instance:read']))
    assert.deepEqual(
      Object.entries(plan).filter(([, allowed]) => allowed),
      [],
      '只有 instance:read 的账号不该发出任何跨模块请求（每一项都会 403）',
    )
  })

  it('按各自权限点分别放行', () => {
    const roomOnly = planInstanceDetailRequests(has(['instance:read', 'room:read']))
    assert.equal(roomOnly.cluster, true)
    assert.equal(roomOnly.shardList, false)
    assert.equal(roomOnly.onlinePlayers, false)
    assert.equal(roomOnly.modList, false)
    assert.equal(roomOnly.connectInfo, false)

    const playersOnly = planInstanceDetailRequests(has(['instance:read', 'player:read']))
    assert.equal(playersOnly.onlinePlayers, true)
    assert.equal(playersOnly.cluster, false)

    // 世界状态查询会向游戏下发指令，服务端按控制台读权限把关：两者必须同进同出
    const consoleOnly = planInstanceDetailRequests(has(['instance:read', 'instance.console:read']))
    assert.equal(consoleOnly.connectInfo, true)
    assert.equal(consoleOnly.worldState, true)
  })

  it('权限齐全时全部放行', () => {
    const plan = planInstanceDetailRequests(has([
      'instance:read',
      'room:read',
      'world:read',
      'player:read',
      'mod:read',
      'instance.console:read',
    ]))
    for (const [section, allowed] of Object.entries(plan)) {
      assert.equal(allowed, true, `${section} 在权限齐全时必须放行`)
    }
  })

  /**
   * 游客身份：世界状态查询必须**不发**。
   *
   * 这一项的权限点是读，但它会向运行中的游戏下发一条 `print` 指令，
   * 因此服务端把这类接口和写操作一视同仁地拒绝（`resolveAuthorizedContext` 里的
   * `isStateChangingPermission`）。前端若照旧发出去，页面会多一条必然 403 的静默失败，
   * 而用户看到的是"世界进程：—"。
   */
  it('游客身份下不发世界状态查询，其余照权限判定', () => {
    const allPermissions = [
      'instance:read',
      'room:read',
      'world:read',
      'player:read',
      'mod:read',
      'instance.console:read',
    ] as const

    const guestPlan = planInstanceDetailRequests(has(allPermissions), true)
    assert.equal(guestPlan.worldState, false, '世界状态查询会向游戏下发指令，游客不能发')
    assert.equal(guestPlan.cluster, true, '只该挡住会改状态的那一项，其余照常')
    assert.equal(guestPlan.onlinePlayers, true)
    assert.equal(guestPlan.connectInfo, true, '直连信息是纯读，游客仍应拿到')

    // 默认参数（普通账号）不受影响
    const normalPlan = planInstanceDetailRequests(has(allPermissions))
    assert.equal(normalPlan.worldState, true)
  })
})
