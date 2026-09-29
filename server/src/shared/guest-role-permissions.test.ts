import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  GUEST_EXCLUDED_PERMISSIONS,
  GUEST_ROLE_PERMISSIONS,
  READ_ONLY_PERMISSIONS,
  findPermissionSpec,
  isStateChangingPermission,
} from '../../../shared/constants/permissions'

/**
 * 内置游客角色的权限集。
 *
 * 它是「只读预览」的唯一真源：全部 read 权限点减去 `GUEST_EXCLUDED_PERMISSIONS`。
 * 这一组断言钉住四件事，任何一件破了都会让游客从"能看不能改"变成别的东西：
 *   1. 里面**没有任何会改状态的权限点**——不只是写权限点，还包括标了 `sideEffect` 的接口
 *      （`world-state` 会向游戏下发指令）所依赖的控制台读权限；
 *   2. 成员、角色、审计、插件、控制台五项被排除（授权入口 + 管理员账号名 + 绝对路径 + 命令通道）；
 *   3. 其余 read 权限点一个不少（少一个是"游客看不到某个页面"，而少了不会有任何报错）；
 *   4. 排除清单本身就是"为什么游客看不到它"的那个名单，不能悄悄多几项。
 */
describe('游客角色的权限集', () => {
  it('不含任何会改状态的权限点（写权限点或 sideEffect 读接口）', () => {
    const stateChanging = GUEST_ROLE_PERMISSIONS.filter(permission => isStateChangingPermission(permission))
    assert.deepEqual(
      stateChanging,
      [],
      `游客角色不该有会改状态的权限点：${stateChanging.join('、')}`,
    )
  })

  it('排除成员、角色、审计、插件与控制台', () => {
    for (const excluded of ['member:read', 'role:read', 'audit:read', 'plugin:read', 'instance.console:read'] as const) {
      assert.ok(
        !GUEST_ROLE_PERMISSIONS.includes(excluded),
        `${excluded} 不该给游客`,
      )
    }
  })

  it('排除清单被代码固化，不会随新增模块悄悄变多', () => {
    assert.deepEqual(
      [...GUEST_EXCLUDED_PERMISSIONS].sort(),
      ['audit:read', 'instance.console:read', 'member:read', 'plugin:read', 'role:read'],
      '新增一条排除必须同时改这里：否则"游客看不到某个页面"会变成没人复核的静默行为',
    )
  })

  it('是全部 read 权限点减去排除清单', () => {
    const expected = READ_ONLY_PERMISSIONS.filter(
      permission => !(GUEST_EXCLUDED_PERMISSIONS as readonly string[]).includes(permission),
    )
    assert.deepEqual([...GUEST_ROLE_PERMISSIONS].sort(), [...expected].sort())
    assert.equal(GUEST_ROLE_PERMISSIONS.length, READ_ONLY_PERMISSIONS.length - GUEST_EXCLUDED_PERMISSIONS.length)
  })

  it('排除清单里的每一项都是真实的读权限点', () => {
    for (const excluded of GUEST_EXCLUDED_PERMISSIONS) {
      assert.equal(
        findPermissionSpec(excluded)?.action,
        'read',
        `${excluded} 不在权限点清单里（或不是读权限点）：排除一个不存在的权限点等于没排除`,
      )
    }
  })
})
