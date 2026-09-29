import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { ErrorCode } from '../../../../shared/constants/error-code'
import { registerAuthModule } from '../auth/index'
import { requireAnyReadPermission, requirePermission } from './auth'
import { closeDatabase, initDatabase } from '../../shared/db/index'
import { ensureDb, nowIso } from '../../shared/db/connection'
import { userPermissions, users } from '../../shared/db/schema/index'

/**
 * 「任一读权限点即可」的鉴权（`requireAnyReadPermission`）。
 *
 * 它存在的理由：**同一份只读数据被多个模块共用**。主机指标（`/app/system/info`）既服务
 * 「监控台」（`console.monitor:read`）也服务「系统设置」（`settings:read`）；节点列表既服务
 * 监控也服务「实例管理」（`instance:read`）。修这类接口只能放行——如果反过来给菜单补
 * `settings:read`，等于让"只看监控"的角色拿到整份面板设置读权限。
 *
 * 三条必须成立的性质：
 * 1. 列表中**任意一项**权限点即可放行；
 * 2. 一项都不具备时按统一口径拒绝（HTTP 200 + `status: 1` + 非空 error + `AUTH_FORBIDDEN`）；
 * 3. **不能顺带放宽写**：只读权限点不能通过任何路径满足一个写接口。
 */

interface ApiEnvelope<T> {
  status: 0 | 1
  error: string
  code: string
  data: T
}

const dbFilePath = path.join(os.tmpdir(), `gsh-any-read-permission-${randomUUID()}.sqlite`)
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle')

let app: FastifyInstance
let token = ''
let userId = ''

function parseBody<T>(body: string): ApiEnvelope<T> {
  return JSON.parse(body) as ApiEnvelope<T>
}

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

async function call(path: string, authToken = token) {
  const response = await app.inject({
    method: 'POST',
    url: path,
    headers: authToken ? { token: authToken } : {},
    payload: {},
  })
  return parseBody<{ ok: boolean }>(response.body)
}

function isOk(body: ApiEnvelope<{ ok: boolean }>): boolean {
  return body.status === 1 && body.error === ''
}

describe('任一读权限点鉴权 requireAnyReadPermission', () => {
  before(async () => {
    await initDatabase(dbFilePath, migrationsFolder)
    app = Fastify({ logger: false })
    registerAuthModule(app)

    /** 主机指标：监控台与系统设置共用的只读数据 */
    app.post('/t/host-info', async (request) => {
      const authError = await requireAnyReadPermission(request, ['settings:read', 'console.monitor:read'])
      if (authError) {
        return authError
      }
      return { status: 1, error: '', code: 'OK', data: { ok: true } }
    })

    /** 节点列表：监控台与实例管理共用的只读数据 */
    app.post('/t/node-list', async (request) => {
      const authError = await requireAnyReadPermission(request, ['console.monitor:read', 'instance:read'])
      if (authError) {
        return authError
      }
      return { status: 1, error: '', code: 'OK', data: { ok: true } }
    })

    /** 对照用的写接口：任一读权限点都不该能满足它 */
    app.post('/t/settings-write', async (request) => {
      const authError = await requirePermission(request, 'settings:write')
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

    const rows = await db().select().from(users).where(eq(users.account, 'superadmin'))
    userId = rows[0]!.id

    // 权限由每个用例自己摆：先清空，避免管理员的全量权限污染判定
    await setPermissions([])
  })

  after(async () => {
    await app.close()
    closeDatabase()
  })

  it('列表里的任意一项权限点都能放行', async () => {
    await setPermissions(['console.monitor:read'])
    assert.equal(isOk(await call('/t/host-info')), true, 'console.monitor:read 应当能读主机指标')

    await setPermissions(['settings:read'])
    assert.equal(isOk(await call('/t/host-info')), true, 'settings:read 同样应当能读主机指标')

    await setPermissions([])
  })

  it('不同接口的列表各自独立：节点列表认 instance:read', async () => {
    await setPermissions(['instance:read'])
    assert.equal(isOk(await call('/t/node-list')), true, 'instance:read 应当能读节点列表')

    await setPermissions(['console.monitor:read'])
    assert.equal(isOk(await call('/t/node-list')), true, 'console.monitor:read 同样应当能读节点列表')

    await setPermissions([])
  })

  it('一项都不具备时按统一口径拒绝', async () => {
    await setPermissions(['room:read', 'world:read'])
    const denied = await call('/t/host-info')
    assert.equal(denied.status, 1, '业务失败是 HTTP 200 + status:1，不是 status:0')
    assert.ok(denied.error.length > 0, '拒绝时必须带非空 error')
    assert.equal(denied.code, ErrorCode.FORBIDDEN)
  })

  it('未登录时不放行', async () => {
    const anonymous = await call('/t/host-info', '')
    assert.equal(anonymous.status, 0, '未登录是 status:0')
    assert.ok(anonymous.error.length > 0)
  })

  it('「任一」不会放宽写接口：只读权限点一个都满足不了 settings:write', async () => {
    await setPermissions(['settings:read', 'console.monitor:read', 'instance:read'])
    const denied = await call('/t/settings-write')
    assert.ok(denied.error.length > 0, '读权限不能顺带把写接口放行')
    assert.equal(denied.status, 1)
  })
})
