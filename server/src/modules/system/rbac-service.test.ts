import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { closeDatabase, findPermissionsByUserId, initDatabase } from '../../shared/db/index'
import { ensureDb } from '../../shared/db/connection'
import { instanceGrants, roles, userRoles, users } from '../../shared/db/schema/index'
import { eq } from 'drizzle-orm'
import {
  createMember,
  createRole,
  deleteMember,
  deleteRole,
  listMemberItems,
  listRoleItems,
  resetMemberPassword,
  setMemberInstanceGrants,
  updateMember,
  updateRole,
} from './rbac-service'

/**
 * 成员与角色的业务规则。
 *
 * 重点是**三条防锁死约束**：它们保护的是「面板还能被管理」这件事。
 * 少了它们，管理员点两下就能把面板变成谁都改不了设置的状态，只能进数据库救回来——
 * 而那种状态下他连"自己做了什么导致的"都看不出来。
 */

const dbFilePath = path.join(os.tmpdir(), `gsh-rbac-service-${randomUUID()}.sqlite`)
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle')

let adminUserId = ''

function db() {
  return ensureDb().drizzleDb
}

describe('成员与角色服务', () => {
  before(async () => {
    await initDatabase(dbFilePath, migrationsFolder)
    const d = db()
    const admin = (await d.select().from(users).where(eq(users.account, 'superadmin')))[0]
    adminUserId = admin!.id
  })

  after(() => {
    closeDatabase()
  })

  it('新建角色时拒绝清单里没有的权限点', async () => {
    const result = await createRole({
      name: '带无效权限点的角色',
      permissions: ['instance:read', 'bogus:permission'],
    })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.match(result.message, /未知的权限点/)
    }
  })

  it('建号与重置密码都要求强密码，不允许出现"用户自己改不回来"的初始密码', async () => {
    const role = await createRole({ name: '弱密码用例角色', permissions: ['room:read'] })
    assert.equal(role.ok, true)
    if (!role.ok) {
      return
    }

    const weak = await createMember({
      account: `weak-${randomUUID().slice(0, 8)}`,
      password: '123456',
      roleId: role.data.roleId,
    })
    assert.equal(weak.ok, false, '初始密码必须过与改密同一套强度校验')
    if (!weak.ok) {
      assert.match(weak.message, /不符合要求/)
    }

    const okMember = await createMember({
      account: `strong-${randomUUID().slice(0, 8)}`,
      password: 'Init-Password#2026',
      roleId: role.data.roleId,
    })
    assert.equal(okMember.ok, true)
    if (!okMember.ok) {
      return
    }
    const reset = await resetMemberPassword(
      { userId: okMember.data.userId, password: 'weak' },
      adminUserId,
    )
    assert.equal(reset.ok, false, '重置成弱密码同样要拦')
  })

  it('新角色可以被创建，并出现在列表里', async () => {
    const created = await createRole({
      name: '只读看板',
      description: '只能看，不能改',
      permissions: ['console.monitor:read', 'instance:read', 'room:read'],
    })
    assert.equal(created.ok, true)
    if (!created.ok) {
      return
    }
    const list = await listRoleItems()
    const role = list.find(item => item.id === created.data.roleId)
    assert.ok(role)
    assert.deepEqual([...role.permissions].sort(), ['console.monitor:read', 'instance:read', 'room:read'].sort())
    assert.equal(role.memberCount, 0)
    assert.equal(role.isBuiltin, false)
  })

  it('把角色分给新成员后，权限点立刻物化到生效表（鉴权读的就是它）', async () => {
    const role = await createRole({
      name: '房间管理员',
      permissions: ['room:read', 'room:write'],
    })
    assert.equal(role.ok, true)
    if (!role.ok) {
      return
    }

    const member = await createMember({
      account: `room-admin-${randomUUID().slice(0, 8)}`,
      password: 'Init-Password#2026',
      roleId: role.data.roleId,
      instanceIds: ['inst-a', 'inst-b'],
    })
    assert.equal(member.ok, true)
    if (!member.ok) {
      return
    }

    assert.deepEqual(
      (await findPermissionsByUserId(member.data.userId)).sort(),
      ['room:read', 'room:write'],
      '能力必须落进 user_permissions，否则这个账号登录后什么都看不到',
    )

    const members = await listMemberItems()
    const item = members.find(entry => entry.id === member.data.userId)
    assert.ok(item)
    assert.deepEqual(item.instanceIds.sort(), ['inst-a', 'inst-b'], '实例授权决定"能在哪些实例上做"')
    assert.equal(item.mustChangePassword, true, '建号默认要求首次登录改密')
  })

  it('改角色的权限点会同步到该角色的全部成员', async () => {
    const role = await createRole({ name: '会被收权的角色', permissions: ['room:read', 'room:write'] })
    assert.equal(role.ok, true)
    if (!role.ok) {
      return
    }
    const member = await createMember({
      account: `shrink-${randomUUID().slice(0, 8)}`,
      password: 'Init-Password#2026',
      roleId: role.data.roleId,
    })
    assert.equal(member.ok, true)
    if (!member.ok) {
      return
    }

    const updated = await updateRole({
      roleId: role.data.roleId,
      name: '会被收权的角色',
      permissions: ['room:read'],
    })
    assert.equal(updated.ok, true)
    assert.deepEqual(
      await findPermissionsByUserId(member.data.userId),
      ['room:read'],
      '收权要真的生效——先清后写，被取消的权限点必须消失',
    )
  })

  it('内置游客角色不可改权限点、不可删除', async () => {
    const d = db()
    const guest = (await d.select().from(roles).where(eq(roles.key, 'guest')))[0]
    assert.ok(guest, '游客角色应当由迁移建立')

    const updated = await updateRole({ roleId: guest.id, name: '游客', permissions: ['room:read'] })
    assert.equal(updated.ok, false)
    if (!updated.ok) {
      assert.match(updated.message, /内置角色/)
    }

    const removed = await deleteRole(guest.id)
    assert.equal(removed.ok, false)
    if (!removed.ok) {
      assert.match(removed.message, /内置角色/)
    }
  })

  it('有成员在用的角色不能删', async () => {
    const role = await createRole({ name: '还有人用的角色', permissions: ['room:read'] })
    assert.equal(role.ok, true)
    if (!role.ok) {
      return
    }
    await createMember({
      account: `inuse-${randomUUID().slice(0, 8)}`,
      password: 'Init-Password#2026',
      roleId: role.data.roleId,
    })
    const removed = await deleteRole(role.data.roleId)
    assert.equal(removed.ok, false)
    if (!removed.ok) {
      assert.match(removed.message, /个成员在用/)
    }
  })

  // ── 三条防锁死约束 ────────────────────────────────────────────────────

  it('不能停用当前登录的账号', async () => {
    const result = await updateMember({ userId: adminUserId, status: 0 }, adminUserId)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.match(result.message, /不能停用当前登录的账号/)
    }
  })

  it('不能删除当前登录的账号', async () => {
    const result = await deleteMember(adminUserId, adminUserId)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.match(result.message, /不能删除当前登录的账号/)
    }
  })

  it('不能把最后一个具备角色管理能力的账号降权', async () => {
    /**
     * 构造一个「只有它能管角色」的账号：新建一个带 role:write 的角色并只分给它，
     * 同时确认此刻确实只有它持有该权限点（管理员那份也在，所以这里应当被允许——
     * 于是再把它自己那份也收掉来逼近边界）。
     *
     * 真正要钉住的判定是：收权后没有人具备 role:write 时，操作必须被拒。
     */
    const role = await createRole({ name: '唯一管理员候选', permissions: ['role:write', 'member:write'] })
    assert.equal(role.ok, true)
    if (!role.ok) {
      return
    }
    const member = await createMember({
      account: `solo-admin-${randomUUID().slice(0, 8)}`,
      password: 'Init-Password#2026',
      roleId: role.data.roleId,
    })
    assert.equal(member.ok, true)
    if (!member.ok) {
      return
    }

    // 此刻 role:write 至少还有 superadmin 持有，所以改这个角色是允许的
    const allowed = await updateRole({
      roleId: role.data.roleId,
      name: '唯一管理员候选',
      permissions: ['member:write'],
    })
    assert.equal(allowed.ok, true, '还有人能管角色时，收权不该被拦')

    // 把管理员也降成没有 role:write 的角色后，最后一次收权必须被拒
    const adminRoleId = (await db().select().from(userRoles).where(eq(userRoles.userId, adminUserId)))[0]!.roleId
    const strip = await updateRole({ roleId: adminRoleId, name: '系统管理员', permissions: ['settings:read'] })
    assert.equal(strip.ok, false, '不能把最后一个具备角色管理能力的账号收权')
    if (!strip.ok) {
      assert.match(strip.message, /不能取消/)
    }
  })

  it('不能删除最后一个具备面板设置能力的账号', async () => {
    /**
     * 造一个「唯一的设置管理员」：只给它 settings:write，然后把管理员自己那份收掉。
     * 收不掉（上一条已覆盖），所以这里验证的是删除路径：先确认管理员仍在，
     * 删它就应当被拒（它是当前唯一同时具备 settings:write 与 role:write 的账号之一）。
     */
    const result = await deleteMember(adminUserId, 'someone-else')
    assert.equal(result.ok, false, '删除最后一个关键账号必须被拒绝')
    if (!result.ok) {
      assert.match(result.message, /唯一具备/)
    }
  })

  it('可以把自己的实例授权收窄，但不能清空', async () => {
    const narrowed = await setMemberInstanceGrants({ userId: adminUserId, instanceIds: ['inst-a'] }, adminUserId)
    assert.equal(narrowed.ok, true, '收窄范围是合法操作')

    const cleared = await setMemberInstanceGrants({ userId: adminUserId, instanceIds: [] }, adminUserId)
    assert.equal(cleared.ok, false, '清空自己的授权会让人以为面板坏了')
    if (!cleared.ok) {
      assert.match(cleared.message, /不能把自己的实例授权全部清空/)
    }
  })

  it('删除成员会连它的角色关联与实例授权一起清掉', async () => {
    const role = await createRole({ name: '待删除成员的角色', permissions: ['room:read'] })
    assert.equal(role.ok, true)
    if (!role.ok) {
      return
    }
    const member = await createMember({
      account: `todelete-${randomUUID().slice(0, 8)}`,
      password: 'Init-Password#2026',
      roleId: role.data.roleId,
      instanceIds: ['inst-x'],
    })
    assert.equal(member.ok, true)
    if (!member.ok) {
      return
    }

    const removed = await deleteMember(member.data.userId, adminUserId)
    assert.equal(removed.ok, true)

    const d = db()
    assert.equal((await d.select().from(users).where(eq(users.id, member.data.userId))).length, 0)
    assert.equal((await d.select().from(userRoles).where(eq(userRoles.userId, member.data.userId))).length, 0)
    assert.equal((await d.select().from(instanceGrants).where(eq(instanceGrants.userId, member.data.userId))).length, 0)
  })
})
