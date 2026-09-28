import { and, asc, eq } from 'drizzle-orm'
import { ensureDb, nowIso } from './connection'
import {
  gameInstances,
  instanceGrants,
  rolePermissions,
  roles,
  userPermissions,
  userRoles,
  users,
} from './schema/index'

/**
 * RBAC 的数据访问层：角色、角色权限点、用户角色、实例授权。
 *
 * 分两层理由（改这个文件前先读）：
 *
 * 1. **读路径必须便宜**。`findPermissionsByUserId` / `hasInstanceGrant` / `findRoleKindByUserId`
 *    在每次带实例的业务请求上都会被调用，因此它们只做单表（或一次 join）查询，不做权限计算。
 * 2. **写路径必须原子**。角色权限点变了、成员换角色了，都要在**同一个事务语义**里把结果
 *    物化回 `user_permissions`——它才是最终生效表（登录、菜单判定、前端权限数组都读它）。
 *    物化逻辑集中在 `server/src/modules/system/rbac-service.ts`，本文件只提供零件。
 */

export type RoleKind = 'user' | 'guest'

export interface DbRole {
  id: string
  key: string | null
  name: string
  description: string
  kind: RoleKind
  isBuiltin: boolean
  createdAt: string
  updatedAt: string
}

export interface DbRoleWithPermissions extends DbRole {
  permissions: string[]
  /** 有多少成员挂在这个角色上——删角色前的提示与「不能删有成员的角色」约束都要它 */
  memberCount: number
}

function mapRole(row: {
  id: string
  key: string | null
  name: string
  description: string
  kind: string
  isBuiltin: number
  createdAt: string
  updatedAt: string
}): DbRole {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    kind: row.kind === 'guest' ? 'guest' : 'user',
    isBuiltin: row.isBuiltin === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

// ── 读路径（每次请求都会走到，保持单查询） ────────────────────────────────

/**
 * 用户是否对某个实例有授权。
 *
 * 这是实例级隔离的**唯一判据**：没有这一行，用户连「这个实例存在」都不该知道，
 * 因此调用方拿到的错误文案要统一（不要区分「实例不存在」与「无权限」，那会变成一个枚举器）。
 */
export async function hasInstanceGrant(userId: string, instanceId: string): Promise<boolean> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb
    .select({ instanceId: instanceGrants.instanceId })
    .from(instanceGrants)
    .where(and(
      eq(instanceGrants.userId, userId),
      eq(instanceGrants.instanceId, instanceId),
    ))
    .limit(1)
  return Boolean(rows[0])
}

/** 用户被授权的全部实例 ID。列表与聚合接口按它过滤 */
export async function listGrantedInstanceIds(userId: string): Promise<string[]> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb
    .select({ instanceId: instanceGrants.instanceId })
    .from(instanceGrants)
    .where(eq(instanceGrants.userId, userId))
    .orderBy(asc(instanceGrants.instanceId))
  return rows.map(row => row.instanceId)
}

/** 用户的角色类型。`guest` 用于「零写权限」的第二道保险 */
export async function findRoleKindByUserId(userId: string): Promise<RoleKind | undefined> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb
    .select({ kind: roles.kind })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(userRoles.userId, userId))
    .limit(1)
  const kind = rows[0]?.kind
  if (!kind) {
    return undefined
  }
  return kind === 'guest' ? 'guest' : 'user'
}

export async function findRoleById(roleId: string): Promise<DbRole | undefined> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb.select().from(roles).where(eq(roles.id, roleId)).limit(1)
  return rows[0] ? mapRole(rows[0]) : undefined
}

export async function findRoleByKey(key: string): Promise<DbRole | undefined> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb.select().from(roles).where(eq(roles.key, key)).limit(1)
  return rows[0] ? mapRole(rows[0]) : undefined
}

export async function listRolePermissions(roleId: string): Promise<string[]> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb
    .select({ permission: rolePermissions.permission })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, roleId))
    .orderBy(asc(rolePermissions.permission))
  return rows.map(row => row.permission)
}

/**
 * 全部角色 + 它们的权限点 + 成员数。
 *
 * 分两次查询再在内存里归并，而不是 join：权限点与成员数是两个不同的「多」，
 * join 到一起会让行数相乘，然后还要去重。
 */
export async function listRolesWithPermissions(): Promise<DbRoleWithPermissions[]> {
  const { drizzleDb } = ensureDb()
  const roleRows = await drizzleDb.select().from(roles).orderBy(asc(roles.createdAt))
  const permissionRows = await drizzleDb.select().from(rolePermissions)
  const linkRows = await drizzleDb.select().from(userRoles)

  const permissionsByRole = new Map<string, string[]>()
  for (const row of permissionRows) {
    const list = permissionsByRole.get(row.roleId) ?? []
    list.push(row.permission)
    permissionsByRole.set(row.roleId, list)
  }
  const memberCountByRole = new Map<string, number>()
  for (const row of linkRows) {
    memberCountByRole.set(row.roleId, (memberCountByRole.get(row.roleId) ?? 0) + 1)
  }

  return roleRows.map(row => ({
    ...mapRole(row),
    permissions: (permissionsByRole.get(row.id) ?? []).sort(),
    memberCount: memberCountByRole.get(row.id) ?? 0,
  }))
}

export interface DbMember {
  id: string
  account: string
  email: string
  avatar: string
  status: number
  mustChangePassword: boolean
  createdAt: string
  updatedAt: string
  roleId: string | null
  roleName: string | null
  roleKind: RoleKind | null
  /** 该成员被授权的实例 ID */
  instanceIds: string[]
}

/** 成员列表（含角色与实例授权）。用于「成员管理」页 */
export async function listMembers(): Promise<DbMember[]> {
  const { drizzleDb } = ensureDb()
  const userRows = await drizzleDb.select().from(users).orderBy(asc(users.createdAt))
  const linkRows = await drizzleDb
    .select({ userId: userRoles.userId, roleId: userRoles.roleId, name: roles.name, kind: roles.kind })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
  const grantRows = await drizzleDb.select().from(instanceGrants)

  const linkByUser = new Map(linkRows.map(row => [row.userId, row]))
  const grantsByUser = new Map<string, string[]>()
  for (const row of grantRows) {
    const list = grantsByUser.get(row.userId) ?? []
    list.push(row.instanceId)
    grantsByUser.set(row.userId, list)
  }

  return userRows.map((row) => {
    const link = linkByUser.get(row.id)
    return {
      id: row.id,
      account: row.account,
      email: row.email,
      avatar: row.avatar,
      status: row.status,
      mustChangePassword: row.mustChangePassword === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      roleId: link?.roleId ?? null,
      roleName: link?.name ?? null,
      roleKind: link ? (link.kind === 'guest' ? 'guest' : 'user') : null,
      instanceIds: (grantsByUser.get(row.id) ?? []).sort(),
    }
  })
}

export async function findMemberById(userId: string): Promise<DbMember | undefined> {
  const members = await listMembers()
  return members.find(member => member.id === userId)
}

/**
 * 拥有某个权限点的启用账号数量。
 *
 * 用于「不能把最后一个管理员改没了」这条防锁死约束：判断依据必须是**生效权限点**
 * （`user_permissions`）而不是角色，因为鉴权读的就是它——角色配得再漂亮，
 * 物化没生效也等于没有。
 */
export async function countActiveUsersWithPermission(permission: string): Promise<number> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb
    .select({ userId: userPermissions.userId })
    .from(userPermissions)
    .innerJoin(users, eq(users.id, userPermissions.userId))
    .where(and(
      eq(users.status, 1),
      eq(userPermissions.permission, permission),
    ))
  return rows.length
}

// ── 写路径零件 ──────────────────────────────────────────────────────────

export async function insertRole(input: {
  id: string
  key?: string | null
  name: string
  description: string
  kind: RoleKind
  isBuiltin: boolean
  permissions: readonly string[]
}): Promise<void> {
  const { drizzleDb } = ensureDb()
  const now = nowIso()
  await drizzleDb.insert(roles).values({
    id: input.id,
    key: input.key ?? null,
    name: input.name,
    description: input.description,
    kind: input.kind,
    isBuiltin: input.isBuiltin ? 1 : 0,
    createdAt: now,
    updatedAt: now,
  })
  if (input.permissions.length > 0) {
    await drizzleDb.insert(rolePermissions).values(
      input.permissions.map(permission => ({ roleId: input.id, permission, createdAt: now })),
    )
  }
}

export async function updateRoleFields(input: {
  roleId: string
  name: string
  description: string
}): Promise<void> {
  const { drizzleDb } = ensureDb()
  await drizzleDb
    .update(roles)
    .set({ name: input.name, description: input.description, updatedAt: nowIso() })
    .where(eq(roles.id, input.roleId))
}

/** 整体替换角色的权限点（先清后写） */
export async function replaceRolePermissions(roleId: string, permissions: readonly string[]): Promise<void> {
  const { drizzleDb } = ensureDb()
  const now = nowIso()
  await drizzleDb.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId))
  if (permissions.length > 0) {
    await drizzleDb.insert(rolePermissions).values(
      permissions.map(permission => ({ roleId, permission, createdAt: now })),
    )
  }
}

export async function deleteRoleById(roleId: string): Promise<void> {
  const { drizzleDb } = ensureDb()
  await drizzleDb.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId))
  await drizzleDb.delete(roles).where(eq(roles.id, roleId))
}

/** 给成员换角色：先按 userId 清理旧关联（主键就是一个 userId → 一个角色） */
export async function setUserRole(userId: string, roleId: string): Promise<void> {
  const { drizzleDb } = ensureDb()
  await drizzleDb.delete(userRoles).where(eq(userRoles.userId, userId))
  await drizzleDb.insert(userRoles).values({ userId, roleId, createdAt: nowIso() })
}

/** 实例授权：整表替换某个成员的授权集合 */
export async function replaceUserInstanceGrants(
  userId: string,
  instanceIds: readonly string[],
  grantedBy: string | null,
): Promise<void> {
  const { drizzleDb } = ensureDb()
  const now = nowIso()
  await drizzleDb.delete(instanceGrants).where(eq(instanceGrants.userId, userId))
  if (instanceIds.length > 0) {
    await drizzleDb.insert(instanceGrants).values(
      instanceIds.map(instanceId => ({ userId, instanceId, grantedBy, createdAt: now })),
    )
  }
}

/** 给成员追加实例授权（新建实例后自动授权给创建者用） */
export async function addUserInstanceGrants(
  userId: string,
  instanceIds: readonly string[],
  grantedBy: string | null,
): Promise<void> {
  if (instanceIds.length === 0) {
    return
  }
  const { drizzleDb } = ensureDb()
  const now = nowIso()
  const existing = new Set(await listGrantedInstanceIds(userId))
  const toInsert = instanceIds.filter(id => !existing.has(id))
  if (toInsert.length === 0) {
    return
  }
  await drizzleDb.insert(instanceGrants).values(
    toInsert.map(instanceId => ({ userId, instanceId, grantedBy, createdAt: now })),
  )
}

/** 实例被删除时清掉它的授权行，避免 grants 表里留下永远指不到东西的记录 */
export async function deleteInstanceGrantsByInstanceId(instanceId: string): Promise<void> {
  const { drizzleDb } = ensureDb()
  await drizzleDb.delete(instanceGrants).where(eq(instanceGrants.instanceId, instanceId))
}

/** 所有实例 ID（迁移与「全选授权」用） */
export async function listAllInstanceIds(): Promise<string[]> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb.select({ id: gameInstances.id }).from(gameInstances)
  return rows.map(row => row.id)
}
