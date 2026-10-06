import { createHmac } from 'node:crypto'
import type { DbNotifyChannelType } from '../../shared/db/index'
import type { PanelEvent } from './events'

export interface NotifyChannelConfig {
  webhookUrl?: string
  /** 钉钉加签密钥 */
  secret?: string
  /** Server酱 SendKey */
  sendKey?: string
  /** PushPlus token */
  token?: string
  /** Telegram Bot Token（@BotFather 提供，形如 123456:ABC-DEF...） */
  botToken?: string
  /** Telegram 接收方：用户会话 ID、群组 ID（负数）或 @频道用户名 */
  chatId?: string
}

export interface OutgoingNotification {
  url: string
  headers: Record<string, string>
  body: string
  contentType: 'application/json' | 'application/x-www-form-urlencoded'
}

export function parseChannelConfig(configJson: string): NotifyChannelConfig {
  try {
    const raw = JSON.parse(configJson) as Partial<NotifyChannelConfig>
    const config: NotifyChannelConfig = {}
    if (typeof raw.webhookUrl === 'string' && raw.webhookUrl.trim()) {
      config.webhookUrl = raw.webhookUrl.trim()
    }
    if (typeof raw.secret === 'string' && raw.secret.trim()) {
      config.secret = raw.secret.trim()
    }
    if (typeof raw.sendKey === 'string' && raw.sendKey.trim()) {
      config.sendKey = raw.sendKey.trim()
    }
    if (typeof raw.token === 'string' && raw.token.trim()) {
      config.token = raw.token.trim()
    }
    if (typeof raw.botToken === 'string' && raw.botToken.trim()) {
      config.botToken = raw.botToken.trim()
    }
    if (typeof raw.chatId === 'string' && raw.chatId.trim()) {
      config.chatId = raw.chatId.trim()
    }
    return config
  }
  catch {
    return {}
  }
}

export function listConfiguredKeys(configJson: string): string[] {
  const config = parseChannelConfig(configJson)
  return Object.entries(config).filter(([, value]) => Boolean(value)).map(([key]) => key)
}

const SEVERITY_LABEL: Record<PanelEvent['severity'], string> = {
  info: '提示',
  warning: '警告',
  critical: '严重',
}

export function formatEventText(event: PanelEvent): string {
  return `[BubbleSharkPanel] ${SEVERITY_LABEL[event.severity]}\n${event.message}\n时间：${event.at.replace('T', ' ').slice(0, 19)}`
}

export function formatEventTitle(event: PanelEvent): string {
  return `[BubbleSharkPanel] ${SEVERITY_LABEL[event.severity]}：${event.message}`
}

/** 钉钉加签算法（官方文档）：HMAC-SHA256(secret, timestamp + '\n' + secret) 的 Base64 */
export function signDingtalk(timestamp: number, secret: string): string {
  return createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64')
}

function appendQuery(url: string, key: string, value: string): string {
  return url.includes('?') ? `${url}&${key}=${value}` : `${url}?${key}=${value}`
}

/**
 * 按渠道类型构建外发请求。配置不完整时返回 null（由调用方告警）。
 * 纯函数：单测直接校验 payload 结构。
 */
export function buildNotification(type: DbNotifyChannelType, config: NotifyChannelConfig, event: PanelEvent): OutgoingNotification | null {
  const text = formatEventText(event)
  switch (type) {
    case 'dingtalk': {
      if (!config.webhookUrl) {
        return null
      }
      let url = config.webhookUrl
      if (config.secret) {
        const timestamp = Date.now()
        url = appendQuery(url, 'timestamp', String(timestamp))
        url = appendQuery(url, 'sign', encodeURIComponent(signDingtalk(timestamp, config.secret)))
      }
      return {
        url,
        headers: {},
        body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
        contentType: 'application/json',
      }
    }
    case 'wecom': {
      if (!config.webhookUrl) {
        return null
      }
      return {
        url: config.webhookUrl,
        headers: {},
        body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
        contentType: 'application/json',
      }
    }
    case 'feishu': {
      if (!config.webhookUrl) {
        return null
      }
      return {
        url: config.webhookUrl,
        headers: {},
        body: JSON.stringify({ msg_type: 'text', content: { text } }),
        contentType: 'application/json',
      }
    }
    case 'serverchan': {
      if (!config.sendKey) {
        return null
      }
      const params = new URLSearchParams()
      params.set('title', formatEventTitle(event))
      params.set('desp', text)
      return {
        url: `https://sctapi.ftqq.com/${encodeURIComponent(config.sendKey)}.send`,
        headers: {},
        body: params.toString(),
        contentType: 'application/x-www-form-urlencoded',
      }
    }
    case 'pushplus': {
      if (!config.token) {
        return null
      }
      return {
        url: 'https://www.pushplus.plus/send',
        headers: {},
        body: JSON.stringify({ token: config.token, title: formatEventTitle(event), content: text, template: 'txt' }),
        contentType: 'application/json',
      }
    }
    case 'webhook': {
      if (!config.webhookUrl) {
        return null
      }
      // 通用 Webhook：结构化字段 + 已排版文本，接收方按需取用
      return {
        url: config.webhookUrl,
        headers: {},
        body: JSON.stringify({
          source: 'bubblesharkpanel',
          severity: event.severity,
          title: formatEventTitle(event),
          message: event.message,
          text,
          at: event.at,
        }),
        contentType: 'application/json',
      }
    }
    case 'telegram': {
      if (!config.botToken || !config.chatId) {
        return null
      }
      return {
        url: `https://api.telegram.org/bot${config.botToken}/sendMessage`,
        headers: {},
        body: JSON.stringify({
          chat_id: config.chatId,
          text,
          disable_web_page_preview: true,
        }),
        contentType: 'application/json',
      }
    }
    default:
      return null
  }
}

/**
 * 配置格式校验：在保存渠道时就挡住必然发不出去的配置，
 * 而不是等到事件触发时才发现渠道一直是失败的。
 */
export function validateChannelConfig(type: DbNotifyChannelType, config: NotifyChannelConfig): string | undefined {
  if (config.webhookUrl && !config.webhookUrl.startsWith('https://')) {
    return 'Webhook 地址必须以 https:// 开头'
  }
  if (type === 'telegram') {
    if (config.botToken && !/^\d+:[A-Za-z0-9_-]{10,}$/.test(config.botToken)) {
      return 'Bot Token 形如 123456:ABC-DEF...，请从 @BotFather 获取'
    }
    if (config.chatId && !/^(-?\d+|@[A-Za-z0-9_]{5,32})$/.test(config.chatId)) {
      return 'Chat ID 须为数字（群组为负数）或 @频道用户名'
    }
  }
  return undefined
}

export async function sendNotification(outgoing: OutgoingNotification): Promise<void> {
  const response = await fetch(outgoing.url, {
    method: 'POST',
    headers: {
      'Content-Type': outgoing.contentType,
      ...outgoing.headers,
    },
    body: outgoing.body,
    signal: AbortSignal.timeout(15_000),
  })
  await response.body?.cancel()
  if (!response.ok) {
    throw new Error(`通知服务返回 HTTP ${response.status}`)
  }
}
