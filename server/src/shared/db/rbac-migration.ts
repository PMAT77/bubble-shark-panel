import { and, eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import {
  GUEST_ROLE_PERMISSIONS,
  LEGACY_FRAMEWORK_PERMISSIONS,
  NODE_INSTANCE_MANAGE_PERMISSION,
  OPS_MANAGE_PERMISSION,
  OPS_READ_PERMISSION,
  SYSTEM_MANAGE_PERMISSION,
  SYSTEM_READ_PERMISSION,
} from '../../../../shared/constants/permissions'
import { ensureDb, nowIso } from './connection'
import { listGameInstances } from './instance-repository'
import {
  instanceGrants,
  rolePermissions,
  roles,
  systemSettings,
  userPermissions,
  userRoles,
  users,
} from './schema/index'

/**
 * 从旧权限体系迁移到细粒度 RBAC。
 *
 * 只跑一次（`system_settings` 里的标记），必须在用户播种之后调用——否则新装环境的管理员还没建出来，
 * 迁移会空转，之后又没有第二次机会。
 *
 * 迁移做四件事：
 * 1. 建内置**游客**角色（`key: 'guest'`，权限点由 `GUEST_ROLE_PERMISSIONS` 固化）；
 * 2. 把每个既有用户的旧权限点**映射**成新权限点，并为它建立一个角色挂上去；
 * 3. 把映射结果物化回 `user_permissions`（它仍是最终生效表）；
 * 4. 给每个用户补上「当前全部实例」的授权，保证升级后老账号看不到的实例不会凭空消失。
 *
 * 角色规则（保守优先，宁可降权也不给意外权限）：
 * - 旧权限点里含 `system:manage` → 复用「系统管理员」角色（全部权限点）；
 * - 映射结果为空（例如只持有母仓遗留的 `pages.*`）→ 不建角色，该账号迁移后无权限；
 * - 其余情况 → 以账号命名建一个角色，权限点就是映射结果，**不丢失原有任何能力**。
 */

const RBAC_MIGRATION_KEY = 'migration.rbac_initialized'

/** 内置游客角色的稳定 key */
export const GUEST_ROLE_KEY = 'guest'
/** 迁移建立的系统管理员角色名与 key（非内置：用户可改、可删，但有防锁死约束兜底） */
const SYSTEM_ADMIN_ROLE_KEY = 'system-admin'
const SYSTEM_ADMIN_ROLE_NAME = '系统管理员'

/**
 * 旧 `pages.node.instance:manage` 展开成的新权限点。
 *
 * 覆盖它原先实际把关的全部路由：instance / cluster / shard / player / mod / console / files / map / node。
 * **不含** backup 与 schedule —— 那两块原先由 `ops:read` / `ops:manage` 把关，各归各的映射。
 */
const NODE_INSTANCE_MANAGE_EXPANSION = [
  'console.monitor:read',
  'instance:read',
  'instance:create',
  'instance:delete',
  'instance:lifecycle',
  'instance:update',
  'instance:ports',
  'instance.install-log:read',
  'instance.migration:read',
  'instance.migration:export',
  'instance.console:read',
  'console:clear',
  'console:command',
  'maintenance:write',
  'room:read',
  'room:write',
  'world:read',
  'world:write',
  'world:rollback',
  'world:reset',
  'world.map:read',
  'world.map:generate',
  'player:read',
  'player:write',
  'player:kick',
  'player:ban',
  'player.profile:write',
  'mod:read',
  'mod:install',
  'mod:toggle',
  'mod:config',
  'file:read',
  'file:write',
  'file:delete',
  'file:upload',
  'file:download',
]

/** 旧权限点 → 新权限点。一个旧权限点可以展开成多个 */
const LEGACY_PERMISSION_MAP: Record<string, string[]> = {
  [NODE_INSTANCE_MANAGE_PERMISSION]: NODE_INSTANCE_MANAGE_EXPANSION,
  [OPS_READ_PERMISSION]: ['backup:read', 'schedule:read'],
  [OPS_MANAGE_PERMISSION]: [
    'backup:read',
    'backup:create',
    'backup:delete',
    'backup:restore',
    'backup:import',
    'schedule:read',
    'schedule:write',
  ],
  [SYSTEM_READ_PERMISSION]: ['settings:read', 'audit:read', 'plugin:read', 'license:read'],
  [SYSTEM_MANAGE_PERMISSION]: [
    'settings:read',
    'settings:write',
    'audit:read',
    'plugin:read',
    'plugin:manage',
    'license:read',
  ],
}

export interface RbacMigrationOutcome {
  /** 是否真的执行了（false = 之前已迁移过） */
  ran: boolean
  guestRoleCreated: boolean
  rolesCreated: number
  usersAssigned: number
  grantsCreated: number
  /** 迁移后仍无任何权限点的账号，便于排查「为什么这个账号看不到菜单」 */
  usersWithoutPermission: string[]
}

/**
 * 把一组旧权限点映射成新权限点。
 *
 * 规则：认识的旧权限点按表展开；已经是新体系权限点的原样保留（新装环境的种子用户直接就是新的）；
 * 都不认识的（母仓遗留的 `pages.*`）丢弃——本项目没有对应页面，留着只会让角色管理页出现看不懂的条目。
 */
export function mapLegacyPermissions(permissions: readonly string[]): string[] {
  const mapped = new Set<string>()
  for (const permission of permissions) {
    const expansion = LEGACY_PERMISSION_MAP[permission]
    if (expansion) {
      for (const item of expansion) {
        mapped.add(item)
      }
      continue
    }
    if (permission in LEGACY_PERMISSION_MAP || LEGACY_FRAMEWORK_PERMISSIONS.includes(permission)) {
      continue
    }
    mapped.add(permission)
  }
  return [...mapped]
}

async function readMigrationFlag(): Promise<boolean> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.key, RBAC_MIGRATION_KEY))
    .limit(1)
  return rows[0]?.value === '1'
}

async function writeMigrationFlag(): Promise<void> {
  const { drizzleDb } = ensureDb()
  const now = nowIso()
  await drizzleDb
    .insert(systemSettings)
    .values({ key: RBAC_MIGRATION_KEY, value: '1', updatedAt: now })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: '1', updatedAt: now },
    })
}

/**
 * 固化游客角色的权限点，并物化到挂该角色的成员。
 *
 * 语义：**除「成员管理」「角色管理」外的所有页面都能看，但一个操作都做不了**
 * （权限点全部是 read，且服务端对 guest 还有一道「写接口一律拒绝」的保险）。
 *
 * 为什么每次启动都要执行：`migrateRbacFromLegacy` 只在首次迁移时跑一次（有迁移标记），
 * 而游客的权限集是**代码定义的**——改了 `GUEST_ROLE_PERMISSIONS` 之后，已经迁移过的库
 * 不会重跑迁移。只靠"建角色时写一次"会让存量部署永远停在旧集合上。
 *
 * 两步都不能省：
 * - 写 `role_permissions` 是权限点的真源（角色管理页、菜单过滤都读它）；
 * - 写 `user_permissions` 是让鉴权生效——服务端读的是这张物化表。
 */
export async function syncGuestRolePermissions(): Promise<{
  created: boolean
  permissions: readonly string[]
  membersSynced: number
}> {
  const { drizzleDb } = ensureDb()
  const now = nowIso()
  const existing = await drizzleDb
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.key, GUEST_ROLE_KEY))
    .limit(1)

  let roleId = existing[0]?.id
  let created = false
  if (!roleId) {
    roleId = randomUUID()
    await drizzleDb.insert(roles).values({
      id: roleId,
      key: GUEST_ROLE_KEY,
      name: '游客',
      description: '只读预览用的固化角色：固定持有「除成员管理、角色管理外」的全部只读权限点，不能被修改权限点或删除',
      kind: 'guest',
      isBuiltin: 1,
      createdAt: now,
      updatedAt: now,
    })
    created = true
  }

  // 先清后写：幂等，且保证删掉的权限点（例如将来从集合里移除某项）真的收回
  await drizzleDb.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId))
  await drizzleDb.insert(rolePermissions).values(
    GUEST_ROLE_PERMISSIONS.map(permission => ({ roleId, permission, createdAt: now })),
  )

  const members = await drizzleDb
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .where(eq(userRoles.roleId, roleId))
  for (const member of members) {
    await drizzleDb.delete(userPermissions).where(eq(userPermissions.userId, member.userId))
    await drizzleDb.insert(userPermissions).values(
      GUEST_ROLE_PERMISSIONS.map(permission => ({ userId: member.userId, permission, createdAt: now })),
    )
  }

  return { created, permissions: GUEST_ROLE_PERMISSIONS, membersSynced: members.length }
}

async function findRoleIdByKey(key: string): Promise<string | undefined> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.key, key))
    .limit(1)
  return rows[0]?.id
}

/** 建角色并写入权限点，返回 roleId */
async function createRoleWithPermissions(input: {
  key?: string
  name: string
  description: string
  permissions: readonly string[]
}): Promise<string> {
  const { drizzleDb } = ensureDb()
  const roleId = randomUUID()
  const now = nowIso()
  await drizzleDb.insert(roles).values({
    id: roleId,
    key: input.key ?? null,
    name: input.name,
    description: input.description,
    kind: 'user',
    isBuiltin: 0,
    createdAt: now,
    updatedAt: now,
  })
  if (input.permissions.length > 0) {
    await drizzleDb.insert(rolePermissions).values(
      input.permissions.map(permission => ({ roleId, permission, createdAt: now })),
    )
  }
  return roleId
}

/**
 * 执行迁移。幂等：已迁移过直接返回 `{ ran: false }`。
 *
 * 失败时不写标记，下次启动重跑；重跑对已分配角色的用户会跳过（按 `user_roles` 判重），
 * 所以中途失败不会产生重复角色。
 */
export async function migrateRbacFromLegacy(options: {
  /** 全部细粒度权限点，由调用方从 `ALL_PERMISSIONS` 传入，避免这里再 import 一遍共享常量 */
  allPermissions: readonly string[]
}): Promise<RbacMigrationOutcome> {
  const outcome: RbacMigrationOutcome = {
    ran: false,
    guestRoleCreated: false,
    rolesCreated: 0,
    usersAssigned: 0,
    grantsCreated: 0,
    usersWithoutPermission: [],
  }

  if (await readMigrationFlag()) {
    return outcome
  }

  outcome.ran = true
  outcome.guestRoleCreated = (await syncGuestRolePermissions()).created

  const { drizzleDb } = ensureDb()

  // 1) 逐个用户映射权限点并建角色
  const allUsers = await drizzleDb
    .select({ id: users.id, account: users.account })
    .from(users)
  const instanceRows = await listGameInstances()
  const now = nowIso()

  let adminRoleId = await findRoleIdByKey(SYSTEM_ADMIN_ROLE_KEY)

  for (const user of allUsers) {
    const assigned = await drizzleDb
      .select({ roleId: userRoles.roleId })
      .from(userRoles)
      .where(eq(userRoles.userId, user.id))
      .limit(1)
    const existingPermissions = await drizzleDb
      .select({ permission: userPermissions.permission })
      .from(userPermissions)
      .where(eq(userPermissions.userId, user.id))

    // 补实例授权：所有既有用户都能看到「升级时刻已存在」的全部实例。
    // 注意这不授予任何能力——实例授权只是范围，能力仍由权限点决定。
    for (const instance of instanceRows) {
      const alreadyGranted = await drizzleDb
        .select({ instanceId: instanceGrants.instanceId })
        .from(instanceGrants)
        .where(and(
          eq(instanceGrants.userId, user.id),
          eq(instanceGrants.instanceId, instance.id),
        ))
        .limit(1)
      if (alreadyGranted[0]) {
        continue
      }
      await drizzleDb.insert(instanceGrants).values({
        userId: user.id,
        instanceId: instance.id,
        grantedBy: null,
        createdAt: now,
      })
      outcome.grantsCreated += 1
    }

    if (assigned[0]) {
      // 已经有角色的用户不再动它——避免覆盖用户自己的配置（也让中途失败后的重跑安全）
      continue
    }

    const legacyPermissions = existingPermissions.map(row => row.permission)
    const mapped = mapLegacyPermissions(legacyPermissions)
    if (mapped.length === 0) {
      // 只持有母仓遗留权限点（`pages.*`）的账号：本项目没有对应页面，把这些残留清掉，
      // 否则角色管理页会把它们当成"这个用户有 1 个权限点"显示出来，误导排查。
      // 清空后该账号确实无权限——这是事实，只记进 outcome 供启动日志提示。
      if (legacyPermissions.length > 0) {
        await drizzleDb.delete(userPermissions).where(eq(userPermissions.userId, user.id))
      }
      outcome.usersWithoutPermission.push(user.account)
      continue
    }

    // 管理员判定要同时认「旧体系特征」与「已经是新体系的用户」：
    // 旧库里看 `system:manage`，而新装环境的种子用户直接持有新权限点，
    // 只看旧常量会把管理员认成普通用户，给它建一个以账号命名的角色。
    const isAdmin = legacyPermissions.includes(SYSTEM_MANAGE_PERMISSION)
      || mapped.includes('settings:write')
      || mapped.includes('role:write')
    let roleId: string
    /**
     * 管理员物化的是**全部权限点**，不是映射结果。
     *
     * 差异来自「新体系新增、旧体系没有对应」的那几个权限点（`member:*` / `role:*`）：
     * 只物化映射结果的话，角色上有 53 个权限点、账号上却只有 49 个，
     * 而鉴权读的是 `user_permissions`——升级后管理员会看不到「成员管理」「角色管理」菜单。
     */
    let effectivePermissions: readonly string[]
    if (isAdmin) {
      if (!adminRoleId) {
        adminRoleId = await createRoleWithPermissions({
          key: SYSTEM_ADMIN_ROLE_KEY,
          name: SYSTEM_ADMIN_ROLE_NAME,
          description: '拥有全部权限点。由升级迁移建立，可按需调整权限点或改用更细的角色',
          permissions: options.allPermissions,
        })
        outcome.rolesCreated += 1
      }
      roleId = adminRoleId
      effectivePermissions = options.allPermissions
    }
    else {
      roleId = await createRoleWithPermissions({
        name: `${user.account} 的权限`,
        description: '由升级迁移按该账号原有权限点生成，可改名或调整',
        permissions: mapped,
      })
      outcome.rolesCreated += 1
      effectivePermissions = mapped
    }

    await drizzleDb.insert(userRoles).values({ userId: user.id, roleId, createdAt: now })
    // 物化回最终生效表：先清后写，保证旧权限点被替换干净
    await drizzleDb.delete(userPermissions).where(eq(userPermissions.userId, user.id))
    await drizzleDb.insert(userPermissions).values(
      effectivePermissions.map(permission => ({ userId: user.id, permission, createdAt: now })),
    )
    outcome.usersAssigned += 1
  }

  await writeMigrationFlag()
  return outcome
}
