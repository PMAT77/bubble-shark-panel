import { readBrandEnv } from '../../../../shared/brand-env'
import type { FastifyInstance } from 'fastify'
import { collectHostResourceSnapshot } from '../../shared/host-metrics'
import {
  getNotifyChannelById,
  getNotifySettings,
  listEnabledNotifyChannels,
  updateNotifyChannel,
} from '../../shared/db/index'
import type { DbNotifyChannel, DbNotifySettings } from '../../shared/db/index'
import { emitPanelEvent, subscribePanelEvent } from './events'
import type { PanelEvent } from './events'
import { buildNotification, parseChannelConfig, sendNotification } from './channels'

const THRESHOLD_CHECK_INTERVAL_MS = 60_000
/** 连续失败达到该次数后标记渠道 failing（熔断提示） */
const FAILING_THRESHOLD = 5

let serviceStarted = false
let thresholdTimer: NodeJS.Timeout | null = null
let unsubscribe: (() => void) | null = null

/** 冷却窗口：channelId:type:subjectId → 最近发送时间（内存即可，重启清零可接受） */
const cooldownMap = new Map<string, number>()
/** 连续失败计数（熔断用） */
const failureCounts = new Map<string, number>()

function isUnitTest(): boolean {
  return readBrandEnv('BSP_UNIT_TEST') === '1'
}

export function resetNotifyStateForTests(): void {
  cooldownMap.clear()
  failureCounts.clear()
}

export async function deliverToChannel(
  app: FastifyInstance,
  channel: DbNotifyChannel,
  event: PanelEvent,
  cooldownMinutes: number,
): Promise<boolean> {
  const cooldownKey = `${channel.id}:${event.type}:${event.subjectId}:${event.occurrenceKey ?? ''}`
  const lastSentAt = cooldownMap.get(cooldownKey) ?? 0
  const now = Date.now()
  if (now - lastSentAt < cooldownMinutes * 60_000) {
    return false
  }
  // 先占冷却位再发送：失败也不在窗口内重复轰炸
  cooldownMap.set(cooldownKey, now)

  try {
    const config = parseChannelConfig(channel.config)
    const outgoing = buildNotification(channel.type, config, event)
    if (!outgoing) {
      app.log.warn({ channelId: channel.id, type: channel.type }, '通知渠道配置不完整，无法发送')
      return false
    }
    await sendNotification(outgoing)
    failureCounts.delete(channel.id)
    if (channel.healthStatus !== 'healthy') {
      await updateNotifyChannel(channel.id, { healthStatus: 'healthy', lastErrorAt: null, lastErrorMessage: null })
    }
    return true
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const count = (failureCounts.get(channel.id) ?? 0) + 1
    failureCounts.set(channel.id, count)
    if (count >= FAILING_THRESHOLD || channel.healthStatus === 'failing') {
      await updateNotifyChannel(channel.id, {
        healthStatus: 'failing',
        lastErrorAt: new Date().toISOString(),
        lastErrorMessage: message,
      })
    }
    app.log.warn({ channelId: channel.id, type: channel.type, error: message, failCount: count }, '通知发送失败')
    return false
  }
}

export async function dispatchToChannels(app: FastifyInstance, event: PanelEvent): Promise<void> {
  const settings = await getNotifySettings()
  if (!settings.enabled) {
    return
  }
  const channels = await listEnabledNotifyChannels()
  await Promise.all(channels.map(channel => deliverToChannel(app, channel, event, settings.cooldownMinutes)))
}

/** 阈值告警：主机 CPU/内存/磁盘超过设置阈值时发布事件（冷却由 deliver 统一处理） */
export async function checkThresholds(): Promise<void> {
  const settings = await getNotifySettings()
  if (!settings.enabled) {
    return
  }
  const snapshot = collectHostResourceSnapshot()
  const metrics: { metric: 'cpu' | 'mem' | 'disk', label: string, value: number, threshold: number }[] = [
    { metric: 'cpu', label: 'CPU', value: snapshot.cpu.usageRate, threshold: settings.thresholds.cpuPercent },
    { metric: 'mem', label: '内存', value: snapshot.memory.usageRate, threshold: settings.thresholds.memPercent },
    { metric: 'disk', label: '磁盘', value: snapshot.disk.usageRate, threshold: settings.thresholds.diskPercent },
  ]
  for (const item of metrics) {
    if (item.value < item.threshold) {
      continue
    }
    emitPanelEvent({
      type: 'resource_threshold',
      subjectId: `host-${item.metric}`,
      subjectName: '主机',
      message: `主机 ${item.label} 使用率 ${item.value.toFixed(1)}% 已超过告警阈值 ${item.threshold}%`,
      severity: 'warning',
      at: new Date().toISOString(),
    })
  }
}

export function startNotifyService(app: FastifyInstance): void {
  if (serviceStarted || isUnitTest()) {
    return
  }
  serviceStarted = true
  unsubscribe = subscribePanelEvent((event) => {
    void dispatchToChannels(app, event).catch(error => app.log.error({ err: error }, '通知分发失败'))
  })
  thresholdTimer = setInterval(() => {
    void checkThresholds().catch(error => app.log.error({ err: error }, '阈值告警检查失败'))
  }, THRESHOLD_CHECK_INTERVAL_MS)
  if (typeof thresholdTimer === 'object' && 'unref' in thresholdTimer && typeof thresholdTimer.unref === 'function') {
    thresholdTimer.unref()
  }
  app.log.info('通知服务已启动')
}

export function stopNotifyService(): void {
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
  if (thresholdTimer) {
    clearInterval(thresholdTimer)
    thresholdTimer = null
  }
  serviceStarted = false
}

/** 渠道测试消息：绕过事件总线与冷却，直接发送 */
export async function sendTestNotification(app: FastifyInstance, channelId: string): Promise<void> {
  const channel = await getNotifyChannelById(channelId)
  if (!channel) {
    throw new Error('通知渠道不存在')
  }
  const config = parseChannelConfig(channel.config)
  const testEvent: PanelEvent = {
    type: 'backup_completed',
    subjectId: 'notify-test',
    subjectName: channel.name,
    message: `这是一条「${channel.name}」的测试通知`,
    severity: 'info',
    at: new Date().toISOString(),
  }
  const outgoing = buildNotification(channel.type, config, testEvent)
  if (!outgoing) {
    throw new Error('渠道配置不完整，请先补全必填配置')
  }
  await sendNotification(outgoing)
  failureCounts.delete(channel.id)
  if (channel.healthStatus !== 'healthy') {
    await updateNotifyChannel(channel.id, { healthStatus: 'healthy', lastErrorAt: null, lastErrorMessage: null })
  }
  app.log.info({ channelId }, '通知测试消息已发送')
}

export type { DbNotifySettings }
