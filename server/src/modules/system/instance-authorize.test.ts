import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { after, before, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import type { PermissionKey } from '../../../../shared/constants/permissions'
import { registerAuthModule } from '../auth/index'
import { authorizeInstance, requirePermission, resolveInstanceScope } from './auth'
import { closeDatabase, initDatabase } from '../../shared/db/index'
import { ensureDb, nowIso } from '../../shared/db/connection'
import { gameInstances, instanceGrants, roles, userPermissions, userRoles, users } from '../../shared/db/schema/index'

/**
 * 实例级鉴权。
 *
 * 这是整次 RBAC 改造的核心：在它出现之前，一个只有 `room:read` 的账号能读遍**所有实例**的
 * 房间配置——权限点只回答了「能做什么」，没人回答「能在哪些实例上做」。
 *
 * 三条必须成立的性质：
 * 1. 权限点与实例授权**同时**满足才放行；
 * 2. 授权失败与实例不存在回**同一句文案**（否则这个接口就是实例 ID 枚举器）；
 * 3. 游客角色即使被误配了写权限点，写操作仍然拒绝——实例级与**全局**写接口都要拒
 *    （判断在 `resolveAuthorizedContext` 里，两条路径都经过它）。
 *
 * **本项目的接口断言口径**（`docs_local/module-status.md` 记过，这里再写一遍防止踩第二次）：
 * 业务错误走 **HTTP 200 + `status: 1` + 非空 `error`**；`status: 0` 专指「未登录 / 登录失效」。
 * 所以「成功」的判据是 `status === 1 && error === ''`，不能只看 status。
 */

interface ApiEnvelope<T> {
  status: 0 | 1
  error: string
  code: string
  data: T
}

const dbFilePath = path.join(os.tmpdir(), `gsh-instance-authorize-${randomUUID()}.sqlite`)
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle')

const INSTANCE_A = 'instance-a'
const INSTANCE_B = 'instance-b'

/** 被测路由：每个路由用一个不同的权限点，覆盖读、写、生命周期三类 */
const ROUTES: Array<{ path: string, permission: PermissionKey }> = [
  { path: '/t/room-read', permission: 'room:read' },
  { path: '/t/room-write', permission: 'room:write' },
  { path: '/t/lifecycle', permission: 'instance:lifecycle' },
]

let app: FastifyInstance
let token = ''
let userId = ''
let guestRoleId = ''

function parseBody<T>(body: string): ApiEnvelope<T> {
  return JSON.parse(body) as ApiEnvelope<T>
}

/** 当前数据库句柄。测试里直接用 drizzle 摆前置数据，不走 service 层 */
function db() {
  return ensureDb().drizzleDb
}

async function setPermissions(permissions: readonly string[]): Promise<void> {
  const d = db()
  await d.delete(userPermissions).where(eq(userPermissions.userId, userId))
  if (permissions.length > 0) {
    await d.insert(userPermissions).values(
      permissions.map(permission => ({ userId, permission, createdAt: nowIso() })),
    )
  }
}

async function setGrants(instanceIds: readonly string[]): Promise<void> {
  const d = db()
  await d.delete(instanceGrants).where(eq(instanceGrants.userId, userId))
  if (instanceIds.length > 0) {
    await d.insert(instanceGrants).values(
      instanceIds.map(instanceId => ({ userId, instanceId, grantedBy: null, createdAt: nowIso() })),
    )
  }
}

async function setRole(roleId: string | null): Promise<void> {
  const d = db()
  await d.delete(userRoles).where(eq(userRoles.userId, userId))
  if (roleId) {
    await d.insert(userRoles).values({ userId, roleId, createdAt: nowIso() })
  }
}

async function call(path: string, instanceId: string, authToken = token) {
  const response = await app.inject({
    method: 'POST',
    url: path,
    headers: { token: authToken },
    payload: { instanceId },
  })
  return parseBody<{ ok: boolean }>(response.body)
}

/** 调不接收实例 ID 的全局接口 */
async function callGlobal(path: string, authToken = token) {
  const response = await app.inject({
    method: 'POST',
    url: path,
    headers: { token: authToken },
    payload: {},
  })
  return parseBody<{ ok: boolean }>(response.body)
}

/** 成功 = status 1 且没有 error（业务失败同样是 status 1，不能只看 status） */
function isOk(body: ApiEnvelope<{ ok: boolean }>): boolean {
  return body.status === 1 && body.error === ''
}

/** 被拒绝 = 有非空 error（含未登录 status 0 与业务失败 status 1 两种） */
function isDenied(body: ApiEnvelope<{ ok: boolean }>): boolean {
  return body.error.length > 0
}

describe('实例级鉴权 authorizeInstance', () => {
  before(async () => {
    await initDatabase(dbFilePath, migrationsFolder)
    app = Fastify({ logger: false })
    registerAuthModule(app)

    for (const route of ROUTES) {
      app.post(route.path, async (request) => {
        const body = request.body as { instanceId: string }
        const authorized = await authorizeInstance(request, body.instanceId, route.permission)
        if (authorized.error) {
          return authorized.error
        }
        return { status: 1, error: '', code: 'OK', data: { ok: true } }
      })
    }
    // 聚合计口径：返回该账号被授权的实例集合
    app.post('/t/scope', async (request) => {
      const scope = await resolveInstanceScope(request, 'instance:read')
      if (scope.error) {
        return scope.error
      }
      return { status: 1, error: '', code: 'OK', data: { instanceIds: scope.instanceIds } }
    })
    /**
     * 全局（与具体实例无关）的读写接口。
     *
     * 游客禁写必须覆盖到这一层：它原先只写在 `authorizeInstance` 里，
     * 而面板设置、成员、插件这些写接口走的是 `requirePermission`，
     * 只读账号能直接调它们。
     */
    app.post('/t/global-write', async (request) => {
      const authError = await requirePermission(request, 'settings:write')
      if (authError) {
        return authError
      }
      return { status: 1, error: '', code: 'OK', data: { ok: true } }
    })
    app.post('/t/global-read', async (request) => {
      const authError = await requirePermission(request, 'settings:read')
      if (authError) {
        return authError
      }
      return { status: 1, error: '', code: 'OK', data: { ok: true } }
    })
    await app.ready()

    const login = await app.inject({
      method: 'POST',
      url: '/app/account/login',
      payload: { account: 'superadmin', password: '123456' },
    })
    token = parseBody<{ token: string }>(login.body).data.token

    const d = db()
    const adminRows = await d.select().from(users).where(eq(users.account, 'superadmin'))
    userId = adminRows[0]!.id

    const guestRows = await d.select().from(roles).where(eq(roles.key, 'guest'))
    guestRoleId = guestRows[0]!.id

    const now = nowIso()
    for (const id of [INSTANCE_A, INSTANCE_B]) {
      await d.insert(gameInstances).values({
        id,
        nodeId: 'local-node',
        name: `实例 ${id}`,
        gameCode: 'dst',
        status: 'stopped',
        updateAvailable: 0,
        createdAt: now,
        updatedAt: now,
      })
    }
  })

  after(async () => {
    await app.close()
    closeDatabase()
  })

  beforeEach(async () => {
    // 每个用例前重置成「有权限点、有角色、无实例授权」的干净基线，避免用例之间互相污染
    await setPermissions(['room:read', 'room:write', 'instance:lifecycle', 'instance:read'])
    await setRole(null)
    await setGrants([])
  })

  it('未登录返回未认证', async () => {
    const body = await call('/t/room-read', INSTANCE_A, 'bad-token')
    assert.equal(body.status, 0, 'status 0 专指未登录/登录失效')
  })

  it('缺少权限点时拒绝', async () => {
    await setPermissions([])
    await setGrants([INSTANCE_A])
    const body = await call('/t/room-read', INSTANCE_A)
    assert.equal(isDenied(body), true)
    assert.match(body.error, /无权/)
  })

  it('有权限点但没被授权这个实例时拒绝，且文案不区分"实例不存在"', async () => {
    await setGrants([INSTANCE_B])
    const denied = await call('/t/room-read', INSTANCE_A)
    assert.equal(isDenied(denied), true)
    assert.match(denied.error, /没有该实例的访问权限/)

    const missing = await call('/t/room-read', 'not-an-instance')
    assert.equal(isDenied(missing), true)
    assert.equal(
      missing.error,
      denied.error,
      '无授权与实例不存在必须回同一句文案，否则接口会变成实例 ID 枚举器',
    )
  })

  it('权限点与实例授权同时满足才放行', async () => {
    await setGrants([INSTANCE_A])
    const allowed = await call('/t/room-read', INSTANCE_A)
    assert.equal(isOk(allowed), true)
    assert.equal(allowed.data.ok, true)

    // 换一个没被授权的实例，立刻拒绝
    const denied = await call('/t/room-read', INSTANCE_B)
    assert.equal(isDenied(denied), true)
  })

  it('读权限不会顺带给出写能力', async () => {
    await setPermissions(['room:read'])
    await setGrants([INSTANCE_A])
    assert.equal(isOk(await call('/t/room-read', INSTANCE_A)), true, '读应当放行')
    assert.equal(isDenied(await call('/t/room-write', INSTANCE_A)), true, '没有 room:write 就不该能写')
    assert.equal(isDenied(await call('/t/lifecycle', INSTANCE_A)), true, '更不能启停实例')
  })

  it('游客角色即使被配上写权限点，写操作仍然拒绝', async () => {
    await setRole(guestRoleId)
    // 故意把写权限点也给它：模拟「有人在角色管理页给游客勾了写权限」
    await setPermissions(['room:read', 'room:write', 'instance:lifecycle'])
    await setGrants([INSTANCE_A])

    const write = await call('/t/room-write', INSTANCE_A)
    assert.equal(isDenied(write), true, '游客的写操作必须被拒——这是第二道保险，不能只靠角色配置自觉')
    assert.match(write.error, /游客/)

    const lifecycle = await call('/t/lifecycle', INSTANCE_A)
    assert.equal(isDenied(lifecycle), true)

    const read = await call('/t/room-read', INSTANCE_A)
    assert.equal(isOk(read), true, '游客的读操作应当正常放行')
  })

  it('游客在全局写接口上同样被拒，全局读接口正常', async () => {
    await setRole(guestRoleId)
    // 同样假设权限点被误配上了：全局接口的写保护不能只依赖「游客没有写权限点」
    await setPermissions(['settings:read', 'settings:write'])

    const write = await callGlobal('/t/global-write')
    assert.equal(isDenied(write), true, '全局写接口（面板设置等）必须拒绝游客')
    assert.match(write.error, /游客/)

    const read = await callGlobal('/t/global-read')
    assert.equal(isOk(read), true, '游客的全局读接口应当正常放行')
  })

  it('实例 ID 为空时拒绝', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/t/room-read',
      headers: { token },
      payload: { instanceId: '' },
    })
    const body = parseBody<{ ok: boolean }>(response.body)
    assert.equal(isDenied(body), true)
    assert.match(body.error, /实例 ID/)
  })

  it('聚合接口只返回被授权的实例', async () => {
    await setGrants([INSTANCE_B])
    const response = await app.inject({
      method: 'POST',
      url: '/t/scope',
      headers: { token },
      payload: {},
    })
    const body = parseBody<{ instanceIds: string[] }>(response.body)
    assert.equal(body.status, 1)
    assert.deepEqual(body.data.instanceIds, [INSTANCE_B], '可见范围必须只含被授权的实例')
  })

  it('聚合接口在没有授权时返回空集合而不是报错', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/t/scope',
      headers: { token },
      payload: {},
    })
    const body = parseBody<{ instanceIds: string[] }>(response.body)
    assert.equal(body.status, 1)
    assert.deepEqual(body.data.instanceIds, [])
  })
})
