import assert from 'node:assert/strict'
import fs from 'node:fs'
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
import { registerInstanceModule } from './index'
import { addUserInstanceGrants, closeDatabase, createGameInstance, findUserByAccount, initDatabase } from '../../shared/db/index'
import { ensureDb, nowIso } from '../../shared/db/connection'
import { userPermissions } from '../../shared/db/schema/index'

/**
 * 「按模块投影」的列表接口 + 实例标识选项接口。
 *
 * 这一组接口存在的理由是一次解耦：房间/世界/玩家三个列表页此前共用一份要求 `instance:read`
 * 的全量摘要，于是「能看房间」被迫等于「能看实例管理」，取消「查看实例」会连带收走一串菜单。
 * 现在每张投影只要求**本模块的读权限点**，并且只回这一页要用的字段。
 *
 * 因此这里盯三件事：
 *   1. 权限映射：房间投影只认 `room:read`、世界只认 `world:read`、玩家只认 `player:read`，
 *      互相之间不能越界；
 *   2. 可见范围仍然是过滤条件：没被授权的实例连"存在过"都不该出现；
 *   3. 标识接口只回 `instanceSummaryItemSchema` 那六个字段——安装路径与端口不能漏出去。
 */

interface ApiEnvelope<T> {
  status: 0 | 1
  error: string
  code: string
  data: T
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsh-summary-projection-'))
const dbFilePath = path.join(workDir, 'game-server-hub.sqlite')
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle')

const GRANTED_INSTANCE_ID = `inst-${randomUUID()}`
const HIDDEN_INSTANCE_ID = `inst-${randomUUID()}`

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

async function post<T>(url: string, authToken = token) {
  const response = await app.inject({
    method: 'POST',
    url,
    headers: authToken ? { token: authToken } : {},
    payload: {},
  })
  return parseBody<T>(response.body)
}

/** 成功 = status 1 且没有 error（业务失败同样是 status 1，不能只看 status） */
function isOk<T>(body: ApiEnvelope<T>): boolean {
  return body.status === 1 && body.error === ''
}

describe('DST 投影接口与实例标识选项', () => {
  before(async () => {
    await initDatabase(dbFilePath, migrationsFolder, {
      adminUsername: 'superadmin',
      adminPassword: '123456',
      seedDevelopmentUsers: false,
    })

    // 两个同游戏实例：一个授权给管理员，一个不授权——用来验证"可见范围是过滤条件"
    for (const [id, name] of [[GRANTED_INSTANCE_ID, '已授权实例'], [HIDDEN_INSTANCE_ID, '未授权实例']] as const) {
      const installPath = path.join(workDir, 'instances', id)
      fs.mkdirSync(installPath, { recursive: true })
      await createGameInstance({
        id,
        nodeId: 'local-node',
        name,
        gameCode: '343050',
        status: 'stopped',
        installPath,
      })
    }

    app = Fastify({ logger: false })
    registerAuthModule(app)
    registerInstanceModule(app)
    await app.ready()

    const login = await app.inject({
      method: 'POST',
      url: '/app/account/login',
      payload: { account: 'superadmin', password: '123456' },
    })
    const body = parseBody<{ token: string }>(login.body)
    assert.equal(body.status, 1, `登录失败：${login.body}`)
    token = body.data.token

    const admin = await findUserByAccount('superadmin')
    assert.ok(admin, '前置条件：管理员账号存在')
    userId = admin.id
    await addUserInstanceGrants(userId, [GRANTED_INSTANCE_ID], null)
  })

  after(async () => {
    await app.close()
    closeDatabase()
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  it('房间投影只认 room:read，且不越界到世界/玩家投影', async () => {
    await setPermissions(['room:read'])

    const room = await post<{ items: unknown[] }>('/app/instance/room-summaries')
    assert.equal(isOk(room), true, `room:read 应当能读房间投影：${JSON.stringify(room)}`)

    const world = await post('/app/instance/world-summaries')
    assert.equal(isOk(world), false, 'room:read 不该能读世界投影')
    assert.equal(world.code, ErrorCode.FORBIDDEN)

    const player = await post('/app/instance/player-summaries')
    assert.equal(isOk(player), false, 'room:read 不该能读玩家投影')
  })

  it('世界与玩家投影各自只认自己的读权限点', async () => {
    await setPermissions(['world:read'])
    assert.equal(isOk(await post('/app/instance/world-summaries')), true)
    assert.equal(isOk(await post('/app/instance/room-summaries')), false)
    assert.equal(isOk(await post('/app/instance/player-summaries')), false)

    await setPermissions(['player:read'])
    assert.equal(isOk(await post('/app/instance/player-summaries')), true)
    assert.equal(isOk(await post('/app/instance/room-summaries')), false)
    assert.equal(isOk(await post('/app/instance/world-summaries')), false)
  })

  it('可见范围是过滤条件：未授权实例不出现在任何投影里', async () => {
    await setPermissions(['room:read', 'world:read', 'player:read'])

    for (const url of ['/app/instance/room-summaries', '/app/instance/world-summaries', '/app/instance/player-summaries']) {
      const body = await post<{ items: Array<{ instance: { id: string } }> }>(url)
      assert.equal(isOk(body), true, `${url} 应当成功：${JSON.stringify(body)}`)
      const ids = body.data.items.map(item => item.instance.id)
      assert.deepEqual(ids, [GRANTED_INSTANCE_ID], `${url} 只该出现被授权的实例，实际：${ids.join('、')}`)
    }
  })

  it('实例标识选项：任一"能在界面上看到实例"的读权限点即可，且只回六个字段', async () => {
    for (const permission of ['mod:read', 'backup:read', 'schedule:read', 'member:read', 'instance:read']) {
      await setPermissions([permission])
      const body = await post<Array<Record<string, unknown>>>('/app/instance/options')
      assert.equal(isOk(body), true, `${permission} 应当能读实例标识选项：${JSON.stringify(body)}`)
      assert.equal(body.data.length, 1, '未授权实例不该出现在选项里')
      assert.deepEqual(
        Object.keys(body.data[0] ?? {}).sort(),
        ['gameCode', 'id', 'lastCommand', 'lastError', 'name', 'status'],
        '标识接口只有这六个字段：安装路径与端口不能在这里漏出去',
      )
    }
  })

  it('实例标识选项不认与"选实例"无关的读权限点', async () => {
    await setPermissions(['room:read'])
    const body = await post('/app/instance/options')
    assert.equal(isOk(body), false, '房间列表走房间投影，不需要也不该能读实例标识选项')
    assert.equal(body.code, ErrorCode.FORBIDDEN)
  })

  it('未登录时不放行', async () => {
    await setPermissions(['room:read'])
    const anonymous = await post('/app/instance/room-summaries', '')
    assert.equal(anonymous.status, 0, '未登录是 status:0')
    assert.ok(anonymous.error.length > 0)
  })
})
