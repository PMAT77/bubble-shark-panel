import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { NOTIFY_CHANNEL_TYPES } from '../../../../shared/contracts/notify'
import {
  closeDatabase,
  createNotifyChannel,
  getNotifyChannelById,
  initDatabase,
  listNotifyChannels,
} from './index'
import { deliverToChannel, resetNotifyStateForTests } from '../../modules/notify/notify-service'
import type { PanelEvent } from '../../modules/notify/events'

/**
 * 渠道类型的数据库往返回归。
 *
 * 背景：仓储层曾自写一份只含五种类型的列表，Telegram 与通用 Webhook 落库后每次
 * 读出都被改写成钉钉 —— 界面显示正常、配置校验却按钉钉必填项走，最终永远发不出
 * 消息。缺陷能穿过既有的纯函数测试，是因为没有测试把渠道类型过一遍数据库写入与
 * 读出，这里补上的正是这一段。
 */

const dbFilePath = path.join(os.tmpdir(), `bsp-notify-repo-test-${randomUUID()}.sqlite`)
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

/** 各类型的合法最小配置，只用于验证类型能原样往返 */
const MINIMAL_CONFIG: Record<string, Record<string, string>> = {
  dingtalk: { webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=x' },
  wecom: { webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k' },
  feishu: { webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/x' },
  serverchan: { sendKey: 'SCT123' },
  pushplus: { token: 'tok' },
  webhook: { webhookUrl: 'https://example.com/hook' },
  telegram: { botToken: '123456:ABC-DEF', chatId: '1' },
}

describe('notify repository channel types', () => {
  before(async () => {
    await initDatabase(dbFilePath, migrationsFolder)
  })

  after(() => {
    closeDatabase()
  })

  it('七种渠道类型经数据库往返后保持不变', async () => {
    for (const type of NOTIFY_CHANNEL_TYPES) {
      const created = await createNotifyChannel({
        id: `nc-${randomUUID()}`,
        type,
        name: `渠道-${type}`,
        config: JSON.stringify(MINIMAL_CONFIG[type]),
      })
      assert.equal(created.type, type)
      const loaded = await getNotifyChannelById(created.id)
      assert.equal(loaded?.type, type, `${type} 落库后再读出不应被改写`)
    }

    const listed = await listNotifyChannels()
    assert.deepEqual(
      [...new Set(listed.map(channel => channel.type))].sort(),
      [...NOTIFY_CHANNEL_TYPES].sort(),
      '列表接口返回的类型集合应与契约一致',
    )
  })

  it('契约之外的历史类型读出时回退为钉钉', async () => {
    const created = await createNotifyChannel({
      id: `nc-${randomUUID()}`,
      // 模拟早期版本写入的脏数据：绕过类型约束直接落库
      type: 'legacy_channel' as never,
      name: '历史脏数据',
      config: '{}',
    })
    assert.equal(created.type, 'dingtalk', '未知类型读出应回退为钉钉而不是让界面拿到空类型')
  })

  it('Telegram 与通用 Webhook 渠道经数据库往返后能真正发出请求', async () => {
    const calls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input))
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    try {
      resetNotifyStateForTests()
      for (const type of ['telegram', 'webhook'] as const) {
        const created = await createNotifyChannel({
          id: `nc-${randomUUID()}`,
          type,
          name: `投递-${type}`,
          config: JSON.stringify(MINIMAL_CONFIG[type]),
        })
        const loaded = await getNotifyChannelById(created.id)
        const sent = await deliverToChannel(stubApp, loaded!, { ...event, subjectId: `inst-${type}` }, 0)
        assert.equal(sent, true, `${type} 渠道应能完成投递`)
      }

      assert.equal(calls.length, 2, '两个渠道各应产生一次请求')
      assert.match(calls[0] ?? '', /api\.telegram\.org/, 'Telegram 应打到 telegram API')
      assert.equal(calls[1], 'https://example.com/hook', '通用 Webhook 应打到配置的地址')
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })
})
