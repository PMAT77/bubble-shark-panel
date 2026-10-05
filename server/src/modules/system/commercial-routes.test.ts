import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { commercialSupportSchema } from '../../../../shared/contracts/commercial'
import { registerAuthModule } from '../auth/index'
import { registerSystemModule } from './index'
import { closeDatabase, initDatabase } from '../../shared/db/index'

/**
 * 「商业支持与 Pro」接口的测试。
 *
 * 这个接口本身只读，但它承载的是**对外承诺**：核心免费、Pro 未开发、
 * 付费服务卖的是人工。正因如此，测试要盯住三件事——
 * 鉴权（不能对未登录者泄露联系方式与授权状态）、
 * 文案纪律（不得出现暗示 Pro 可用的说法）、
 * 以及环境变量覆盖行为（个人联系方式可换，不改代码）。
 */

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-commercial-'))
const dbFilePath = path.join(workDir, 'bubblesharkpanel.sqlite')
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle')

process.env.DB_PATH = dbFilePath

interface ApiEnvelope<T> {
  status: 0 | 1
  error: string
  code: string
  data: T
}

let app: FastifyInstance
let token = ''

function parseBody<T>(body: string): ApiEnvelope<T> {
  return JSON.parse(body) as ApiEnvelope<T>
}

describe('commercial support routes', () => {
  before(async () => {
    await initDatabase(dbFilePath, migrationsFolder, {
      adminUsername: 'superadmin',
      adminPassword: '123456',
      seedDevelopmentUsers: false,
    })
    app = Fastify({ logger: false })
    registerAuthModule(app)
    registerSystemModule(app)
    await app.ready()
    const login = await app.inject({
      method: 'POST',
      url: '/app/account/login',
      payload: { account: 'superadmin', password: '123456' },
    })
    const body = parseBody<{ token: string }>(login.body)
    assert.equal(body.status, 1, `登录失败：${login.body}`)
    token = body.data.token
  })

  after(async () => {
    await app.close()
    closeDatabase()
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  it('未登录时拒绝，不泄露联系方式', async () => {
    const response = await app.inject({ method: 'GET', url: '/app/system/commercial' })
    const body = parseBody<unknown>(response.body)
    assert.equal(body.status, 0)
    assert.doesNotMatch(response.body, /PMAT77/)
  })

  it('登录后返回符合契约的结构化数据', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/app/system/commercial',
      headers: { token },
    })
    const body = parseBody<unknown>(response.body)
    assert.equal(body.status, 1, `接口应成功：${response.body}`)
    const parsed = commercialSupportSchema.safeParse(body.data)
    assert.equal(parsed.success, true, `响应不符合契约：${JSON.stringify(parsed.error?.issues)}`)
    const data = parsed.data!
    assert.equal(data.coreFree, true)
    // 未授权时 proLicensed 必须为 false，避免界面出现「已授权」的暗示
    assert.equal(data.proLicensed, false)
    // 状态文案要如实反映交付现状：插件能力已开发，但还没有随包发布的插件
    assert.match(data.proStatus, /准备中|仍在开发|尚未/, `Pro 状态文案必须说明真实交付状态，实际：${data.proStatus}`)
    assert.ok(data.services.length >= 4, '付费服务清单不应为空')
    assert.ok(data.proCapabilities.some(item => item.id === 'multi-node'), '多节点应在 Pro 能力清单里')
    assert.ok(data.exclusions.length >= 3, '不含项必须写清楚')
  })

  it('每个付费服务都有名称、交付内容与参考价，且价格带单位', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/app/system/commercial',
      headers: { token },
    })
    const data = parseBody<{ services: Array<{ id: string, name: string, detail: string, priceRange: string }> }>(response.body).data
    for (const service of data.services) {
      assert.ok(service.id.length > 0, '服务缺少 id')
      assert.ok(service.name.length > 0, `${service.id} 缺少名称`)
      assert.ok(service.detail.length > 0, `${service.id} 缺少交付内容说明`)
      assert.match(service.priceRange, /元/, `${service.id} 的参考价必须带金额与单位，实际：${service.priceRange}`)
    }
  })

  it('Pro 能力描述里不出现「现在可用 / 可以买」类措辞', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/app/system/commercial',
      headers: { token },
    })
    const data = parseBody<{ proCapabilities: Array<{ name: string, detail: string }>, proStatus: string }>(response.body).data
    const text = [data.proStatus, ...data.proCapabilities.map(item => `${item.name}${item.detail}`)].join(' ')
    for (const forbidden of ['已支持', '已上线', '立即购买', '点击升级', '现已开放', '可以购买', '已发布']) {
      assert.ok(!text.includes(forbidden), `Pro 文案出现暗示可用的措辞：${forbidden}`)
    }
    // 文案必须与交付现状一致：插件能力已开发，但没有随包发布 → 要能看出"还没交付到手上"
    assert.match(data.proStatus, /尚未|未开发|准备中|仍在开发/, `Pro 状态文案必须如实说明交付状态，实际：${data.proStatus}`)
  })

  it('对外文案里不出现 SLA 与值守类措辞', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/app/system/commercial',
      headers: { token },
    })
    const data = parseBody<{
      services: Array<{ name: string, detail: string, priceRange: string }>
      proCapabilities: Array<{ name: string, detail: string }>
      exclusions: string[]
      proStatus: string
      sponsorNote: string
    }>(response.body).data
    // 本来就没有承诺过响应时限，写出来只会让客户觉得话里有刺：口径纪律见报价单模板第三、四节
    const text = [
      data.proStatus,
      data.sponsorNote,
      ...data.exclusions,
      ...data.services.map(item => `${item.name}${item.detail}${item.priceRange}`),
      ...data.proCapabilities.map(item => `${item.name}${item.detail}`),
    ].join(' ')
    for (const forbidden of ['7×24', 'SLA', '值守', '即时响应']) {
      assert.ok(!text.includes(forbidden), `对外文案出现响应时限类措辞：${forbidden}`)
    }
  })

  it('联系方式可用环境变量覆盖，且不需要改代码', async () => {
    const original = process.env.BSP_COMMERCIAL_WECHAT
    process.env.BSP_COMMERCIAL_WECHAT = 'test-wechat-id'
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/app/system/commercial',
        headers: { token },
      })
      const data = parseBody<{ contact: { wechat: string } }>(response.body).data
      assert.equal(data.contact.wechat, 'test-wechat-id')
    }
    finally {
      if (original === undefined) {
        delete process.env.BSP_COMMERCIAL_WECHAT
      }
      else {
        process.env.BSP_COMMERCIAL_WECHAT = original
      }
    }
  })

  it('未设置环境变量时回落到仓库 README 里的默认联系方式', async () => {
    const original = process.env.BSP_COMMERCIAL_WECHAT
    delete process.env.BSP_COMMERCIAL_WECHAT
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/app/system/commercial',
        headers: { token },
      })
      const data = parseBody<{ contact: { wechat: string, repository: string } }>(response.body).data
      assert.equal(data.contact.wechat, 'PMAT77')
      assert.match(data.contact.repository, /github\.com\/PMAT77\/bubble-shark-panel/)
    }
    finally {
      if (original !== undefined) {
        process.env.BSP_COMMERCIAL_WECHAT = original
      }
    }
  })
})
