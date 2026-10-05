import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { registerAuthModule } from '../auth/index'
import { requireAnyReadPermission, requirePermission } from './auth'
import { closeDatabase, initDatabase } from '../../shared/db/index'
import { ensureDb, hashPassword, nowIso } from '../../shared/db/connection'
import { roles, userPermissions, userRoles, users } from '../../shared/db/schema/index'

/**
 * 「读接口但会改状态」对游客的拦截。
 *
 * 背景：游客（只读预览）的写保护此前只按 `action === 'write'` 判，于是
 * `/app/instance/world-state` 这类**权限点是读、实际会向游戏下发 `print` 指令**的接口
 * 被漏在闸门外面。它由前端实例详情页每 30 秒轮询一次，所以"漏掉"的后果不是
 * "游客少看一页"，而是任何匿名访客都能无成本地把游戏控制台刷成命令流水。
 *
 * 现在判据是 `isStateChangingPermission`（`action === 'write'` 或 `spec.sideEffect`），
 * 本文件钉住三件事：
 * 1. 带 `sideEffect` 的读权限点：游客被拒，普通角色放行；
 * 2. 「任一读权限点」形态的接口（`requireAnyReadPermission`）**不能**因此误伤——
 *    它传的是空的必需权限集合，把这条一起拒掉会让游客连监控台都打不开；
 * 3. 纯读权限点照旧放行（否则"能看不能改"里的"能看"就没了）。
 */

interface ApiEnvelope<T> {
  status: 0 | 1
  error: string
  code: string
  data: T
}

const dbFilePath = path.join(os.tmpdir(), `bsp-guest-read-guard-${randomUUID()}.sqlite`)
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle')

/** 造账号时统一用的口令：本文件只关心鉴权，不关心口令强度 */
const TEST_PASSWORD = 'Guest-Pass#2026'

let app: FastifyInstance
let guestToken = ''
let plainRoleToken = ''
let guestUserId = ''
let plainUserId = ''

function parseBody<T>(body: string): ApiEnvelope<T> {
  return JSON.parse(body) as ApiEnvelope<T>
}

function db() {
  return ensureDb().drizzleDb
}

async function login(account: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/app/account/login',
    payload: { account, password: TEST_PASSWORD },
  })
  return parseBody<{ token: string }>(response.body).data.token
}

async function createAccount(account: string, roleId: string, permissions: readonly string[]): Promise<string> {
  const d = db()
  const userId = randomUUID()
  const now = nowIso()
  await d.insert(users).values({
    id: userId,
    account,
    // 口令不是本用例的对象；用同一套 hash 造出来即可（登录要能过密码校验）
    passwordHash: hashPassword(TEST_PASSWORD),
    email: `${account}@local`,
    avatar: '',
    status: 1,
    mustChangePassword: 0,
    createdAt: now,
    updatedAt: now,
  })
  await d.insert(userRoles).values({ userId, roleId, createdAt: now })
  if (permissions.length > 0) {
    await d.insert(userPermissions).values(permissions.map(permission => ({ userId, permission, createdAt: now })))
  }
  return userId
}

/** 成功 = status 1 且没有 error（业务失败同样是 status 1，不能只看 status） */
function isOk(body: ApiEnvelope<{ ok: boolean }>): boolean {
  return body.status === 1 && body.error === ''
}

describe('游客的「会改状态的读接口」拦截', () => {
  before(async () => {
    await initDatabase(dbFilePath, migrationsFolder)
    app = Fastify({ logger: false })
    registerAuthModule(app)

    /** 与 `/app/instance/world-state`、`/app/instance/console/logs` 同形：单读权限点 */
    app.post('/t/console-read', async (request) => {
      const authError = await requirePermission(request, 'instance.console:read')
      if (authError) {
        return authError
      }
      return { status: 1, error: '', code: 'OK', data: { ok: true } }
    })
    /** 与 `/app/system/info` 同形：任一读权限点即可 */
    app.post('/t/any-read', async (request) => {
      const authError = await requireAnyReadPermission(request, ['settings:read', 'console.monitor:read'])
      if (authError) {
        return authError
      }
      return { status: 1, error: '', code: 'OK', data: { ok: true } }
    })
    /** 纯读权限点：游客必须照常放行 */
    app.post('/t/room-read', async (request) => {
      const authError = await requirePermission(request, 'room:read')
      if (authError) {
        return authError
      }
      return { status: 1, error: '', code: 'OK', data: { ok: true } }
    })
    await app.ready()

    const d = db()
    const guestRole = (await d.select().from(roles).where(eq(roles.key, 'guest')))[0]!
    const plainRole = (await d.select().from(roles).where(eq(roles.key, 'system-admin')))[0]!

    const sharedPermissions = ['instance.console:read', 'room:read', 'settings:read', 'console.monitor:read'] as const
    guestUserId = await createAccount(
      `guest-guard-${randomUUID().slice(0, 8)}`,
      guestRole.id,
      sharedPermissions,
    )
    /**
     * 普通角色账号：权限点完全相同，只是角色种类是 `user`。
     * 它必须**不被**这道闸门拦住——否则"看控制台"对只读角色就整个消失了。
     */
    plainUserId = await createAccount(
      `plain-role-${randomUUID().slice(0, 8)}`,
      plainRole.id,
      sharedPermissions,
    )

    const guestAccount = (await d.select().from(users).where(eq(users.id, guestUserId)))[0]!
    const plainAccount = (await d.select().from(users).where(eq(users.id, plainUserId)))[0]!
    guestToken = await login(guestAccount.account)
    plainRoleToken = await login(plainAccount.account)
  })

  after(async () => {
    await app.close()
    closeDatabase()
  })

  async function call(path: string, authToken: string) {
    const response = await app.inject({
      method: 'POST',
      url: path,
      headers: { token: authToken },
      payload: {},
    })
    return parseBody<{ ok: boolean }>(response.body)
  }

  it('带 sideEffect 的读权限点：游客被拒，普通角色放行', async () => {
    const guestBody = await call('/t/console-read', guestToken)
    assert.equal(isOk(guestBody), false, 'world-state 会给游戏下发指令，游客不能调')
    assert.match(guestBody.error, /游客/)

    const plainBody = await call('/t/console-read', plainRoleToken)
    assert.equal(isOk(plainBody), true, '普通角色没有这道限制，否则"看控制台"就没了')
  })

  it('「任一读权限点」形态不被误伤：游客照样能看监控台', async () => {
    const guestBody = await call('/t/any-read', guestToken)
    assert.equal(
      isOk(guestBody),
      true,
      '这类接口传的必需权限集合是空的，若一刀切拒绝，游客连监控台都打不开',
    )
  })

  it('纯读权限点照旧放行', async () => {
    const guestBody = await call('/t/room-read', guestToken)
    assert.equal(isOk(guestBody), true, '「能看不能改」里的"能看"必须保住')
  })
})
