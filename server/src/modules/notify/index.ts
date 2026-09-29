import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ApiErrorResponse, ApiSuccessResponse } from '../../../../shared/contracts/api'
import type {
  NotifyChannelItem,
  NotifyMutationResult,
  NotifySettings,
  NotifyTestResult,
} from '../../../../shared/contracts/notify'
import {
  notifyChannelCreateRequestSchema,
  notifyChannelIdRequestSchema,
  notifyChannelUpdateRequestSchema,
  notifySettingsSaveRequestSchema,
} from '../../../../shared/contracts/notify'
import {
  createNotifyChannel,
  deleteNotifyChannel,
  getNotifyChannelById,
  getNotifySettings,
  newNotifyChannelId,
  saveNotifySettings,
  updateNotifyChannel,
} from '../../shared/db/index'
import type { DbNotifyChannelType, DbNotifySettings } from '../../shared/db/index'
import { businessError, success } from '../../shared/http/response'
import { resolveAuthorizedContext } from '../system/auth'
import { listConfiguredKeys, parseChannelConfig, validateChannelConfig } from './channels'
import type { NotifyChannelConfig } from './channels'
import { sendTestNotification } from './notify-service'
import { startNotifyService } from './notify-service'

const REQUIRED_CONFIG_KEYS: Record<DbNotifyChannelType, string[]> = {
  dingtalk: ['webhookUrl'],
  wecom: ['webhookUrl'],
  feishu: ['webhookUrl'],
  serverchan: ['sendKey'],
  pushplus: ['token'],
  webhook: ['webhookUrl'],
  telegram: ['botToken', 'chatId'],
}

function maskPreview(configJson: string): NotifyChannelItem['configPreview'] {
  const configured = new Set(listConfiguredKeys(configJson))
  return (['webhookUrl', 'secret', 'sendKey', 'token', 'botToken', 'chatId'] as const).map(key => ({
    key,
    configured: configured.has(key),
  }))
}

/**
 * 通知渠道与阈值的读写鉴权。
 *
 * **读接口必须只要求 `settings:read`**：通知渠道是系统设置页里的一个 tab，
 * 只读账号（游客角色）能进系统设置页，若列表/读取也要求 `settings:write`，
 * 这个 tab 一打开就是 403，与"只读账号能看所有页面"的定位冲突。
 *
 * 渠道列表只回显"哪些字段已配置"（`maskPreview`），不回显任何凭据值，读权限足够安全。
 */
async function authorize(request: FastifyRequest, permission: 'settings:read' | 'settings:write'): Promise<ApiErrorResponse | undefined> {
  const auth = await resolveAuthorizedContext(request, { permissions: permission })
  if (auth.error || !auth.context) {
    return auth.error ?? businessError('登录状态失效，请重新登录', request)
  }
  return undefined
}

/**
 * notify 模块：通知渠道管理（增删改查/测试）与阈值设置。
 * 事件订阅与冷却熔断在 notify-service，随模块注册启动。
 */
export function registerNotifyModule(app: FastifyInstance) {
  app.post('/app/notify/channel/list', async (request): Promise<ApiSuccessResponse<NotifyChannelItem[]> | ApiErrorResponse> => {
    const authError = await authorize(request, 'settings:read')
    if (authError) {
      return authError
    }
    const channels = await import('../../shared/db/index').then(m => m.listNotifyChannels())
    return success(channels.map(channel => ({
      id: channel.id,
      type: channel.type,
      name: channel.name,
      enabled: channel.enabled,
      healthStatus: channel.healthStatus,
      lastErrorAt: channel.lastErrorAt,
      lastErrorMessage: channel.lastErrorMessage,
      createdAt: channel.createdAt,
      configPreview: maskPreview(channel.config),
    })), request)
  })

  app.post('/app/notify/channel/create', async (request): Promise<ApiSuccessResponse<NotifyMutationResult> | ApiErrorResponse> => {
    const authError = await authorize(request, 'settings:write')
    if (authError) {
      return authError
    }
    const body = notifyChannelCreateRequestSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const { type, name, config } = body.data
    const requiredKeys = REQUIRED_CONFIG_KEYS[type]
    const missing = requiredKeys.filter((key) => {
      const value = (config as Record<string, string | undefined>)[key]
      return !value?.trim()
    })
    if (missing.length > 0) {
      return businessError(`缺少必填配置：${missing.join(', ')}`, request)
    }
    const configError = validateChannelConfig(type, config)
    if (configError) {
      return businessError(configError, request)
    }
    const channel = await createNotifyChannel({
      id: newNotifyChannelId(),
      type,
      name,
      config: JSON.stringify(config),
    })
    app.log.info({ channelId: channel.id, type }, '通知渠道已创建')
    return success({ isSuccess: true, channelId: channel.id }, request)
  })

  app.post('/app/notify/channel/update', async (request): Promise<ApiSuccessResponse<NotifyMutationResult> | ApiErrorResponse> => {
    const authError = await authorize(request, 'settings:write')
    if (authError) {
      return authError
    }
    const body = notifyChannelUpdateRequestSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const channel = await getNotifyChannelById(body.data.channelId)
    if (!channel) {
      return businessError('通知渠道不存在', request)
    }

    // 配置合并：未提供的键保留原值；显式空字符串清除该键
    const merged = parseChannelConfig(channel.config) as Record<string, string | undefined>
    if (body.data.config) {
      for (const [key, value] of Object.entries(body.data.config)) {
        if (value === undefined) {
          continue
        }
        if (value === '') {
          delete merged[key]
        }
        else {
          merged[key] = value
        }
      }
    }
    if (typeof merged.webhookUrl === 'string' && !merged.webhookUrl.startsWith('https://')) {
      return businessError('Webhook 地址必须以 https:// 开头', request)
    }
    const requiredKeys = REQUIRED_CONFIG_KEYS[channel.type]
    const missing = requiredKeys.filter(key => !merged[key]?.trim())
    if (missing.length > 0) {
      return businessError(`缺少必填配置：${missing.join(', ')}`, request)
    }
    const mergedConfigError = validateChannelConfig(channel.type, merged as NotifyChannelConfig)
    if (mergedConfigError) {
      return businessError(mergedConfigError, request)
    }

    await updateNotifyChannel(channel.id, {
      ...(body.data.name === undefined ? {} : { name: body.data.name }),
      ...(body.data.enabled === undefined ? {} : { enabled: body.data.enabled }),
      ...(body.data.config === undefined ? {} : { config: JSON.stringify(merged) }),
    })
    return success({ isSuccess: true, channelId: channel.id }, request)
  })

  app.post('/app/notify/channel/delete', async (request): Promise<ApiSuccessResponse<NotifyMutationResult> | ApiErrorResponse> => {
    const authError = await authorize(request, 'settings:write')
    if (authError) {
      return authError
    }
    const body = notifyChannelIdRequestSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const removed = await deleteNotifyChannel(body.data.channelId)
    if (!removed) {
      return businessError('通知渠道不存在', request)
    }
    return success({ isSuccess: true }, request)
  })

  app.post('/app/notify/channel/test', async (request): Promise<ApiSuccessResponse<NotifyTestResult> | ApiErrorResponse> => {
    const authError = await authorize(request, 'settings:write')
    if (authError) {
      return authError
    }
    const body = notifyChannelIdRequestSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    try {
      await sendTestNotification(app, body.data.channelId)
      return success({ isSuccess: true, message: '测试消息已发送，请到对应群或 App 查收' }, request)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return businessError(`测试发送失败: ${message}`, request)
    }
  })

  app.post('/app/notify/settings/get', async (request): Promise<ApiSuccessResponse<NotifySettings> | ApiErrorResponse> => {
    const authError = await authorize(request, 'settings:read')
    if (authError) {
      return authError
    }
    const settings: DbNotifySettings = await getNotifySettings()
    return success({
      enabled: settings.enabled,
      cooldownMinutes: settings.cooldownMinutes,
      thresholds: settings.thresholds,
    }, request)
  })

  app.post('/app/notify/settings/save', async (request): Promise<ApiSuccessResponse<NotifySettings> | ApiErrorResponse> => {
    const authError = await authorize(request, 'settings:write')
    if (authError) {
      return authError
    }
    const body = notifySettingsSaveRequestSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    await saveNotifySettings(body.data)
    return success(body.data, request)
  })

  // 订阅面板事件与阈值轮询（单元测试环境不启动）
  startNotifyService(app)
}
