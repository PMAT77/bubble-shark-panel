import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import {
  ALL_PERMISSIONS,
  LEGACY_FRAMEWORK_PERMISSIONS,
  NODE_INSTANCE_MANAGE_PERMISSION,
  OPS_MANAGE_PERMISSION,
  OPS_READ_PERMISSION,
  SYSTEM_MANAGE_PERMISSION,
} from '../../../../shared/constants/permissions'
import { closeDatabase, ensureDb, initDatabase, nowIso } from './connection'
import { mapLegacyPermissions } from './rbac-migration'
import {
  gameInstances,
  instanceGrants,
  rolePermissions,
  roles,
  systemSettings,
  userPermissions,
  userRoles,
  users,
} from './schema/index'
import type { RbacMigrationOutcome } from './rbac-migration'

/**
 * RBAC 迁移的回归。
 *
 * 这一段必须过真实数据库：迁移的产物是四张表与 `user_permissions` 的**物化结果**，
 * 而纯函数测试覆盖不到「角色上有 53 个权限点、账号上却只有 49 个」这类不一致
 * ——它不会报错，只会让升级后的管理员看不到新菜单。探针脚本先抓出过这个缺陷，
 * 这里把它钉住。
 */

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle')

function freshDbPath(tag: string): string {
  return path.join(os.tmpdir(), `gsh-rbac-${tag}-${randomUUID()}.sqlite`)
}

describe('RBAC 迁移：全新库', () => {
  const dbFilePath = freshDbPath('fresh')
  let outcome: RbacMigrationOutcome | undefined

  before(async () => {
    await initDatabase(dbFilePath, migrationsFolder, {
      seedDevelopmentUsers: true,
      onRbacMigrationOutcome: (value) => {
        outcome = value
      },
      /**
       * 「只持有母仓遗留权限点的账号」这个样本。
       *
       * 它原本挂在默认种子里（账号 test），但那意味着每台机器的开发模式都多一个
       * 固定弱口令账号。样本由需要它的测试声明更合适，也让"这个账号为什么存在"
       * 在测试里一眼可见。
       */
      extraSeedUsers: [{
        account: 'test',
        password: '123456',
        email: 'test@game.com',
        avatar: 'https://api.dicebear.com/9.x/bottts-neutral/svg?seed=test',
        permissions: ['pages.general:browse'],
      }],
    })
  })

  after(() => {
    closeDatabase()
  })

  it('迁移确实跑了，且回调只带着结果回来一次', () => {
    assert.equal(outcome?.ran, true)
    assert.equal(outcome?.guestRoleCreated, true)
  })

  it('内置游客角色存在、权限点为零、不可被当作普通角色', async () => {
    const { drizzleDb } = ensureDb()
    const rows = await drizzleDb.select().from(roles).where(eq(roles.key, 'guest'))
    const guest = rows[0]
    assert.ok(guest, '游客角色必须被建出来')
    assert.equal(guest.kind, 'guest')
    assert.equal(guest.isBuiltin, 1)
    const permissions = await drizzleDb
      .select()
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, guest.id))
    assert.equal(permissions.length, 0, '游客角色的权限点必须为空——它是只读预览的安全阀')
  })

  it('管理员拿到系统管理员角色，且生效权限点与角色权限点一致', async () => {
    const { drizzleDb } = ensureDb()
    const adminRoleRows = await drizzleDb.select().from(roles).where(eq(roles.key, 'system-admin'))
    const adminRole = adminRoleRows[0]
    assert.ok(adminRole, '迁移应建立系统管理员角色')

    const rolePermissionRows = await drizzleDb
      .select()
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, adminRole.id))
    assert.equal(rolePermissionRows.length, ALL_PERMISSIONS.length, '系统管理员角色应覆盖全部权限点')

    const superadminRows = await drizzleDb.select().from(users).where(eq(users.account, 'superadmin'))
    const superadmin = superadminRows[0]
    assert.ok(superadmin)

    const effectiveRows = await drizzleDb
      .select()
      .from(userPermissions)
      .where(eq(userPermissions.userId, superadmin.id))
    assert.deepEqual(
      effectiveRows.map(row => row.permission).sort(),
      [...ALL_PERMISSIONS].sort(),
      '生效权限点必须与角色一致：只物化映射结果会漏掉 member:* 与 role:*，管理员会看不到新菜单',
    )

    const roleLinks = await drizzleDb.select().from(userRoles).where(eq(userRoles.userId, superadmin.id))
    assert.equal(roleLinks[0]?.roleId, adminRole.id, '管理员应挂在系统管理员角色上')
  })

  it('只持有母仓遗留权限点的账号：不建角色，并把残留清干净', async () => {
    const { drizzleDb } = ensureDb()
    const testUserRows = await drizzleDb.select().from(users).where(eq(users.account, 'test'))
    const testUser = testUserRows[0]
    assert.ok(testUser)
    const links = await drizzleDb.select().from(userRoles).where(eq(userRoles.userId, testUser.id))
    assert.equal(links.length, 0, '没有业务权限的账号不该被硬塞一个角色')
    const effective = await drizzleDb.select().from(userPermissions).where(eq(userPermissions.userId, testUser.id))
    assert.equal(effective.length, 0, '遗留的 pages.* 不该留在生效权限点里')
    assert.deepEqual(outcome?.usersWithoutPermission, ['test'])
  })
})

describe('RBAC 迁移：存量实例与幂等', () => {
  const dbFilePath = freshDbPath('existing')

  before(async () => {
    await initDatabase(dbFilePath, migrationsFolder, { seedDevelopmentUsers: true })
    // 造一个「升级前就存在」的实例，然后把该账号退回未迁移状态，让迁移重跑时处理它
    const { drizzleDb } = ensureDb()
    const now = nowIso()
    await drizzleDb.insert(gameInstances).values({
      id: 'rbac-probe-instance',
      nodeId: 'local-node',
      name: '迁移前就有的实例',
      gameCode: 'dst',
      status: 'stopped',
      updateAvailable: 0,
      createdAt: now,
      updatedAt: now,
    })
    const adminRows = await drizzleDb.select().from(users).where(eq(users.account, 'superadmin'))
    const admin = adminRows[0]!
    await drizzleDb.delete(userRoles).where(eq(userRoles.userId, admin.id))
    await drizzleDb.delete(systemSettings).where(eq(systemSettings.key, 'migration.rbac_initialized'))

    await initDatabase(dbFilePath, migrationsFolder, { seedDevelopmentUsers: true })
  })

  after(() => {
    closeDatabase()
  })

  it('升级前就存在的实例被补进账号的实例授权', async () => {
    const { drizzleDb } = ensureDb()
    const adminRows = await drizzleDb.select().from(users).where(eq(users.account, 'superadmin'))
    const admin = adminRows[0]!
    const grants = await drizzleDb
      .select()
      .from(instanceGrants)
      .where(eq(instanceGrants.userId, admin.id))
    assert.deepEqual(
      grants.map(grant => grant.instanceId),
      ['rbac-probe-instance'],
      '存量实例必须被授权，否则升级后老账号登录看不到自己的实例',
    )
  })

  it('标记写入后迁移不再重复执行', async () => {
    let ranAgain = false
    await initDatabase(dbFilePath, migrationsFolder, {
      seedDevelopmentUsers: true,
      onRbacMigrationOutcome: () => {
        ranAgain = true
      },
    })
    assert.equal(ranAgain, false, '迁移只应跑一次；重复执行会重复建角色')
  })

  it('重复启动不会重复补授权', async () => {
    const { drizzleDb } = ensureDb()
    const before = await drizzleDb.select().from(instanceGrants)
    await initDatabase(dbFilePath, migrationsFolder, { seedDevelopmentUsers: true })
    const afterRun = await drizzleDb.select().from(instanceGrants)
    assert.equal(afterRun.length, before.length, '实例授权不该重复插入')
  })
})

describe('mapLegacyPermissions', () => {
  it('旧实例管理权限展开成细粒度权限点，且不再包含旧字符串本身', () => {
    const mapped = mapLegacyPermissions([NODE_INSTANCE_MANAGE_PERMISSION])
    assert.ok(mapped.includes('instance:lifecycle'))
    assert.ok(mapped.includes('room:write'))
    assert.ok(mapped.includes('mod:install'))
    assert.ok(mapped.includes('file:upload'))
    assert.equal(mapped.includes(NODE_INSTANCE_MANAGE_PERMISSION), false, '旧权限点不应被保留')
  })

  it('运维与系统权限各自映射，互不越界', () => {
    const opsOnly = mapLegacyPermissions([OPS_READ_PERMISSION])
    assert.deepEqual(opsOnly.sort(), ['backup:read', 'schedule:read'])
    assert.equal(opsOnly.includes('instance:lifecycle'), false, '运维只读不该拿到实例启停')

    const systemManage = mapLegacyPermissions([SYSTEM_MANAGE_PERMISSION])
    assert.ok(systemManage.includes('settings:write'))
    assert.ok(systemManage.includes('plugin:manage'))
    assert.equal(systemManage.includes('instance:lifecycle'), false, '系统管理不该拿到实例启停')

    const opsManage = mapLegacyPermissions([OPS_MANAGE_PERMISSION])
    assert.ok(opsManage.includes('backup:restore'))
    assert.ok(opsManage.includes('schedule:write'))
  })

  it('已经是新体系的权限点原样透传', () => {
    const mapped = mapLegacyPermissions(['member:write', 'role:read'])
    assert.deepEqual(mapped.sort(), ['member:write', 'role:read'])
  })

  it('母仓遗留权限点被丢弃', () => {
    assert.deepEqual(mapLegacyPermissions([...LEGACY_FRAMEWORK_PERMISSIONS]), [])
  })

  it('混合输入时去重且不丢能力', () => {
    const mapped = mapLegacyPermissions([
      OPS_READ_PERMISSION,
      'backup:read',
      ...LEGACY_FRAMEWORK_PERMISSIONS,
    ])
    assert.deepEqual(mapped.sort(), ['backup:read', 'schedule:read'], '重复项应被去重，遗留项应被丢弃')
  })
})
