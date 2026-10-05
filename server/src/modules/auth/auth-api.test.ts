import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { registerAuthModule } from './index'
import { createMember, listRoleItems } from '../system/rbac-service'
import { initDatabase, closeDatabase } from '../../shared/db/index'
import { loadServerConfig } from '../../shared/config'

interface ApiEnvelope<T> {
  status: 0 | 1
  error: string
  code: string
  data: T
}

interface LoginData {
  account: string
  token: string
  refreshToken: string
}

const dbFilePath = path.join(os.tmpdir(), `bsp-auth-api-test-${randomUUID()}.sqlite`)
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle')

let app: FastifyInstance

function parseBody<T>(body: string): ApiEnvelope<T> {
  return JSON.parse(body) as ApiEnvelope<T>
}

describe('auth api token lifecycle', () => {
  before(async () => {
    await initDatabase(dbFilePath, migrationsFolder)
    app = Fastify({
      logger: false,
    })
    registerAuthModule(app)
    await app.ready()
  })

  after(async () => {
    await app.close()
    closeDatabase()
  })

  it('supports login -> refresh -> old refresh invalid', async () => {
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/app/account/login',
      payload: {
        account: 'superadmin',
        password: '123456',
      },
    })
    assert.equal(loginResponse.statusCode, 200)
    const loginBody = parseBody<LoginData>(loginResponse.body)
    assert.equal(loginBody.status, 1)
    assert.ok(loginBody.data.token)
    assert.ok(loginBody.data.refreshToken)

    const refreshResponse = await app.inject({
      method: 'POST',
      url: '/app/account/token/refresh',
      payload: {
        refreshToken: loginBody.data.refreshToken,
      },
    })
    assert.equal(refreshResponse.statusCode, 200)
    const refreshBody = parseBody<LoginData>(refreshResponse.body)
    assert.equal(refreshBody.status, 1)
    assert.ok(refreshBody.data.token)
    assert.ok(refreshBody.data.refreshToken)
    assert.notEqual(refreshBody.data.refreshToken, loginBody.data.refreshToken)

    const replayResponse = await app.inject({
      method: 'POST',
      url: '/app/account/token/refresh',
      payload: {
        refreshToken: loginBody.data.refreshToken,
      },
    })
    assert.equal(replayResponse.statusCode, 200)
    const replayBody = parseBody<Record<string, never>>(replayResponse.body)
    assert.equal(replayBody.status, 0)
    assert.equal(replayBody.code, 'AUTH_UNAUTHORIZED')
  })

  it('revokes both access and refresh tokens on logout', async () => {
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/app/account/login',
      payload: {
        account: 'superadmin',
        password: '123456',
      },
    })
    const loginBody = parseBody<LoginData>(loginResponse.body)
    assert.equal(loginBody.status, 1)

    const logoutResponse = await app.inject({
      method: 'POST',
      url: '/app/account/logout',
      headers: {
        token: loginBody.data.token,
      },
      payload: {
        refreshToken: loginBody.data.refreshToken,
      },
    })
    assert.equal(logoutResponse.statusCode, 200)
    const logoutBody = parseBody<{ isSuccess: boolean }>(logoutResponse.body)
    assert.equal(logoutBody.status, 1)
    assert.equal(logoutBody.data.isSuccess, true)

    const permissionResponse = await app.inject({
      method: 'GET',
      url: '/app/account/permission',
      headers: {
        token: loginBody.data.token,
      },
    })
    const permissionBody = parseBody<Record<string, never>>(permissionResponse.body)
    assert.equal(permissionBody.status, 0)
    assert.equal(permissionBody.code, 'AUTH_UNAUTHORIZED')

    const refreshResponse = await app.inject({
      method: 'POST',
      url: '/app/account/token/refresh',
      payload: {
        refreshToken: loginBody.data.refreshToken,
      },
    })
    const refreshBody = parseBody<Record<string, never>>(refreshResponse.body)
    assert.equal(refreshBody.status, 0)
    assert.equal(refreshBody.code, 'AUTH_UNAUTHORIZED')
  })

  it('permission 接口会返回角色种类：普通账号是 user，游客角色是 guest', async () => {
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/app/account/login',
      payload: {
        account: 'superadmin',
        password: '123456',
      },
    })
    const adminToken = parseBody<LoginData>(adminLogin.body).data.token

    const adminPermission = await app.inject({
      method: 'GET',
      url: '/app/account/permission',
      headers: {
        token: adminToken,
      },
    })
    const adminBody = parseBody<{ roleKind: string | null }>(adminPermission.body)
    assert.equal(adminBody.status, 1)
    assert.equal(adminBody.data.roleKind, 'user', '管理员是普通角色，界面不该弹游客提示')

    const guestRole = (await listRoleItems()).find(role => role.kind === 'guest')
    assert.ok(guestRole, '内置游客角色应当存在')
    /**
     * 账号名必须是**配置里的游客账号名**（默认 `guest`）。
     *
     * 内置游客角色只能挂在这一个账号上——挂到别的账号上会让那个账号静默失去全部操作能力，
     * 所以成员服务会直接拒绝这种分配（见 `rbac-service.ts` 的 `assertGuestRoleAssignable`）。
     * 这里用配置里的名字，正是为了走"合法"的那条路。
     */
    const account = loadServerConfig().guestLoginAccount
    const created = await createMember({
      account,
      password: 'Guest-Pass#2026',
      roleId: guestRole.id,
    })
    assert.equal(created.ok, true, created.ok ? '' : created.message)
    if (!created.ok) {
      return
    }

    const guestLogin = await app.inject({
      method: 'POST',
      url: '/app/account/login',
      payload: {
        account,
        password: 'Guest-Pass#2026',
      },
    })
    const guestToken = parseBody<LoginData>(guestLogin.body).data.token
    const guestPermission = await app.inject({
      method: 'GET',
      url: '/app/account/permission',
      headers: {
        token: guestToken,
      },
    })
    const guestBody = parseBody<{ roleKind: string | null }>(guestPermission.body)
    assert.equal(guestBody.status, 1)
    assert.equal(guestBody.data.roleKind, 'guest', '游客角色要能认出来，界面据此提示「当前是游客模式」')
  })
})
