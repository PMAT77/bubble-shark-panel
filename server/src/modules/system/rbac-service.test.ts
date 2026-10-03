import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { closeDatabase, findPermissionsByUserId, initDatabase } from '../../shared/db/index'
import { ensureDb } from '../../shared/db/connection'
import { instanceGrants, roles, userPermissions, userRoles, users } from '../../shared/db/schema/index'
import { ALL_PERMISSIONS } from '../../../../shared/constants/permissions'
import { eq } from 'drizzle-orm'
import { loadServerConfig } from '../../shared/config'
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
    // 「超级管理员」的判定读的是配置里的管理员账号名：这里固定成种子账号，
    // 免得开发者本机的 ADMIN_USERNAME 把用例带偏
    process.env.ADMIN_USERNAME = 'superadmin'
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

  it('超级管理员的密码不能由别人重置，只能本人在个人设置里改', async () => {
    const blocked = await resetMemberPassword(
      { userId: adminUserId, password: 'Fresh-Pass#2026' },
      adminUserId,
    )
    assert.equal(blocked.ok, false, '超级管理员账号不接受重置密码，本人从这里重置也不行')
    if (!blocked.ok) {
      assert.match(blocked.message, /个人设置/)
    }

    // 列表里要标出这个身份，界面据此不显示重置入口
    const members = await listMemberItems()
    assert.equal(members.find(item => item.id === adminUserId)?.isAdminAccount, true)
    assert.ok(members.filter(item => item.id !== adminUserId).every(item => !item.isAdminAccount))

    // 其它账号照旧可以重置
    const role = await createRole({ name: '可重置密码的角色', permissions: ['room:read'] })
    assert.equal(role.ok, true)
    if (!role.ok) {
      return
    }
    const member = await createMember({
      account: `resettable-${randomUUID().slice(0, 8)}`,
      password: 'Init-Password#2026',
      roleId: role.data.roleId,
    })
    assert.equal(member.ok, true)
    if (!member.ok) {
      return
    }
    const done = await resetMemberPassword(
      { userId: member.data.userId, password: 'Fresh-Pass#2026' },
      adminUserId,
    )
    assert.equal(done.ok, true, '普通成员仍然可以重置密码')
  })

  it('超级管理员账号不能被停用，但允许重新启用', async () => {
    const role = await createRole({ name: '可停用的角色', permissions: ['room:read'] })
    assert.equal(role.ok, true)
    if (!role.ok) {
      return
    }
    const member = await createMember({
      account: `disable-${randomUUID().slice(0, 8)}`,
      password: 'Init-Password#2026',
      roleId: role.data.roleId,
    })
    assert.equal(member.ok, true)
    if (!member.ok) {
      return
    }

    // 换个人来停用超管：用超管自己会被「不能停用当前登录的账号」先拦住，测不到这条规则
    const blocked = await updateMember({ userId: adminUserId, status: 0 }, member.data.userId)
    assert.equal(blocked.ok, false, '停用超级管理员要拦')
    if (!blocked.ok) {
      assert.match(blocked.message, /不能被停用/)
    }

    // 普通成员照旧可以停用
    const off = await updateMember({ userId: member.data.userId, status: 0 }, adminUserId)
    assert.equal(off.ok, true)

    // 历史数据里如果是停用状态，得留一条把它重新启起来的路径（这里直接改库模拟）
    await db().update(users).set({ status: 0 }).where(eq(users.id, adminUserId))
    const on = await updateMember({ userId: adminUserId, status: 1 }, adminUserId)
    assert.equal(on.ok, true, '启用超级管理员要允许，否则停用的历史数据没法恢复')
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

  for (const key of ['guest', 'system-admin']) {
    it(`内置角色 ${key} 不可修改名称、备注、权限点或删除`, async () => {
      const d = db()
      const role = (await d.select().from(roles).where(eq(roles.key, key)))[0]
      assert.ok(role, '内置角色应当在初始化时建立')
      const listed = (await listRoleItems()).find(item => item.id === role.id)!
      assert.equal(listed.isBuiltin, true, '前端据此禁用编辑和删除')
      const effectiveBefore = await findPermissionsByUserId(adminUserId)

      for (const change of [
        { name: '修改名称', description: role.description, permissions: listed.permissions },
        { name: role.name, description: '修改备注', permissions: listed.permissions },
        { name: role.name, description: role.description, permissions: ['room:read'] },
      ]) {
        const updated = await updateRole({ roleId: role.id, ...change })
        assert.equal(updated.ok, false)
        if (!updated.ok) {
          assert.match(updated.message, /内置角色/)
        }
      }

      const removed = await deleteRole(role.id)
      assert.equal(removed.ok, false)
      if (!removed.ok) {
        assert.match(removed.message, /内置角色/)
      }
      assert.deepEqual((await d.select().from(roles).where(eq(roles.id, role.id)))[0], role)
      assert.deepEqual((await listRoleItems()).find(item => item.id === role.id), listed)
      assert.deepEqual(await findPermissionsByUserId(adminUserId), effectiveBefore)
      if (key === 'system-admin') {
        assert.equal(role.kind, 'user', '内置只读约束只针对角色定义')
        assert.deepEqual([...effectiveBefore].sort(), [...ALL_PERMISSIONS].sort())
      }
    })
  }

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

  /**
   * 内置游客角色只能挂在配置的那个游客账号上。
   *
   * 为什么这是必须的一条：游客角色是"零写权限"的角色，而它的免密入口是公开的
   * （`POST /app/account/guest-login` 为这个角色签会话）。一旦配给真实运维账号，
   * 那个账号会**静默失去全部操作能力**（还用自己的密码登录，但所有按钮消失、
   * 写操作全返回「只读的游客角色」），而界面上没有任何地方说明原因。
   */
  it('内置游客角色不能分配给非游客账号（建号与换角色两条路都拦）', async () => {
    const d = db()
    const guest = (await d.select().from(roles).where(eq(roles.key, 'guest')))[0]
    assert.ok(guest, '游客角色应当由迁移建立')

    const account = `ops-${randomUUID().slice(0, 8)}`
    const created = await createMember({
      account,
      password: 'Init-Password#2026',
      roleId: guest.id,
    })
    assert.equal(created.ok, false, '建号时把运维账号挂到游客角色上必须被拒')
    if (!created.ok) {
      assert.match(created.message, /游客账号/)
    }

    // 换角色这条路：先建一个正常账号，再尝试把它改成游客角色
    const normalRole = await createRole({ name: `普通运维-${randomUUID().slice(0, 8)}`, permissions: ['room:read'] })
    assert.equal(normalRole.ok, true)
    if (!normalRole.ok) {
      return
    }
    const member = await createMember({
      account,
      password: 'Init-Password#2026',
      roleId: normalRole.data.roleId,
    })
    assert.equal(member.ok, true)
    if (!member.ok) {
      return
    }
    const switched = await updateMember({ userId: member.data.userId, roleId: guest.id }, adminUserId)
    assert.equal(switched.ok, false, '把已有运维账号改成游客角色必须被拒')
    if (!switched.ok) {
      assert.match(switched.message, /游客账号/)
    }
  })

  it('游客角色账号的口令不能在成员管理里重置', async () => {
    const d = db()
    const guest = (await d.select().from(roles).where(eq(roles.key, 'guest')))[0]!
    /**
     * 直接按配置里的游客账号名建号——这是"手工建一个只读预览账号"的既有用法
     * （`SECURITY.md` 写明的那条路），守卫允许它。
     */
    const guestAccountName = loadServerConfig().guestLoginAccount
    const existing = await d.select().from(users).where(eq(users.account, guestAccountName))
    if (existing.length === 0) {
      await createMember({
        account: guestAccountName,
        password: 'Init-Password#2026',
        roleId: guest.id,
        mustChangePassword: false,
      })
    }
    const rows = await d.select().from(users).where(eq(users.account, guestAccountName))
    const guestUserId = rows[0]!.id

    const reset = await resetMemberPassword(
      { userId: guestUserId, password: 'Another-Password#2026' },
      adminUserId,
    )
    assert.equal(reset.ok, false, '给游客账号设一个已知口令，等于让"谁都能用密码登录"绕过免密入口上的开关与限流')
    if (!reset.ok) {
      assert.match(reset.message, /游客账号/)
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

    const restored = await updateRole({
      roleId: role.data.roleId, name: '唯一管理员候选', permissions: ['role:write', 'member:write'],
    })
    assert.equal(restored.ok, true)
    const d = db()
    const writers = await d.select().from(userPermissions).where(eq(userPermissions.permission, 'role:write'))
    try {
      // 直接设置一次性数据库夹具，使自建角色的成员成为唯一可管理角色的账号。
      // 内置管理员角色本身不可编辑，不能再通过 updateRole 构造此边界。
      await d.delete(userPermissions).where(eq(userPermissions.permission, 'role:write'))
      await d.insert(userPermissions).values(writers.filter(row => row.userId === member.data.userId))
      const strip = await updateRole({ roleId: role.data.roleId, name: '唯一管理员候选', permissions: ['member:write'] })
      assert.equal(strip.ok, false, '不能把最后一个具备角色管理能力的账号收权')
      if (!strip.ok) {
        assert.match(strip.message, /不能取消/)
      }
    }
    finally {
      await d.delete(userPermissions).where(eq(userPermissions.permission, 'role:write'))
      await d.insert(userPermissions).values(writers)
    }
    assert.equal((await updateRole({ roleId: role.data.roleId, name: '唯一管理员候选', permissions: ['member:write'] })).ok, true)
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
