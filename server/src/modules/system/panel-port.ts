import { readBrandEnv } from '../../../../shared/brand-env'
import type { FastifyRequest } from 'fastify'
import type { ServerConfig } from '../../shared/config'
import { loadServerConfig } from '../../shared/config'
import {
  getSystemPanelSettings,
  saveSystemPanelSettings,
} from '../../shared/db/index'
import { getDefaultPanelSettings } from './defaults'
import type { PanelPortEnvKey, PanelPortSyncResult } from './panel-port-deploy'
import {
  buildPanelEnvCandidates,
  buildPanelPortManualCommand,
  resolvePanelEnvFileWithKey,
  writePanelEnvPort,
} from './panel-port-deploy'
import { resolveApplySupport, writePanelPortViaStackContainer } from './panel-update'

function parsePort(value: string | undefined): number | null {
  if (!value?.trim()) {
    return null
  }
  const port = Number.parseInt(value.trim(), 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return null
  }
  return port
}

function parsePortFromHost(host: string): number | null {
  const trimmed = host.trim()
  if (!trimmed) {
    return null
  }
  if (trimmed.startsWith('[')) {
    const closingBracket = trimmed.indexOf(']')
    if (closingBracket === -1) {
      return null
    }
    const remainder = trimmed.slice(closingBracket + 1)
    if (!remainder.startsWith(':')) {
      return null
    }
    return parsePort(remainder.slice(1))
  }
  const lastColon = trimmed.lastIndexOf(':')
  if (lastColon <= 0) {
    return null
  }
  return parsePort(trimmed.slice(lastColon + 1))
}

export function resolveActualPanelPort(input: {
  serverPort: number
  publishedPortEnv?: string
  hostHeader?: string
  forwardedHost?: string
  forwardedPort?: string
}): number {
  const fromEnv = parsePort(input.publishedPortEnv)
  if (fromEnv) {
    return fromEnv
  }

  const fromForwardedPort = parsePort(input.forwardedPort)
  if (fromForwardedPort) {
    return fromForwardedPort
  }

  const host = input.forwardedHost?.trim() || input.hostHeader?.trim()
  if (host) {
    const fromHost = parsePortFromHost(host)
    if (fromHost) {
      return fromHost
    }
  }

  return input.serverPort
}

export function resolveActualPanelPortFromRequest(
  serverPort: number,
  request: Pick<FastifyRequest, 'headers'>,
): number {
  const headers = request.headers
  const forwardedHost = Array.isArray(headers['x-forwarded-host'])
    ? headers['x-forwarded-host'][0]
    : headers['x-forwarded-host']
  const forwardedPort = Array.isArray(headers['x-forwarded-port'])
    ? headers['x-forwarded-port'][0]
    : headers['x-forwarded-port']
  const hostHeader = Array.isArray(headers.host)
    ? headers.host[0]
    : headers.host

  return resolveActualPanelPort({
    serverPort,
    publishedPortEnv: readBrandEnv('BSP_PANEL_PUBLISHED_PORT'),
    hostHeader,
    forwardedHost,
    forwardedPort,
  })
}

export interface PanelPortBootstrapSyncInput {
  mode: 'development' | 'test' | 'production'
  publishedPortEnv?: string
  existingPanelPort?: number
  defaultPanelPort: number
}

/**
 * 计算「面板端口」启动引导值，返回应写入的端口，null 表示不写。
 *
 * 仅生产部署且通过 BSP_PANEL_PUBLISHED_PORT 显式声明对外发布端口（compose 栈）时，
 * 才允许把发布端口初始化/校正进「面板端口」设置：
 * - 开发/测试环境没有"对外发布端口"语义，禁止把后端监听端口固化成面板端口（避免
 *   dev 后端 8888 / dev:compose 发布端口被误同步进设置与 panel.env 的 VITE_DEV_WEB_PORT）；
 * - 用户已显式设置过的面板端口（不等于出厂默认）永不覆盖。
 */
export function resolvePanelPortBootstrapSync(input: PanelPortBootstrapSyncInput): number | null {
  if (input.mode !== 'production') {
    return null
  }
  const publishedPort = parsePort(input.publishedPortEnv)
  if (!publishedPort) {
    return null
  }
  // 全新数据库：以实际发布端口初始化
  if (input.existingPanelPort === undefined) {
    return publishedPort
  }
  // 仍为出厂默认值：校正为实际发布端口
  if (input.existingPanelPort === input.defaultPanelPort && publishedPort !== input.defaultPanelPort) {
    return publishedPort
  }
  return null
}

export async function syncPanelPortSettingIfStale(input: {
  mode: 'development' | 'test' | 'production'
}): Promise<void> {
  const settings = await getSystemPanelSettings()
  const defaults = getDefaultPanelSettings()
  const nextPort = resolvePanelPortBootstrapSync({
    mode: input.mode,
    publishedPortEnv: readBrandEnv('BSP_PANEL_PUBLISHED_PORT'),
    existingPanelPort: settings?.panelPort,
    defaultPanelPort: defaults.panelPort,
  })
  if (nextPort === null) {
    return
  }
  await saveSystemPanelSettings({
    ...(settings ?? defaults),
    panelPort: nextPort,
  })
}

function buildWrittenResult(envKey: PanelPortEnvKey, port: number): PanelPortSyncResult {
  return {
    status: 'written',
    envKey,
    port,
    message: `已写入服务器上的端口配置，下次重启面板后使用新端口；请记得在安全组或防火墙放行 ${port} 端口。`,
    manualCommand: null,
  }
}

function buildManualResult(
  config: ServerConfig,
  envKey: PanelPortEnvKey,
  port: number,
  reason: string | null,
): PanelPortSyncResult {
  return {
    status: 'manual',
    envKey,
    port,
    message: `${reason ? `${reason} ` : ''}请在服务器上执行下方命令，然后重启面板，并放行新端口。`,
    manualCommand: buildPanelPortManualCommand({
      runtimeMode: config.runtimeMode,
      stackDir: config.stackDir,
      composeFiles: config.composeFiles,
      envKey,
      port,
    }),
  }
}

/**
 * 把「面板端口」设置真正落到部署配置上。
 *
 * 面板实际监听/对外的端口只来自部署配置——Docker 部署读 `panel.env` 的 `PANEL_PORT`（决定宿主机
 * 端口映射，容器内恒为 8888），Native/systemd 部署读同一文件的 `SERVER_PORT`；数据库里的
 * `panelPort` 只是记录。所以保存设置时必须真的写文件，「重启后生效」才不是一句空话。
 *
 * 刻意不自动重建面板：用户预期的是"下次重启时生效"，中途掐断连接只会更糟。
 * 本函数一律不抛错——写不进去只回报需要手动处理的说明，保存设置本身仍然成功。
 */
export async function applyPanelPortToDeployment(input: {
  port: number
  request: Pick<FastifyRequest, 'headers'>
  config?: ServerConfig
}): Promise<PanelPortSyncResult> {
  const config = input.config ?? loadServerConfig()
  // 本地开发/测试没有"对外发布端口"语义：端口由开发命令与 VITE_DEV_WEB_PORT 决定，不动部署配置
  if (config.mode !== 'production') {
    return {
      status: 'skipped',
      envKey: null,
      port: input.port,
      message: '本地开发环境不修改服务器的端口配置。',
      manualCommand: null,
    }
  }

  const currentPort = resolveActualPanelPortFromRequest(config.port, input.request)
  if (currentPort === input.port) {
    return {
      status: 'unchanged',
      envKey: null,
      port: input.port,
      message: '保存的端口与当前端口一致，无需修改。',
      manualCommand: null,
    }
  }

  const envKey: PanelPortEnvKey = config.runtimeMode === 'native' ? 'SERVER_PORT' : 'PANEL_PORT'

  if (config.runtimeMode === 'native') {
    const envFile = resolvePanelEnvFileWithKey(buildPanelEnvCandidates(config.stackDir), envKey)
    if (envFile) {
      try {
        writePanelEnvPort(envFile, envKey, input.port)
        return buildWrittenResult(envKey, input.port)
      }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return buildManualResult(config, envKey, input.port, `无法自动写入端口配置（${reason}）。`)
      }
    }
    return buildManualResult(config, envKey, input.port, '找不到服务器上的端口配置文件。')
  }

  const support = resolveApplySupport(config)
  if (support.imageSupported && support.stackPaths) {
    const written = await writePanelPortViaStackContainer({
      stackPaths: support.stackPaths,
      envKey,
      port: input.port,
    })
    if (written.ok) {
      return buildWrittenResult(envKey, input.port)
    }
    return buildManualResult(config, envKey, input.port, written.error)
  }
  return buildManualResult(config, envKey, input.port, support.hint)
}
