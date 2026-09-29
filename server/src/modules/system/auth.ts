import type { FastifyRequest } from 'fastify'
import type { ApiErrorResponse } from '../../../../shared/contracts/api'
import { ErrorCode } from '../../../../shared/constants/error-code'
import type { PermissionKey, ReadPermissionKey } from '../../../../shared/constants/permissions'
import { isStateChangingPermission } from '../../../../shared/constants/permissions'
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

  /**
   * 第二道保险：游客角色一律不能执行写操作，也不能调用"读接口但会改状态"的接口。
   *
   * 正常路径下游客只有 read 权限点，写接口在权限点校验那一步就过不去；这里再拦一次，
   * 是因为游客角色是「只读预览」的唯一安全阀——即使有人绕过角色管理接口直接改库给它
   * 加上写权限点，写操作依然不生效。
   *
   * 判据用 `isStateChangingPermission` 而不是 `action === 'write'`：后者会漏掉
   * `instance.console:read` 这一处——`/app/instance/world-state` 的权限点是读，
   * 但它会向运行中的游戏下发一条 `print` 指令。漏掉的后果不是"游客少看一页"，
   * 而是任何匿名访客都能按页面的 30 秒轮询免费放大成对游戏的控制台命令注入。
   *
   * 为什么放在这一层：`requirePermission` / `resolveInstanceScope` / `authorizeInstance`
   * 三条鉴权路径都经过 `resolveAuthorizedContext`，一处就覆盖了全部写接口，
   * 不用逐个路由加判断。
   */
  const stateChangingPermission = requiredPermissions.find(permission => isStateChangingPermission(permission))
  if (stateChangingPermission && await cachedRoleKind(request, user.id) === 'guest') {
    return { error: businessError(GUEST_WRITE_DENIED_MESSAGE, request, ErrorCode.FORBIDDEN) }
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

/**
 * 「任一读权限点即可」的鉴权。
 *
 * 用于**同一份只读数据被多个模块共用**的接口：主机信息（`/app/system/info`）既服务
 * 「监控台」（`console.monitor:read`）也服务「系统设置」（`settings:read`）；节点列表
 * 既服务「实例管理」（`instance:read`）也服务监控。修这类接口的方式是放行，而不是给菜单
 * 补 `settings:read`——后者会让"只看监控"的角色被迫拿到整份面板设置读权限。
 *
 * 三条约束：
 * 1. 参数类型是 `ReadPermissionKey[]`（只读权限点），**传写权限点会编译报错**：
 *    "任一命中即放行"用在写上就是越权，这里不给运行时反悔的机会；
 * 2. 仍然是**登录 + 权限**两道都要过（走 `resolveAuthorizedContext`，因此
 *    待改密拦截、令牌校验、游客判断的口径与其它接口完全一致）；
 * 3. 只用于只读接口。写接口一律继续用 `requirePermission`（数组是 every 语义）。
 */
export async function resolveAnyReadPermission(
  request: FastifyRequest,
  permissions: readonly [ReadPermissionKey, ...ReadPermissionKey[]],
): Promise<{ error?: ApiErrorResponse, context?: AuthorizedContext }> {
  const auth = await resolveAuthorizedContext(request)
  if (auth.error || !auth.context) {
    return { error: auth.error ?? unauthorized(request) }
  }
  // resolveAuthorizedContext 只在传了权限点时才查权限表，这里需要完整集合，所以显式取一次
  const granted = new Set(await findPermissionsByUserId(auth.context.user.id))
  if (permissions.some(permission => granted.has(permission))) {
    return { context: auth.context }
  }
  return {
    error: businessError('当前账号无权限执行该操作', request, ErrorCode.FORBIDDEN, {
      requiredPermissions: [...permissions],
    }),
  }
}

/**
 * 上面那条鉴权的「只要错误」形态，供只需要"过不过"的调用方使用。
 *
 * 需要 `context`（例如接着要查这个账号被授权了哪些实例）时用 `resolveAnyReadPermission`，
 * 别在这里再查一次用户。
 */
export async function requireAnyReadPermission(
  request: FastifyRequest,
  permissions: readonly [ReadPermissionKey, ...ReadPermissionKey[]],
): Promise<ApiErrorResponse | undefined> {
  const auth = await resolveAnyReadPermission(request, permissions)
  return auth.error
}

/**
 * 该账号可见的实例 id 集合（只看实例授权，**不判权限**）。
 *
 * 权限由调用方先判（`resolveAnyReadPermission` / `resolveInstanceScope`），这里只回答
 * "能在哪些实例上做"。列表类接口把返回的集合当**过滤条件**，而不是提示。
 */
export async function resolveVisibleInstanceIds(
  request: FastifyRequest,
  userId: string,
): Promise<readonly string[]> {
  return cachedVisibleInstanceIds(request, userId)
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

/**
 * 游客角色对任何写操作（写权限点，或标了 `sideEffect` 的读接口）的统一拒绝文案。
 *
 * 判断在 `resolveAuthorizedContext` 里，覆盖全局与实例两级接口。
 */
const GUEST_WRITE_DENIED_MESSAGE = '当前账号是只读的游客角色，不能执行这项操作'

/**
 * 实例级鉴权：权限点 + 实例授权。
 *
 * 仅用于**针对某个具体实例**的路由。列表与聚合接口用 `resolveInstanceScope`，
 * 因为它们的语义是「按可见范围过滤」而不是「对某个实例放行/拒绝」。
 *
 * 游客的写保护不在这里：它上移到 `resolveAuthorizedContext`（见该函数里的注释），
 * 因为除了实例级路由，全局写接口同样需要这道保险。
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

