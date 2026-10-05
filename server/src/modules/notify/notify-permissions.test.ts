import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { registerNotifyModule } from './index'
import { registerAuthModule } from '../auth/index'
import { closeDatabase, initDatabase } from '../../shared/db/index'
import { ensureDb, nowIso } from '../../shared/db/connection'
import { userPermissions, users } from '../../shared/db/schema/index'

/**
 * 通知渠道与阈值的**读写分离**。
 *
 * 通知渠道是系统设置页里的一个 tab，而只读账号（游客角色）能进系统设置页。
 * 这里原先整块都要求 `settings:write`，于是只读账号一打开这个 tab 就是 403——
 * 「能看所有页面」直接破功。所以读接口（列表、读阈值、读渠道）必须只要求
 * `settings:read`，而增删改与测试发送仍然要求 `settings:write`。
 */

const dbFilePath = path.join(os.tmpdir(), `bsp-notify-permissions-${randomUUID()}.sqlite`)
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle')

interface ApiEnvelope<T> {
  status: 0 | 1
  error: string
  code: string
  data: T
}

let app: FastifyInstance
let token = ''
let userId = ''

const SETTINGS_PAYLOAD = {
  enabled: true,
  cooldownMinutes: 10,
  thresholds: { cpuPercent: 90, memPercent: 90, diskPercent: 90 },
}

async function setPermissions(permissions: readonly string[]): Promise<void> {
  const { drizzleDb } = ensureDb()
  await drizzleDb.delete(userPermissions).where(eq(userPermissions.userId, userId))
  if (permissions.length > 0) {
    await drizzleDb.insert(userPermissions).values(
      permissions.map(permission => ({ userId, permission, createdAt: nowIso() })),
    )
  }
}

async function post<T>(url: string, payload: Record<string, unknown> = {}): Promise<ApiEnvelope<T>> {
  const response = await app.inject({ method: 'POST', url, headers: { token }, payload })
  return JSON.parse(response.body) as ApiEnvelope<T>
}

describe('通知渠道接口的读写权限', () => {
  before(async () => {
    await initDatabase(dbFilePath, migrationsFolder)
    app = Fastify({ logger: false })
    registerAuthModule(app)
    registerNotifyModule(app)
    await app.ready()

    const login = await app.inject({
      method: 'POST',
      url: '/app/account/login',
      payload: { account: 'superadmin', password: '123456' },
    })
    token = (JSON.parse(login.body) as ApiEnvelope<{ token: string }>).data.token

    const { drizzleDb } = ensureDb()
    const rows = await drizzleDb.select().from(users).where(eq(users.account, 'superadmin'))
    userId = rows[0]!.id
  })

  after(async () => {
    await app.close()
    closeDatabase()
  })

  it('只有读权限时，渠道列表与阈值设置都能读出来', async () => {
    await setPermissions(['settings:read'])

    const list = await post('/app/notify/channel/list')
    assert.equal(list.error, '', `只读账号必须能列出渠道，否则设置页的通知 tab 一打开就报错：${list.error}`)
    assert.equal(list.status, 1)

    const settings = await post('/app/notify/settings/get')
    assert.equal(settings.error, '', '只读账号必须能读到阈值设置')
  })

  it('只有读权限时，增删改与测试发送一律被拒', async () => {
    await setPermissions(['settings:read'])

    for (const [url, payload] of [
      ['/app/notify/channel/create', { type: 'webhook', name: 'x', config: { webhookUrl: 'https://example.com/hook' } }],
      ['/app/notify/channel/update', { channelId: 'not-exist' }],
      ['/app/notify/channel/delete', { channelId: 'not-exist' }],
      ['/app/notify/channel/test', { channelId: 'not-exist' }],
      ['/app/notify/settings/save', SETTINGS_PAYLOAD],
    ] as const) {
      const body = await post(url, payload)
      assert.notEqual(body.error, '', `${url} 不该对只读账号放行`)
      assert.match(body.error, /无权限/, `${url} 的拒绝理由应当是缺少权限点，实际：${body.error}`)
    }
  })

  it('有写权限时阈值可以保存', async () => {
    await setPermissions(['settings:write'])

    const save = await post('/app/notify/settings/save', SETTINGS_PAYLOAD)
    assert.equal(save.error, '', `有 settings:write 时保存阈值应当成功，实际：${save.error}`)
  })
})
