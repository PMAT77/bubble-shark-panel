import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { registerAuthModule } from './index'
import { createMember, listRoleItems } from '../system/rbac-service'
import { closeDatabase, findPermissionsByUserId, initDatabase } from '../../shared/db/index'
import { ensureDb } from '../../shared/db/connection'
import { roles, systemSettings, users } from '../../shared/db/schema/index'
import { ensureGuestAccount } from '../../shared/db/guest-account'
import { resolveGuestLoginEnabled, describeGuestLoginRejection, DEFAULT_GUEST_LOGIN_ACCOUNT } from '../../shared/config'

/**
 * 游客（只读预览）免密登录。
 *
 * 这是"点击游客登录直接进"的那条路：**前端没有、也不该有任何游客口令**。
 * 本文件钉住四件事：
 *
 * 1. 三道闸门（显式开开关 + Native + production）缺一不可——
 *    Docker 模式下一次有效登录等价于宿主机 root，绝不能在代码里放过；
 * 2. 开启后 `/app/account/guest-login` 能签出游客角色的会话，而**普通账号密码登录对它登不上**
 *    （口令是启动时随机生成、随即丢弃的值）；
 * 3. `/app/account/login-options` 只回开关与展示名，不含任何凭证；
 * 4. 游客账号名与管理员同名时视为未开启（否则游客会话会落到管理员账号名上）。
 */

interface ApiEnvelope<T> {
  status: 0 | 1
  error: string
  code: string
  data: T
}

const dbFilePath = path.join(os.tmpdir(), `bsp-guest-login-${randomUUID()}.sqlite`)
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle')

const GUEST_ACCOUNT = 'guest-preview'
const ADMIN_USERNAME = 'rootadmin'
const ADMIN_PASSWORD = 'Admin-Pass#2026'

let app: FastifyInstance
/** 面板预置的游客账号 userId（`before` 里记下，用例中途改过指针时要能改回来） */
let provisionedGuestUserId = ''

function parseBody<T>(body: string): ApiEnvelope<T> {
  return JSON.parse(body) as ApiEnvelope<T>
}

function db() {
  return ensureDb().drizzleDb
}

function applyEnv(overrides: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key]
    }
    else {
      process.env[key] = value
    }
  }
}

describe('游客（只读预览）免密登录', () => {
  const savedEnv: Record<string, string | undefined> = {}

  before(async () => {
    /**
     * 游客登录只在 Native + production 下生效，所以这里必须真的把环境摆成那样。
     * 顺带固定管理员账号：`adminUsername` 与游客账号名同名的用例要靠它做对照。
     */
    for (const key of ['NODE_ENV', 'BSP_RUNTIME_MODE', 'BSP_GUEST_LOGIN_ENABLED', 'BSP_GUEST_LOGIN_ACCOUNT', 'ADMIN_USERNAME', 'ADMIN_PASSWORD']) {
      savedEnv[key] = process.env[key]
    }
    applyEnv({
      NODE_ENV: 'production',
      BSP_RUNTIME_MODE: 'native',
      BSP_GUEST_LOGIN_ENABLED: '1',
      BSP_GUEST_LOGIN_ACCOUNT: GUEST_ACCOUNT,
      ADMIN_USERNAME,
      ADMIN_PASSWORD,
    })

    await initDatabase(dbFilePath, migrationsFolder, {
      adminUsername: ADMIN_USERNAME,
      adminPassword: ADMIN_PASSWORD,
      guestAccount: { enabled: true, account: GUEST_ACCOUNT },
    })

    app = Fastify({ logger: false })
    registerAuthModule(app)
    await app.ready()
  })

  after(async () => {
    await app.close()
    closeDatabase()
    applyEnv(savedEnv)
  })

  it('面板启动时预置了游客账号，并挂在内置游客角色上', async () => {
    const d = db()
    const accountRows = await d.select().from(users).where(eq(users.account, GUEST_ACCOUNT))
    assert.equal(accountRows.length, 1, '开启开关后必须自动建出游客账号')

    const guestRole = (await d.select().from(roles).where(eq(roles.key, 'guest')))[0]
    assert.ok(guestRole, '内置游客角色必须存在')

    const pointer = (await d.select().from(systemSettings).where(eq(systemSettings.key, 'guest.account')))[0]
    assert.equal(pointer?.value, accountRows[0]!.id, '游客账号指针必须落库：签发会话只认它，不认账号名')
    provisionedGuestUserId = accountRows[0]!.id
  })

  /**
   * 名称被别的账号占用时**不能接管**。
   *
   * `BSP_GUEST_LOGIN_ACCOUNT` 默认是 `guest`，运维手上很容易正好有一个同名账号。
   * 无条件接管会把它原本的角色与权限点整份改写成"只能看"，而且是在一次重启里静默发生的。
   * 正确行为是：什么都不做，让启动日志去告诉部署者改名字。
   */
  it('同名账号被非游客角色的账号占用时，不改写它，也不把它当游客账号', async () => {
    const d = db()
    const takenName = `taken-${randomUUID().slice(0, 8)}`
    const member = await createMember({
      account: takenName,
      password: 'Taken-Account#2026',
      roleId: (await listRoleItems()).find(role => role.key === 'system-admin')!.id,
    })
    assert.equal(member.ok, true, member.ok ? '' : member.message)
    if (!member.ok) {
      return
    }
    const before = await findPermissionsByUserId(member.data.userId)
    assert.ok(before.length > 0, '前提：这个账号本来是管理员角色')

    /**
     * 先清掉指针：本用例要验证的正是"库里还没有游客账号、只能按名字去找"的那条路。
     * 指针存在时会走另一条分支（直接用它指向的账号），名字冲突根本不会发生。
     * 现在指针已由 `before` 建好，所以这里按名字调用时只需把指针临时挪开。
     */
    await d.update(systemSettings).set({ value: '' }).where(eq(systemSettings.key, 'guest.account'))
    try {
      const outcome = await ensureGuestAccount({ enabled: true, account: takenName })
      assert.ok(outcome)
      assert.equal(outcome.ready, false, '名字被占时应当报告"未就绪"，而不是接管')
      assert.equal(outcome.created, false)

      const after = await findPermissionsByUserId(member.data.userId)
      assert.deepEqual(after.sort(), before.sort(), '别人的角色与权限点必须一个都没被改写')
    }
    finally {
      // 把指针修回来，后续用例（以及这个文件里的登出用例）仍然需要它
      await d.update(systemSettings).set({ value: provisionedGuestUserId }).where(eq(systemSettings.key, 'guest.account'))
    }
  })

  it('login-options 只回开关与展示名，不含任何凭证', async () => {
    const response = await app.inject({ method: 'GET', url: '/app/account/login-options' })
    const body = parseBody<{ guestLoginEnabled: boolean, guestAccountLabel: string }>(response.body)
    assert.equal(body.status, 1)
    assert.equal(body.data.guestLoginEnabled, true)
    assert.equal(body.data.guestAccountLabel, GUEST_ACCOUNT)
    assert.deepEqual(
      Object.keys(body.data).sort(),
      ['guestAccountLabel', 'guestLoginEnabled'],
      '这个接口只能回答"有没有入口"：多回任何字段都可能变成新的泄露面',
    )
  })

  it('guest-login 签出游客会话，且普通账号密码登录对它登不上', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/app/account/guest-login',
      payload: {},
    })
    const loginBody = parseBody<{ account: string, token: string, refreshToken: string, remember: boolean }>(login.body)
    assert.equal(loginBody.status, 1, `游客登录失败了：${loginBody.error}`)
    assert.equal(loginBody.data.account, GUEST_ACCOUNT)
    assert.ok(loginBody.data.token)
    assert.equal(loginBody.data.remember, false, '游客会话不落地"记住登录"')

    /**
     * 会话必须真的是游客角色——否则"只读预览"就只是名字好听。
     */
    const permission = await app.inject({
      method: 'GET',
      url: '/app/account/permission',
      headers: { token: loginBody.data.token },
    })
    const permissionBody = parseBody<{ roleKind: string | null, permissions: string[] }>(permission.body)
    assert.equal(permissionBody.data.roleKind, 'guest')
    assert.equal(
      permissionBody.data.permissions.some(item => item.endsWith(':write')),
      false,
      `游客权限集里出现了写权限点：${permissionBody.data.permissions.join('、')}`,
    )

    /**
     * 关键一条：**口令不可知**。游客账号的口令是启动时生成的随机值，
     * 令牌是从这里签出去的，而不是"前端拿着口令去换"。
     *
     * 断言口径按本项目的约定：登录失败是 **HTTP 200 + `status: 1` + 非空 `error`**
     * （`status: 0` 专指"未登录/登录失效"，不是"账号或密码错误"）。
     * 所以这里只钉"没有拿到 token 且给出了失败文案"。
     */
    for (const guess of ['guest', 'guest-preview', '123456', 'Guest-Preview']) {
      const passwordLogin = await app.inject({
        method: 'POST',
        url: '/app/account/login',
        payload: { account: GUEST_ACCOUNT, password: guess },
      })
      const guessed = parseBody<{ token?: string }>(passwordLogin.body)
      assert.ok(
        guessed.error.length > 0 && !guessed.data?.token,
        `游客账号不该能用口令「${guess}」登录，实际响应：${passwordLogin.body}`,
      )
    }
  })

  it('logout 之后游客会话失效', async () => {
    const login = await app.inject({ method: 'POST', url: '/app/account/guest-login', payload: {} })
    const { token, refreshToken } = parseBody<{ token: string, refreshToken: string }>(login.body).data

    const logout = await app.inject({
      method: 'POST',
      url: '/app/account/logout',
      headers: { token },
      payload: { refreshToken },
    })
    assert.equal(parseBody<{ isSuccess: boolean }>(logout.body).status, 1)

    const after = await app.inject({
      method: 'GET',
      url: '/app/account/permission',
      headers: { token },
    })
    assert.equal(parseBody<{ roleKind: string | null }>(after.body).status, 0, '登出后旧令牌必须失效')
  })

  /**
   * 成功签发也要有上限。
   *
   * 每次成功都会往 `auth_sessions` 写一行，而失败限流拦不住"每次都成功"的脚本——
   * 匿名入口可以被无限重复，只限失败等于给刷子开了正门。上限的取值与理由见
   * `GUEST_LOGIN_SESSION_LIMIT`。
   */
  it('同一 IP 的成功签发次数超限后被拒', async () => {
    // 同一个进程内共用一个 IP 维度，所以前面用例已经消耗掉一部分额度：
    // 一直点到被拒为止，再断言"拒绝之后仍然拒绝"。
    let rejected = false
    for (let attempt = 0; attempt < 40 && !rejected; attempt += 1) {
      const response = await app.inject({ method: 'POST', url: '/app/account/guest-login', payload: {} })
      const body = parseBody<{ token?: string }>(response.body)
      if (body.error.length > 0) {
        rejected = true
        assert.match(body.error, /过于频繁/, `拒绝文案要说清是频率问题，实际：${body.error}`)
        assert.ok(!body.data?.token, '被拒时不能签发任何会话')
      }
    }
    assert.equal(rejected, true, '连续签发必须有上限，否则匿名入口能无限往会话表里写行')
  })

  it('三道闸门：Docker 模式或非 production 一律不开放', () => {
    const base = { requested: true, account: 'guest', adminUsername: 'superadmin' } as const

    assert.equal(
      resolveGuestLoginEnabled({ ...base, runtimeMode: 'docker', mode: 'production' }),
      false,
      'Docker 模式下一次有效登录等价于宿主机 root，游客预览绝不能开放',
    )
    assert.equal(
      resolveGuestLoginEnabled({ ...base, runtimeMode: 'native', mode: 'development' }),
      false,
      '开发/测试环境不该凭空多出一个免密入口',
    )
    assert.equal(
      resolveGuestLoginEnabled({ ...base, runtimeMode: 'native', mode: 'production' }),
      true,
      'Native + production + 显式开开关才放行',
    )
    assert.equal(
      resolveGuestLoginEnabled({ ...base, runtimeMode: 'native', mode: 'production', requested: false }),
      false,
      '默认关闭：没显式开开关就是不开',
    )
    assert.equal(
      resolveGuestLoginEnabled({ ...base, runtimeMode: 'native', mode: 'production', account: 'superadmin' }),
      false,
      '游客账号名与管理员同名时视为未开启，否则游客会话会落到管理员账号名上',
    )
  })

  it('被拒绝时给出可读的原因，而不是静默失效', () => {
    assert.match(
      describeGuestLoginRejection({ requested: true, runtimeMode: 'docker', mode: 'production', account: 'guest', adminUsername: 'superadmin' }),
      /Docker/,
    )
    assert.match(
      describeGuestLoginRejection({ requested: true, runtimeMode: 'native', mode: 'development', account: 'guest', adminUsername: 'superadmin' }),
      /development/,
    )
    assert.match(
      describeGuestLoginRejection({ requested: true, runtimeMode: 'native', mode: 'production', account: 'superadmin', adminUsername: 'superadmin' }),
      /ADMIN_USERNAME/,
    )
    assert.equal(
      describeGuestLoginRejection({ requested: false, runtimeMode: 'docker', mode: 'production', account: 'guest', adminUsername: 'superadmin' }),
      '',
      '本来就没开的话不该报警',
    )
    assert.equal(DEFAULT_GUEST_LOGIN_ACCOUNT, 'guest')
  })
})
