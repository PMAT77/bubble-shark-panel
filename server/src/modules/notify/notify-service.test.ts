import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  closeDatabase,
  createNotifyChannel,
  getNotifyChannelById,
  initDatabase,
} from '../../shared/db/index'
import type { DbNotifyChannel } from '../../shared/db/index'
import { deliverToChannel, resetNotifyStateForTests } from './notify-service'
import type { PanelEvent } from './events'

const dbFilePath = path.join(os.tmpdir(), `bsp-notify-test-${randomUUID()}.sqlite`)
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle')

const stubApp = {
  log: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
} as never

const event: PanelEvent = {
  type: 'backup_completed',
  subjectId: 'inst-1',
  subjectName: '测试实例',
  message: '备份完成',
  severity: 'info',
  at: new Date().toISOString(),
}

interface FetchCall {
  url: string
  body: string
}

let fetchCalls: FetchCall[] = []
const originalFetch = globalThis.fetch

function installFetchStub(behavior: 'ok' | 'fail'): void {
  fetchCalls = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (behavior === 'fail') {
      throw new Error('ECONNREFUSED')
    }
    fetchCalls.push({ url: String(input), body: '' })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
}


describe('notify service delivery', () => {
  let channel: DbNotifyChannel

  before(async () => {
    await initDatabase(dbFilePath, migrationsFolder)
    channel = await createNotifyChannel({
      id: `nc-${randomUUID()}`,
      type: 'wecom',
      name: '测试群机器人',
      config: JSON.stringify({ webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test' }),
    })
  })

  after(() => {
    globalThis.fetch = originalFetch
    closeDatabase()
  })

  it('delivers event through enabled channel (fetch called)', async () => {
    installFetchStub('ok')
    resetNotifyStateForTests()
    const sent = await deliverToChannel(stubApp, channel, event, 15)
    assert.equal(sent, true)
    assert.equal(fetchCalls.length, 1)
  })

  it('suppresses duplicate event within cooldown window (冷却窗口)', async () => {
    installFetchStub('ok')
    resetNotifyStateForTests()
    await deliverToChannel(stubApp, channel, event, 15)
    const sentAgain = await deliverToChannel(stubApp, channel, event, 15)
    assert.equal(sentAgain, false)
    assert.equal(fetchCalls.length, 1, 'second send inside cooldown must not hit the wire')
  })

  it('different subject bypasses cooldown (不同实例互不影响)', async () => {
    installFetchStub('ok')
    resetNotifyStateForTests()
    await deliverToChannel(stubApp, channel, event, 15)
    const other = { ...event, subjectId: 'inst-2' }
    const sent = await deliverToChannel(stubApp, channel, other, 15)
    assert.equal(sent, true)
  })
  it('distinct protection epochs notify once each while duplicate occurrence stays suppressed', async () => {
    installFetchStub('ok')
    resetNotifyStateForTests()
    const first = { ...event, occurrenceKey: 'memory:round-1' }
    assert.equal(await deliverToChannel(stubApp, channel, first, 15), true)
    assert.equal(await deliverToChannel(stubApp, channel, first, 15), false)
    assert.equal(await deliverToChannel(stubApp, channel, { ...event, occurrenceKey: 'memory:round-2' }, 15), true)
    assert.equal(fetchCalls.length, 2)
  })

  it('marks channel failing after repeated send failures (熔断)', async () => {
    installFetchStub('fail')
    resetNotifyStateForTests()
    for (let i = 0; i < 5; i++) {
      // 冷却窗口置 0 使每次都能尝试发送
      await deliverToChannel(stubApp, channel, { ...event, at: new Date(Date.now() + i).toISOString() }, 0)
    }
    const updated = await getNotifyChannelById(channel.id)
    assert.equal(updated?.healthStatus, 'failing')
    assert.ok(updated?.lastErrorMessage?.includes('ECONNREFUSED'))
  })

  it('recovers health after a successful send (自愈)', async () => {
    installFetchStub('ok')
    const current = await getNotifyChannelById(channel.id)
    // 与生产一致：分发前从 DB 读取最新渠道状态（上一轮熔断已置 failing）
    await deliverToChannel(stubApp, current!, event, 0)
    const updated = await getNotifyChannelById(channel.id)
    assert.equal(updated?.healthStatus, 'healthy')
    assert.equal(updated?.lastErrorMessage, null)
  })
})
