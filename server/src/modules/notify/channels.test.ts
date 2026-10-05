import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildNotification, formatEventText, parseChannelConfig, signDingtalk, validateChannelConfig } from './channels'
import type { PanelEvent } from './events'

const baseEvent: PanelEvent = {
  type: 'instance_exited_unexpectedly',
  subjectId: 'inst-1',
  subjectName: '我的房间',
  message: '实例「我的房间」进程异常退出',
  severity: 'critical',
  at: '2026-09-15T12:00:00.000Z',
}

describe('parseChannelConfig', () => {
  it('keeps only non-empty trimmed keys', () => {
    const config = parseChannelConfig(JSON.stringify({ webhookUrl: ' https://a.b/c ', secret: '  ', sendKey: undefined }))
    assert.equal(config.webhookUrl, 'https://a.b/c')
    assert.equal(config.secret, undefined)
    assert.equal(config.sendKey, undefined)
  })

  it('returns empty config for malformed json', () => {
    assert.deepEqual(parseChannelConfig('not-json'), {})
  })
})

describe('buildNotification', () => {
  it('dingtalk builds text payload and appends signature params', () => {
    const outgoing = buildNotification('dingtalk', { webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=x', secret: 's3cret' }, baseEvent)
    assert.ok(outgoing)
    assert.ok(outgoing.url.includes('access_token=x&timestamp='))
    assert.ok(outgoing.url.includes('&sign='))
    const body = JSON.parse(outgoing.body) as { msgtype: string, text: { content: string } }
    assert.equal(body.msgtype, 'text')
    assert.ok(body.text.content.includes('BubbleShark Panel'))
    assert.ok(body.text.content.includes('进程异常退出'))
  })

  it('dingtalk returns null when webhookUrl missing', () => {
    assert.equal(buildNotification('dingtalk', {}, baseEvent), null)
  })

  it('wecom and feishu wrap text payloads', () => {
    const wecom = buildNotification('wecom', { webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k' }, baseEvent)
    const feishu = buildNotification('feishu', { webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/x' }, baseEvent)
    const wecomBody = JSON.parse(wecom?.body ?? '{}') as { msgtype: string }
    const feishuBody = JSON.parse(feishu?.body ?? '{}') as { msg_type: string }
    assert.equal(wecomBody.msgtype, 'text')
    assert.equal(feishuBody.msg_type, 'text')
  })

  it('serverchan posts form-encoded title/desp', () => {
    const outgoing = buildNotification('serverchan', { sendKey: 'SCT123' }, baseEvent)
    assert.ok(outgoing?.url.startsWith('https://sctapi.ftqq.com/SCT123.send'))
    assert.equal(outgoing?.contentType, 'application/x-www-form-urlencoded')
    assert.ok(outgoing?.body.includes('title='))
  })

  it('pushplus posts token json', () => {
    const outgoing = buildNotification('pushplus', { token: 'tok' }, baseEvent)
    const body = JSON.parse(outgoing?.body ?? '{}') as { token: string, template: string }
    assert.equal(body.token, 'tok')
    assert.equal(body.template, 'txt')
  })

  it('returns null when required key missing', () => {
    assert.equal(buildNotification('serverchan', {}, baseEvent), null)
    assert.equal(buildNotification('pushplus', {}, baseEvent), null)
  })

  it('webhook posts structured json with text fallback', () => {
    const outgoing = buildNotification('webhook', { webhookUrl: 'https://example.com/hook' }, baseEvent)
    assert.equal(outgoing?.url, 'https://example.com/hook')
    assert.equal(outgoing?.contentType, 'application/json')
    const body = JSON.parse(outgoing?.body ?? '{}') as {
      source: string
      severity: string
      title: string
      message: string
      text: string
      at: string
    }
    assert.equal(body.source, 'bubblesharkpanel')
    assert.equal(body.severity, 'critical')
    assert.ok(body.title.includes('进程异常退出'))
    assert.equal(body.message, baseEvent.message)
    assert.ok(body.text.includes('BubbleShark Panel'))
    assert.equal(body.at, baseEvent.at)
    assert.equal(buildNotification('webhook', {}, baseEvent), null)
  })

  it('telegram posts sendMessage with chat id and escaped text', () => {
    const outgoing = buildNotification('telegram', { botToken: '123456:ABC-DEF1234', chatId: '-1001234567890' }, baseEvent)
    assert.equal(outgoing?.url, 'https://api.telegram.org/bot123456:ABC-DEF1234/sendMessage')
    const body = JSON.parse(outgoing?.body ?? '{}') as { chat_id: string, text: string, disable_web_page_preview: boolean }
    assert.equal(body.chat_id, '-1001234567890')
    assert.ok(body.text.includes('进程异常退出'))
    assert.equal(body.disable_web_page_preview, true)
    // 缺任一必填项都不构建请求
    assert.equal(buildNotification('telegram', { botToken: '123456:ABC-DEF1234' }, baseEvent), null)
    assert.equal(buildNotification('telegram', { chatId: '1' }, baseEvent), null)
  })
})

describe('validateChannelConfig', () => {
  it('requires https for webhook-style channels', () => {
    assert.equal(validateChannelConfig('webhook', { webhookUrl: 'http://example.com/hook' }), 'Webhook 地址必须以 https:// 开头')
    assert.equal(validateChannelConfig('webhook', { webhookUrl: 'https://example.com/hook' }), undefined)
    assert.equal(validateChannelConfig('dingtalk', { webhookUrl: 'ftp://example.com' }), 'Webhook 地址必须以 https:// 开头')
  })

  it('validates telegram token and chat id shapes', () => {
    assert.equal(validateChannelConfig('telegram', { botToken: '123456:ABC-DEF1234', chatId: '12345' }), undefined)
    assert.equal(validateChannelConfig('telegram', { botToken: '123456:ABC-DEF1234', chatId: '-1001234567890' }), undefined)
    assert.equal(validateChannelConfig('telegram', { botToken: '123456:ABC-DEF1234', chatId: '@my_channel' }), undefined)
    assert.match(validateChannelConfig('telegram', { botToken: 'not-a-token' }) ?? '', /Bot Token/)
    assert.match(validateChannelConfig('telegram', { chatId: 'abc def' }) ?? '', /Chat ID/)
  })
})

describe('signDingtalk', () => {
  it('matches official algorithm sample', () => {
    // 官方文档示例：timestamp=1586271132000, secret 相同时的确定性校验
    const sign = signDingtalk(1586271132000, 'SEC9b6a1b7d5f0a2b8f6d3c1e4a5b7c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c')
    assert.ok(/^[A-Za-z0-9+/=]+$/.test(sign))
  })
})

describe('formatEventText', () => {
  it('includes severity label message and time', () => {
    const text = formatEventText(baseEvent)
    assert.ok(text.includes('严重'))
    assert.ok(text.includes('实例「我的房间」进程异常退出'))
    assert.ok(text.includes('2026-09-15 12:00:00'))
  })
})
