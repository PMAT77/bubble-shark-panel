import type { FastifyRequest } from 'fastify'
import type { ApiErrorResponse } from '../../../../shared/contracts/api'
import { ErrorCode } from '../../../../shared/constants/error-code'
import type { PermissionKey } from '../../../../shared/constants/permissions'
import { findPermissionSpec } from '../../../../shared/constants/permissions'
import {
  findPermissionsByUserId,
  findRoleKindByUserId,
  findUserByToken,
  hasInstanceGrant,
  listGrantedInstanceIds,
  userMustChangePassword,
} from '../../shared/db/index'
import { businessError, unauthorized } from '../../shared/http/response'
import { normalizeRequestToken } from '../../shared/http/token'

const FORCE_PASSWORD_CHANGE_ALLOWED_PATHS = new Set([
  '/app/account/password/edit',
  '/app/account/logout',
  '/app/account/permission',
  /**
   * 菜单必须在待改密时也能拿到。
   *
   * 前端要先用它注册动态路由，才渲染得出改密页所在的布局；拿不到时路由守卫会失败，
   * 再与"强制改密跳转"互相抢导航，页面就会反复重试（曾实测几百次请求）。
   *
   * 放行它不削弱限制：返回的只是这个账号有权进入的模块，不含任何操作能力 ——
   * 待改密账号调任何写接口仍会被这条规则拦住。
   */
  '/app/route/list',
])

function getTokenByRequest(request: FastifyRequest): string | undefined {
  const token = normalizeRequestToken(request.headers.token)
  if (!token) {
    return undefined
  }
  return token
}

interface AuthOptions {
  allowQueryToken?: boolean
}

export interface RequirePermissionOptions extends AuthOptions {
  permissions?: string | string[]
}

export interface AuthorizedUser {
  id: string
  account: string
}

export interface AuthorizedContext {
  token: string
  user: AuthorizedUser
  permissions: string[]
}

function resolveToken(request: FastifyRequest, options?: AuthOptions): string | undefined {
  const token = getTokenByRequest(request)
  if (token) {
    return token
  }
  if (!options?.allowQueryToken) {
    return undefined
  }
  const query = request.query as { token?: string }
  return query.token?.trim() || undefined
}

function normalizeRequiredPermissions(input: RequirePermissionOptions['permissions']): string[] {
  if (!input) {
    return []
  }
  if (Array.isArray(input)) {
    return input.map(item => item.trim()).filter(Boolean)
  }
  const value = input.trim()
  return value ? [value] : []
}

export async function resolveAuthorizedContext(
  request: FastifyRequest,
  options?: RequirePermissionOptions,
): Promise<{ error?: ApiErrorResponse, context?: AuthorizedContext }> {
  const token = resolveToken(request, options)
  if (!token) {
    return { error: unauthorized(request) }
  }
  const user = await findUserByToken(token)
  if (!user) {
    return { error: unauthorized(request) }
  }

  if (
    userMustChangePassword(user)
    && !FORCE_PASSWORD_CHANGE_ALLOWED_PATHS.has(request.url.split('?')[0] ?? '')
  ) {
    return {
      error: businessError(
        '首次登录须修改初始密码',
        request,
        ErrorCode.FORCE_PASSWORD_CHANGE,
        { mustChangePassword: true },
      ),
    }
  }

  const requiredPermissions = normalizeRequiredPermissions(options?.permissions)
  let permissions: string[] = []
  if (requiredPermissions.length > 0) {
    permissions = await findPermissionsByUserId(user.id)
    const permissionSet = new Set(permissions)
    const hasAllPermissions = requiredPermissions.every(permission => permissionSet.has(permission))
    if (!hasAllPermissions) {
      return {
        error: businessError('当前账号无权限执行该操作', request, ErrorCode.FORBIDDEN, {
          requiredPermissions,
        }),
      }
    }
  }

  return {
    context: {
      token,
      user: {
        id: user.id,
        account: user.account,
      },
      permissions,
    },
  }
}

export async function requirePermission(
  request: FastifyRequest,
  permissionsOrOptions?: string | string[] | RequirePermissionOptions,
  maybeOptions?: AuthOptions,
): Promise<ApiErrorResponse | undefined> {
  const options: RequirePermissionOptions
    = typeof permissionsOrOptions === 'string' || Array.isArray(permissionsOrOptions)
      ? {
          permissions: permissionsOrOptions,
          ...maybeOptions,
        }
      : (permissionsOrOptions ?? {})

  const auth = await resolveAuthorizedContext(request, options)
  if (auth.error) {
    return auth.error
  }
}

export async function verifyAuthorized(request: FastifyRequest): Promise<ApiErrorResponse | undefined> {
  return requirePermission(request)
}

// ── 实例级鉴权 ────────────────────────────────────────────────────────────
/**
 * 为什么单开一层：`requirePermission` 只回答「这个账号有没有这个权限点」，
 * 而本项目的权限是**双层**的——角色定「能做什么」，实例授权定「能在哪些实例上做」。
 * 只看权限点的话，一个只有 `room:read` 的账号能读遍所有实例的房间配置。
 *
 * 三条规矩（改动前先读）：
 * 1. **先权限点、后实例授权**，两者都过才返回 context；
 * 2. 授权失败一律回同一句文案，不区分「实例不存在」与「无权限」——否则这个接口会变成一个
 *    实例 ID 枚举器。调用方在鉴权通过之后才去查实例，「实例不存在」只对有权限的人可见；
 * 3. 结果按请求缓存：一次请求里同一用户的权限点、角色类型、实例授权各查一次，
 *    不然像「列表 + 逐条操作」这种路由会把查询放大成 N 倍。
 */
interface RequestAuthCache {
  roleKind?: Map<string, Promise<'user' | 'guest' | undefined>>
  grant?: Map<string, Promise<boolean>>
  visibleInstanceIds?: Map<string, Promise<string[]>>
}

const requestAuthCache = new WeakMap<FastifyRequest, RequestAuthCache>()

function cacheFor(request: FastifyRequest): RequestAuthCache {
  let cache = requestAuthCache.get(request)
  if (!cache) {
    cache = {}
    requestAuthCache.set(request, cache)
  }
  return cache
}

function cachedRoleKind(request: FastifyRequest, userId: string): Promise<'user' | 'guest' | undefined> {
  const cache = cacheFor(request)
  cache.roleKind ??= new Map()
  let task = cache.roleKind.get(userId)
  if (!task) {
    task = findRoleKindByUserId(userId)
    cache.roleKind.set(userId, task)
  }
  return task
}

function cachedHasGrant(request: FastifyRequest, userId: string, instanceId: string): Promise<boolean> {
  const cache = cacheFor(request)
  cache.grant ??= new Map()
  const key = `${userId}\u0000${instanceId}`
  let task = cache.grant.get(key)
  if (!task) {
    task = hasInstanceGrant(userId, instanceId)
    cache.grant.set(key, task)
  }
  return task
}

function cachedVisibleInstanceIds(request: FastifyRequest, userId: string): Promise<string[]> {
  const cache = cacheFor(request)
  cache.visibleInstanceIds ??= new Map()
  let task = cache.visibleInstanceIds.get(userId)
  if (!task) {
    task = listGrantedInstanceIds(userId)
    cache.visibleInstanceIds.set(userId, task)
  }
  return task
}

/** 游客角色对任何写权限点的统一拒绝文案 */
const GUEST_WRITE_DENIED_MESSAGE = '当前账号是只读的游客角色，不能执行这项操作'

/**
 * 实例级鉴权：权限点 + 实例授权 + 游客写保护。
 *
 * 仅用于**针对某个具体实例**的路由。列表与聚合接口用 `resolveInstanceScope`，
 * 因为它们的语义是「按可见范围过滤」而不是「对某个实例放行/拒绝」。
 */
export async function authorizeInstance(
  request: FastifyRequest,
  instanceId: string,
  permission: PermissionKey,
  options?: AuthOptions,
): Promise<{ error?: ApiErrorResponse, context?: AuthorizedContext }> {
  if (!instanceId?.trim()) {
    return { error: businessError('实例 ID 不能为空', request) }
  }
  const auth = await resolveAuthorizedContext(request, { ...options, permissions: permission })
  if (auth.error || !auth.context) {
    return { error: auth.error ?? unauthorized(request) }
  }
  const userId = auth.context.user.id

  // 第二道保险：即使有人在角色管理页给游客角色勾上了权限点，写操作仍然拒绝。
  // 游客角色是将来公开只读预览的唯一安全阀，值得为它多写一次判断。
  const spec = findPermissionSpec(permission)
  if (spec?.action === 'write' && await cachedRoleKind(request, userId) === 'guest') {
    return { error: businessError(GUEST_WRITE_DENIED_MESSAGE, request, ErrorCode.FORBIDDEN) }
  }

  if (!await cachedHasGrant(request, userId, instanceId)) {
    return { error: businessError('没有该实例的访问权限', request, ErrorCode.FORBIDDEN) }
  }

  return { context: auth.context }
}

/**
 * 聚合/列表接口的可见范围：鉴权之后返回该账号被授权的实例 ID。
 *
 * 调用方把返回的集合当作**过滤条件**（而不是装饰）：不在集合里的实例，
 * 列表、状态计数、备份列表、计划任务列表里都不该出现。
 */
export async function resolveInstanceScope(
  request: FastifyRequest,
  permission: PermissionKey,
  options?: AuthOptions,
): Promise<{ error?: ApiErrorResponse, context?: AuthorizedContext, instanceIds?: readonly string[] }> {
  const auth = await resolveAuthorizedContext(request, { ...options, permissions: permission })
  if (auth.error || !auth.context) {
    return { error: auth.error ?? unauthorized(request) }
  }
  const instanceIds = await cachedVisibleInstanceIds(request, auth.context.user.id)
  return { context: auth.context, instanceIds }
}

/**
 * 内部调用（计划任务、插件生命周期）不走这一层：它们直接用 `skipAuth` 跳过
 * （`instance/index.ts` 的 `handleInstanceStart` 就是这种形态），授权由各自的调用方保证——
 * 调度器只会触发自己建的任务，插件的写能力要过「清单声明 + 签名 + 授权 + 启用时确认」四道。
 *
 * **不要在这里加基于请求头的旁路**：请求头对外部可控，加一个等于开后门。
 */

