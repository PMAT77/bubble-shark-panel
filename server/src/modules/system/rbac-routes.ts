import type { FastifyInstance } from 'fastify'
import type { ApiErrorResponse, ApiSuccessResponse } from '../../../../shared/contracts/api'
import {
  memberCreatePayloadSchema,
  memberDeletePayloadSchema,
  memberInstanceGrantPayloadSchema,
  memberPasswordResetPayloadSchema,
  memberUpdatePayloadSchema,
  roleCreatePayloadSchema,
  roleDeletePayloadSchema,
  roleUpdatePayloadSchema,
} from '../../../../shared/contracts/rbac'
import type {
  MemberListItem,
  MemberMutationResult,
  RoleListItem,
  RoleMutationResult,
  RoleOptionItem,
} from '../../../../shared/contracts/rbac'
import { businessError, success, unauthorized } from '../../shared/http/response'
import { requireAnyReadPermission, resolveAuthorizedContext } from './auth'
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
 * 成员与角色接口。
 *
 * 权限点分两档：查看用 `member:read` / `role:read`，改动用 `member:write` / `role:write`。
 * **不给这两类操作加实例级授权**——它们是全局管理动作，与"能操作哪些实例"无关；
 * 成员能碰哪些实例由 `members/instances` 那条单独维护。
 */
export function registerRbacRoutes(app: FastifyInstance) {
  // ── 角色 ──────────────────────────────────────────────────────────────
  app.get('/app/system/roles', async (request): Promise<ApiSuccessResponse<RoleListItem[]> | ApiErrorResponse> => {
    const auth = await resolveAuthorizedContext(request, { permissions: 'role:read' })
    if (auth.error || !auth.context) {
      return auth.error ?? unauthorized(request)
    }
    return success(await listRoleItems(), request)
  })

  /**
   * 角色选项：只够"选一个角色"用（id / 名称 / 是否内置）。
   *
   * 为什么单开一条：「成员管理」要分配角色，但它不该因此要求 `role:read`——那等于
   * "能管成员"就自动能看角色清单与权限矩阵。这里 `role:read` 或 `member:read` 任一即可，
   * 且只返回选中一个角色所需的最小字段（成员页用它把内置角色标成「只读」）。
   */
  app.get('/app/system/role-options', async (request): Promise<ApiSuccessResponse<RoleOptionItem[]> | ApiErrorResponse> => {
    const authError = await requireAnyReadPermission(request, ['role:read', 'member:read'])
    if (authError) {
      return authError
    }
    const roles = await listRoleItems()
    return success(roles.map(role => ({ id: role.id, name: role.name, isBuiltin: role.isBuiltin })), request)
  })

  app.post('/app/system/roles/create', async (request): Promise<ApiSuccessResponse<RoleMutationResult> | ApiErrorResponse> => {
    const auth = await resolveAuthorizedContext(request, { permissions: 'role:write' })
    if (auth.error || !auth.context) {
      return auth.error ?? unauthorized(request)
    }
    const body = roleCreatePayloadSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效：角色名不能为空，且权限点必须是已知的', request)
    }
    const result = await createRole(body.data)
    if (!result.ok) {
      return businessError(result.message, request)
    }
    return success({ isSuccess: true, roleId: result.data.roleId }, request)
  })

  app.post('/app/system/roles/update', async (request): Promise<ApiSuccessResponse<RoleMutationResult> | ApiErrorResponse> => {
    const auth = await resolveAuthorizedContext(request, { permissions: 'role:write' })
    if (auth.error || !auth.context) {
      return auth.error ?? unauthorized(request)
    }
    const body = roleUpdatePayloadSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const result = await updateRole(body.data)
    if (!result.ok) {
      return businessError(result.message, request)
    }
    return success({ isSuccess: true, roleId: result.data.roleId }, request)
  })

  app.post('/app/system/roles/delete', async (request): Promise<ApiSuccessResponse<RoleMutationResult> | ApiErrorResponse> => {
    const auth = await resolveAuthorizedContext(request, { permissions: 'role:write' })
    if (auth.error || !auth.context) {
      return auth.error ?? unauthorized(request)
    }
    const body = roleDeletePayloadSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const result = await deleteRole(body.data.roleId)
    if (!result.ok) {
      return businessError(result.message, request)
    }
    return success({ isSuccess: true, roleId: body.data.roleId }, request)
  })

  // ── 成员 ──────────────────────────────────────────────────────────────
  app.get('/app/system/members', async (request): Promise<ApiSuccessResponse<MemberListItem[]> | ApiErrorResponse> => {
    const auth = await resolveAuthorizedContext(request, { permissions: 'member:read' })
    if (auth.error || !auth.context) {
      return auth.error ?? unauthorized(request)
    }
    return success(await listMemberItems(), request)
  })

  app.post('/app/system/members/create', async (request): Promise<ApiSuccessResponse<MemberMutationResult> | ApiErrorResponse> => {
    const auth = await resolveAuthorizedContext(request, { permissions: 'member:write' })
    if (auth.error || !auth.context) {
      return auth.error ?? unauthorized(request)
    }
    const body = memberCreatePayloadSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效：账号、初始密码与角色都是必填', request)
    }
    const result = await createMember(body.data)
    if (!result.ok) {
      return businessError(result.message, request)
    }
    return success({ isSuccess: true, userId: result.data.userId }, request)
  })

  app.post('/app/system/members/update', async (request): Promise<ApiSuccessResponse<MemberMutationResult> | ApiErrorResponse> => {
    const auth = await resolveAuthorizedContext(request, { permissions: 'member:write' })
    if (auth.error || !auth.context) {
      return auth.error ?? unauthorized(request)
    }
    const body = memberUpdatePayloadSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const result = await updateMember(body.data, auth.context.user.id)
    if (!result.ok) {
      return businessError(result.message, request)
    }
    return success({ isSuccess: true, userId: result.data.userId }, request)
  })

  app.post('/app/system/members/password', async (request): Promise<ApiSuccessResponse<MemberMutationResult> | ApiErrorResponse> => {
    const auth = await resolveAuthorizedContext(request, { permissions: 'member:write' })
    if (auth.error || !auth.context) {
      return auth.error ?? unauthorized(request)
    }
    const body = memberPasswordResetPayloadSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效：新密码不能为空', request)
    }
    const result = await resetMemberPassword(body.data, auth.context.user.id)
    if (!result.ok) {
      return businessError(result.message, request)
    }
    return success({ isSuccess: true, userId: result.data.userId }, request)
  })

  app.post('/app/system/members/instances', async (request): Promise<ApiSuccessResponse<MemberMutationResult> | ApiErrorResponse> => {
    const auth = await resolveAuthorizedContext(request, { permissions: 'member:write' })
    if (auth.error || !auth.context) {
      return auth.error ?? unauthorized(request)
    }
    const body = memberInstanceGrantPayloadSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const result = await setMemberInstanceGrants(body.data, auth.context.user.id)
    if (!result.ok) {
      return businessError(result.message, request)
    }
    return success({ isSuccess: true, userId: result.data.userId }, request)
  })

  app.post('/app/system/members/delete', async (request): Promise<ApiSuccessResponse<MemberMutationResult> | ApiErrorResponse> => {
    const auth = await resolveAuthorizedContext(request, { permissions: 'member:write' })
    if (auth.error || !auth.context) {
      return auth.error ?? unauthorized(request)
    }
    const body = memberDeletePayloadSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const result = await deleteMember(body.data.userId, auth.context.user.id)
    if (!result.ok) {
      return businessError(result.message, request)
    }
    return success({ isSuccess: true, userId: body.data.userId }, request)
  })
}
