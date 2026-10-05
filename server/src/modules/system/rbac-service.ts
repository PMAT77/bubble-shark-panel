import { randomUUID } from 'node:crypto'
import type {
  MemberCreatePayload,
  MemberInstanceGrantPayload,
  MemberListItem,
  MemberPasswordResetPayload,
  MemberUpdatePayload,
  RoleCreatePayload,
  RoleListItem,
  RoleUpdatePayload,
} from '../../../../shared/contracts/rbac'
import { isStrongPassword, PASSWORD_POLICY_MESSAGE } from '../../../../shared/constants/password'
import { isKnownPermission } from '../../../../shared/constants/permissions'
import { loadServerConfig } from '../../shared/config'
import {
  createUserRecord,
  deleteRoleById,
  deleteUserCascade,
  findMemberById,
  findPermissionsByUserId,
  findRoleById,
  findRoleKindByUserId,
  findUserIdByAccount,
  hashPassword,
  insertRole,
  listMembers,
  listRolePermissions,
  listRolesWithPermissions,
  listUserIdsByRoleId,
  replaceRolePermissions,
  replaceUserInstanceGrants,
  replaceUserPermissions,
  setUserRole,
  updateRoleFields,
  updateUserMustChangePassword,
  updateUserPassword,
  updateUserStatusById,
  countActiveUsersWithPermission,
} from '../../shared/db/index'
import { isConfiguredGuestAccountName } from '../../shared/db/guest-account'

/**
 * 角色与成员的业务逻辑。
 *
 * 三条**防锁死约束**在这里，不在路由层——它们保护的是"面板还能被管理"这件事，
 * 属于业务规则：
 *
 * 1. 不能停用自己、不能把自己的角色换成没有角色管理权限的角色、不能删自己；
 * 2. 不能让「最后一个能管理角色或面板设置的启用账号」消失（停用或降权都算）；
 * 3. 内置系统管理员与游客角色不可修改、不可删除。
 *
 * 少了第 2 条，管理员点两下就能把面板变成没人能改设置的状态，只能改数据库救回来。
 */

export type ServiceResult<T = Record<string, never>> = { ok: true, data: T } | { ok: false, message: string }

/** 判定"还能管理面板"的关键权限点。任一存在即可，所以两个都查 */
const CRITICAL_PERMISSIONS = ['role:write', 'settings:write'] as const
const CRITICAL_PERMISSION_LABELS: Record<typeof CRITICAL_PERMISSIONS[number], string> = {
  'role:write': '角色',
  'settings:write': '面板设置',
}

function validatePermissions(permissions: readonly string[]): string | null {
  const unknown = permissions.filter(permission => !isKnownPermission(permission))
  if (unknown.length > 0) {
    return `存在未知的权限点：${unknown.join('、')}`
  }
  return null
}

/**
 * 是不是配置里的超级管理员账号（默认 `superadmin`）。
 *
 * 这个账号有几条额外底线：密码不能由别人重置、不能被停用。
 * 判定读的是配置而不是数据库里的标记——种子账号与升级迁移用的也是同一份配置，
 * 只认一个来源就不会出现"谁才是管理员"两处不一致。
 */
function isAdminAccountName(account: string): boolean {
  return account === loadServerConfig().adminUsername
}

/**
 * 内置游客角色只能挂在**配置的那个面板游客账号**上。
 *
 * 为什么必须拦：游客角色是"零写权限"的角色，而它的免密入口是公开的
 * （`POST /app/account/guest-login` 会为这个角色签出会话）。一旦把它配给某个真实运维账号，
 * 那个账号的后果有两层：
 *
 * 1. **能力被静默清空**——他还用原密码登录，但所有按钮都消失、所有写操作返回
 *    「当前账号是只读的游客角色」，而界面上没有任何地方说明"因为你的角色被改了"；
 * 2. **被公开入口顶掉**——游客账号是共享的，任何访客都能用它的身份进来；
 *    如果一个运维账号被误配成游客角色，它就等于多了一个谁都能用的入口。
 *
 * 允许的目标是配置里的 `BSP_GUEST_LOGIN_ACCOUNT`（默认 `guest`），
 * 且**与开关是否开启无关**：`SECURITY.md` 里"手工建一个只读账号挂游客角色"是既有用法，
 * 它挂的也是这个名字。
 */
function assertGuestRoleAssignable(account: string, roleKind: string | null | undefined): string | null {
  if (roleKind !== 'guest') {
    return null
  }
  if (isConfiguredGuestAccountName(account)) {
    return null
  }
  return '内置游客角色只能分配给面板的游客账号（默认 guest，可用 BSP_GUEST_LOGIN_ACCOUNT 指定）。'
    + '给运维账号分配只读能力请另建一个只读角色，否则这个账号会失去全部操作能力'
}

export async function listRoleItems(): Promise<RoleListItem[]> {
  const roles = await listRolesWithPermissions()
  return roles.map(role => ({
    id: role.id,
    key: role.key,
    name: role.name,
    description: role.description,
    kind: role.kind,
    isBuiltin: role.isBuiltin,
    permissions: role.permissions,
    memberCount: role.memberCount,
  }))
}

export async function listMemberItems(): Promise<MemberListItem[]> {
  const members = await listMembers()
  return members.map(member => ({
    id: member.id,
    account: member.account,
    email: member.email,
    avatar: member.avatar,
    status: member.status,
    mustChangePassword: member.mustChangePassword,
    roleId: member.roleId,
    roleName: member.roleName,
    roleKind: member.roleKind,
    instanceIds: member.instanceIds,
    createdAt: member.createdAt,
    isAdminAccount: isAdminAccountName(member.account),
  }))
}

// ── 角色 ────────────────────────────────────────────────────────────────

export async function createRole(payload: RoleCreatePayload): Promise<ServiceResult<{ roleId: string }>> {
  const permissionError = validatePermissions(payload.permissions)
  if (permissionError) {
    return { ok: false, message: permissionError }
  }
  const roles = await listRolesWithPermissions()
  if (roles.some(role => role.name === payload.name)) {
    return { ok: false, message: '已存在同名角色，请换一个名字' }
  }
  const roleId = randomUUID()
  await insertRole({
    id: roleId,
    name: payload.name,
    description: payload.description ?? '',
    kind: 'user',
    isBuiltin: false,
    permissions: payload.permissions,
  })
  return { ok: true, data: { roleId } }
}

export async function updateRole(payload: RoleUpdatePayload): Promise<ServiceResult<{ roleId: string }>> {
  const role = await findRoleById(payload.roleId)
  if (!role) {
    return { ok: false, message: '角色不存在' }
  }
  if (role.isBuiltin) {
    return { ok: false, message: `「${role.name}」是内置角色，不能修改` }
  }
  const permissionError = validatePermissions(payload.permissions)
  if (permissionError) {
    return { ok: false, message: permissionError }
  }

  /**
   * 收权前先确认不会把最后一个管理员收掉。
   *
   * 这是「改角色」与「改成员」两条路径上都要设的闸：管理员通常通过改角色来批量收权，
   * 只在成员那一侧防是防不住的。
   */
  const lostCritical = CRITICAL_PERMISSIONS.filter(
    permission => !payload.permissions.includes(permission),
  )
  if (lostCritical.length > 0) {
    for (const permission of lostCritical) {
      const holders = await countActiveUsersWithPermission(permission)
      const roleMemberIds = await listUserIdsByRoleId(role.id)
      // 该角色里持有这个权限点的启用账号数 == 全部持有者 → 改完就没人能管了
      const membersHolding = await Promise.all(
        roleMemberIds.map(async (userId) => {
          const permissions = await findPermissionsByUserId(userId)
          return permissions.includes(permission)
        }),
      )
      const holdersInThisRole = membersHolding.filter(Boolean).length
      if (holders > 0 && holdersInThisRole >= holders) {
        return {
          ok: false,
          message: `不能取消「${CRITICAL_PERMISSION_LABELS[permission]}」权限：当前只有这个角色里的账号具备该能力，去掉后没有人能再管理它`,
        }
      }
    }
  }

  await updateRoleFields({ roleId: role.id, name: payload.name, description: payload.description ?? '' })
  await replaceRolePermissions(role.id, payload.permissions)
  await rematerializeRoleMembers(role.id)
  return { ok: true, data: { roleId: role.id } }
}

export async function deleteRole(roleId: string): Promise<ServiceResult> {
  const role = await findRoleById(roleId)
  if (!role) {
    return { ok: false, message: '角色不存在' }
  }
  if (role.isBuiltin) {
    return { ok: false, message: `「${role.name}」是内置角色，不能删除` }
  }
  const memberIds = await listUserIdsByRoleId(roleId)
  if (memberIds.length > 0) {
    return {
      ok: false,
      message: `还有 ${memberIds.length} 个成员在用这个角色，请先给他们换一个角色再删除`,
    }
  }
  for (const permission of CRITICAL_PERMISSIONS) {
    const holders = await countActiveUsersWithPermission(permission)
    const permissions = await listRolePermissions(roleId)
    if (holders > 0 && permissions.includes(permission)) {
      const others = await countActiveUsersWithPermissionExcludingRole(roleId, permission)
      if (others === 0) {
        return {
          ok: false,
          message: `不能删除：删除后没有人再具备「${CRITICAL_PERMISSION_LABELS[permission]}」能力`,
        }
      }
    }
  }
  await deleteRoleById(roleId)
  return { ok: true, data: {} }
}

/** 除某个角色之外，还有多少启用账号持有该权限点（删角色前的检查） */
async function countActiveUsersWithPermissionExcludingRole(roleId: string, permission: string): Promise<number> {
  const members = await listMembers()
  const roleMemberIds = new Set(await listUserIdsByRoleId(roleId))
  let count = 0
  for (const member of members) {
    if (member.status !== 1 || roleMemberIds.has(member.id)) {
      continue
    }
    const permissions = await findPermissionsByUserId(member.id)
    if (permissions.includes(permission)) {
      count += 1
    }
  }
  return count
}

/** 把角色的权限点物化给它的全部成员 */
async function rematerializeRoleMembers(roleId: string): Promise<void> {
  const permissions = await listRolePermissions(roleId)
  const memberIds = await listUserIdsByRoleId(roleId)
  for (const userId of memberIds) {
    await replaceUserPermissions(userId, permissions)
  }
}

// ── 成员 ────────────────────────────────────────────────────────────────

export async function createMember(
  payload: MemberCreatePayload,
): Promise<ServiceResult<{ userId: string }>> {
  if (await findUserIdByAccount(payload.account)) {
    return { ok: false, message: '这个账号已存在，请换一个' }
  }
  /**
   * 初始密码也要过强度校验。
   *
   * 否则会出现这种组合：管理员给子账号设一个弱密码、并关掉"首次登录须改密"，
   * 于是这个弱密码长期有效——而用户自己想改成弱密码反而被拦住。
   * 两条路径必须是同一把尺子。
   */
  if (!isStrongPassword(payload.password)) {
    return { ok: false, message: `初始密码不符合要求：${PASSWORD_POLICY_MESSAGE}` }
  }
  const role = await findRoleById(payload.roleId)
  if (!role) {
    return { ok: false, message: '选择的角色不存在' }
  }
  const guestRoleError = assertGuestRoleAssignable(payload.account, role.kind)
  if (guestRoleError) {
    return { ok: false, message: guestRoleError }
  }

  const userId = randomUUID()
  await createUserRecord({
    id: userId,
    account: payload.account,
    passwordHash: hashPassword(payload.password),
    email: `${payload.account}@local`,
    avatar: `https://api.dicebear.com/9.x/bottts-neutral/svg?seed=${encodeURIComponent(payload.account)}`,
    status: 1,
    mustChangePassword: payload.mustChangePassword !== false,
  })
  await setUserRole(userId, role.id)
  // 能力来自角色，范围来自实例授权：两者都落好，这个账号才能真的用起来
  await replaceUserPermissions(userId, await listRolePermissions(role.id))
  await replaceUserInstanceGrants(userId, payload.instanceIds ?? [], null)
  return { ok: true, data: { userId } }
}

export async function updateMember(
  payload: MemberUpdatePayload,
  operatorUserId: string,
): Promise<ServiceResult<{ userId: string }>> {
  const member = await findMemberById(payload.userId)
  if (!member) {
    return { ok: false, message: '成员不存在' }
  }

  if (payload.status === 0) {
    if (payload.userId === operatorUserId) {
      return { ok: false, message: '不能停用当前登录的账号' }
    }
    /**
     * 超级管理员账号不能被停用。
     *
     * 它和「密码只能本人改」是同一条底线：停用它同样等于把面板的管理入口交到
     * 别人手里。这里只拦「停用」不拦「启用」——历史数据里如果是停用状态，
     * 得留一条把它重新启起来的路径。
     */
    if (isAdminAccountName(member.account)) {
      return { ok: false, message: '超级管理员账号不能被停用' }
    }
    const blocked = await assertNotLastCriticalHolder(member.id, '停用')
    if (blocked) {
      return { ok: false, message: blocked }
    }
  }

  if (payload.roleId && payload.roleId !== member.roleId) {
    const nextRole = await findRoleById(payload.roleId)
    if (!nextRole) {
      return { ok: false, message: '选择的角色不存在' }
    }
    const guestRoleError = assertGuestRoleAssignable(member.account, nextRole.kind)
    if (guestRoleError) {
      return { ok: false, message: guestRoleError }
    }
    if (payload.userId === operatorUserId) {
      // 自降权：允许换角色，但不允许把自己换成没有角色管理能力的角色——
      // 那等于把自己锁在门外，而当时通常没意识到
      const nextPermissions = await listRolePermissions(nextRole.id)
      if (!nextPermissions.includes('role:write')) {
        return { ok: false, message: '不能把自己的角色换成没有「管理角色」权限的角色，那样就没人能再改权限了' }
      }
    }
    const blocked = await assertNotLastCriticalHolder(member.id, '换角色')
    if (blocked) {
      return { ok: false, message: blocked }
    }
    await setUserRole(member.id, nextRole.id)
    await replaceUserPermissions(member.id, await listRolePermissions(nextRole.id))
  }

  if (typeof payload.status === 'number') {
    await updateUserStatusById(member.id, payload.status)
  }
  return { ok: true, data: { userId: member.id } }
}

export async function resetMemberPassword(
  payload: MemberPasswordResetPayload,
  operatorUserId: string,
): Promise<ServiceResult<{ userId: string }>> {
  const member = await findMemberById(payload.userId)
  if (!member) {
    return { ok: false, message: '成员不存在' }
  }

  /**
   * 超级管理员的密码不允许在成员管理里被重置——**包括管理员给自己重置**。
   *
   * 这个入口开着的时候，"谁是超级管理员"实际取决于谁先点了这个按钮：账号一旦被盗，
   * 攻击者第一件事就是给自己留一个能重置所有人密码的后门。所以它的密码只能由本人
   * 在「个人设置 → 修改密码」里改（要验旧密码）。忘了密码也不是死路：服务器上可以跑
   * `server/scripts/reset-admin-password.ts`，或用 `ADMIN_PASSWORD` 配合
   * `BSP_SYNC_ADMIN_PASSWORD_FROM_ENV` 同步——这两条都要求能登录服务器本身。
   */
  if (isAdminAccountName(member.account)) {
    return { ok: false, message: '超级管理员账号的密码只能由本人在「个人设置 → 修改密码」里改' }
  }

  /**
   * 游客账号的口令不允许在这里重置。
   *
   * 游客账号的口令是"没人知道"的随机值——它存在的唯一意义是让 `/app/account/login`
   * 对它登不上。一旦有人给它设一个已知口令，游客身份就变成"谁都能用普通账号密码登录的账号"，
   * 免密入口上的开关与限流全部作废（绕过按钮直接调 login 即可）。
   */
  if (await findRoleKindByUserId(member.id) === 'guest') {
    return { ok: false, message: '游客账号的口令由面板自动管理（随机值），不能手动重置；它只能通过登录页的「游客登录」进入' }
  }

  if (payload.userId === operatorUserId && payload.mustChangePassword === false) {
    return { ok: false, message: '给自己重置密码时不能关闭「下次登录须改密」' }
  }
  if (!isStrongPassword(payload.password)) {
    return { ok: false, message: `新密码不符合要求：${PASSWORD_POLICY_MESSAGE}` }
  }
  await updateUserPassword(member.id, payload.password, { keepSessions: false })
  // 重置密码同时要求对方下次登录改密：管理员给的初始密码不该成为长期凭据。
  // 显式传 false 才关掉（例如给只读预览账号固定一个密码）。
  await updateUserMustChangePassword(member.id, payload.mustChangePassword !== false)
  return { ok: true, data: { userId: member.id } }
}

export async function setMemberInstanceGrants(
  payload: MemberInstanceGrantPayload,
  operatorUserId: string,
): Promise<ServiceResult<{ userId: string }>> {
  const member = await findMemberById(payload.userId)
  if (!member) {
    return { ok: false, message: '成员不存在' }
  }
  // 授权范围是数据、不是能力：这里不阻止管理员给自己收范围（收窄只是让自己少看几个实例），
  // 但要拒绝"把自己全部实例都收掉"——那会让人以为面板坏了
  if (payload.userId === operatorUserId && payload.instanceIds.length === 0) {
    return { ok: false, message: '不能把自己的实例授权全部清空，否则你会看不到任何实例' }
  }
  const duplicates = new Set(payload.instanceIds)
  await replaceUserInstanceGrants(member.id, [...duplicates], operatorUserId)
  return { ok: true, data: { userId: member.id } }
}

export async function deleteMember(
  userId: string,
  operatorUserId: string,
): Promise<ServiceResult> {
  const member = await findMemberById(userId)
  if (!member) {
    return { ok: false, message: '成员不存在' }
  }
  if (userId === operatorUserId) {
    return { ok: false, message: '不能删除当前登录的账号' }
  }
  const blocked = await assertNotLastCriticalHolder(userId, '删除')
  if (blocked) {
    return { ok: false, message: blocked }
  }
  await deleteUserCascade(userId)
  return { ok: true, data: {} }
}

/**
 * 目标账号是不是「最后一个能管理面板的启用账号」。
 *
 * 返回非空字符串表示应当拒绝，内容直接给用户看（说明为什么不行）。
 * 判定依据是**生效权限点**（`user_permissions`）而不是角色——鉴权读的就是它。
 */
async function assertNotLastCriticalHolder(
  targetUserId: string,
  action: string,
): Promise<string | null> {
  const permissions = await findPermissionsByUserId(targetUserId)
  for (const permission of CRITICAL_PERMISSIONS) {
    if (!permissions.includes(permission)) {
      continue
    }
    const holders = await countActiveUsersWithPermission(permission)
    if (holders <= 1) {
      return `不能${action}：这个账号是当前唯一具备「${CRITICAL_PERMISSION_LABELS[permission]}」能力的启用账号，操作后没有人能再管理面板`
    }
  }
  return null
}

/** 给「成员管理」页用：判断目标账号是不是游客角色（前端据此禁用部分操作） */
export async function isGuestUser(userId: string): Promise<boolean> {
  return await findRoleKindByUserId(userId) === 'guest'
}
