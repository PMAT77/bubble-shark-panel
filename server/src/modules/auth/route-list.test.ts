import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { and, eq, ne } from 'drizzle-orm'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { ALL_PERMISSIONS } from '../../../../shared/constants/permissions'
import { registerAuthModule } from './index'
import { closeDatabase, initDatabase } from '../../shared/db/index'
import { ensureDb } from '../../shared/db/connection'
import { userPermissions, users } from '../../shared/db/schema/index'
import { menuRouteList } from '../../shared/menu-routes'

/**
 * `/app/route/list` 的行为。
 *
 * 这个接口比它看起来重要：本项目 `routeBaseOn: 'backend'`，前端路由**完全由它的返回值生成**，
 * 所以「按权限过滤」这一件事同时决定了侧边栏入口与「哪些页面连路由都不存在」。
 *
 * 它此前既不校验登录、也不过滤——匿名请求就能拿到整张功能地图（含每项需要的权限点），
 * 而无权页面照样可达。以下三条把这个缺口钉住。
 */

interface ApiEnvelope<T> {
  status: 0 | 1
  error: string
  code: string
  data: T
}

interface MenuModule {
  meta: { title: string }
  children?: MenuModule[]
}

const dbFilePath = path.join(os.tmpdir(), `gsh-route-list-test-${randomUUID()}.sqlite`)
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle')

let app: FastifyInstance
let token = ''

function parseBody<T>(body: string): ApiEnvelope<T> {
  return JSON.parse(body) as ApiEnvelope<T>
}

async function fetchMenu(authToken: string): Promise<ApiEnvelope<MenuModule[]>> {
  const response = await app.inject({
    method: 'GET',
    url: '/app/route/list',
    headers: { token: authToken },
  })
  return parseBody<MenuModule[]>(response.body)
}

describe('菜单接口 /app/route/list', () => {
  before(async () => {
    await initDatabase(dbFilePath, migrationsFolder)
    app = Fastify({ logger: false })
    registerAuthModule(app)
    await app.ready()

    const login = await app.inject({
      method: 'POST',
      url: '/app/account/login',
      payload: { account: 'superadmin', password: '123456' },
    })
    token = parseBody<{ token: string }>(login.body).data.token
  })

  after(async () => {
    await app.close()
    closeDatabase()
  })

  it('未登录时不返回菜单', async () => {
    const response = await app.inject({ method: 'GET', url: '/app/route/list' })
    const body = parseBody<MenuModule[]>(response.body)
    assert.equal(body.status, 0, '匿名请求不该拿到菜单：它等于把整张功能地图连同权限点一起交出去')
    assert.ok(!Array.isArray(body.data), '响应体里不该出现任何菜单项')
  })

  it('令牌无效时同样不返回菜单', async () => {
    const body = await fetchMenu('not-a-real-token')
    assert.equal(body.status, 0)
  })

  it('管理员拿到完整菜单', async () => {
    const body = await fetchMenu(token)
    assert.equal(body.status, 1)
    assert.deepEqual(
      body.data.map(module => module.meta.title),
      menuRouteList.map(module => module.meta.title),
      '拥有全部权限点的账号应当看到与定义一致的模块列表',
    )
  })

  it('权限被裁剪后，菜单只剩对应模块', async () => {
    const { drizzleDb } = ensureDb()
    const adminRows = await drizzleDb.select().from(users).where(eq(users.account, 'superadmin'))
    const admin = adminRows[0]!
    assert.equal(
      (await drizzleDb.select().from(userPermissions).where(eq(userPermissions.userId, admin.id))).length,
      ALL_PERMISSIONS.length,
      '前置条件：管理员初始应当持有全部权限点',
    )

    // 只留房间权限，其余删掉；这模拟的就是「子账号只被分到改房间配置的能力」
    await drizzleDb.delete(userPermissions).where(and(
      eq(userPermissions.userId, admin.id),
      ne(userPermissions.permission, 'room:read'),
    ))

    const body = await fetchMenu(token)
    assert.deepEqual(
      body.data.map(module => module.meta.title),
      ['房间管理'],
      '只给 room:read 时，其余模块连入口都不该出现（前端据此不会注册那些路由）',
    )
    const roomPages = (body.data[0]?.children ?? [])
      .flatMap(child => child.children ?? [])
      .map(page => page.meta.title)
    // 不比较排序后的数组：中文标题的排序没有稳定直觉，这里只关心"是哪两个"
    assert.equal(roomPages.length, 2, `房间模块下应当有 2 个页面，实际：${roomPages.join('、')}`)
    assert.ok(roomPages.includes('房间管理'), '房间管理页依赖 room:read，应当在')
    assert.ok(roomPages.includes('房间设置'), '房间设置页依赖 room:read，应当在')
  })

  it('权限被全部清空时返回空菜单，而不是报错', async () => {
    const { drizzleDb } = ensureDb()
    const adminRows = await drizzleDb.select().from(users).where(eq(users.account, 'superadmin'))
    await drizzleDb.delete(userPermissions).where(eq(userPermissions.userId, adminRows[0]!.id))

    const body = await fetchMenu(token)
    assert.equal(body.status, 1, '无权限不是错误，是一个合法的空结果')
    assert.deepEqual(body.data, [], '没有任何权限点的账号应当拿到空菜单')
  })
})
