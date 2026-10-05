import { readBrandEnv } from '../../../../shared/brand-env'

export interface SteamcmdRuntimeConfig {
  downloadRegion: string
  httpProxy: string
  httpsProxy: string
  noProxy: string
  networkMode: 'bridge' | 'host'
  installMaxAttempts: number
  installRetryDelaysMs: number[]
}

const DEFAULT_INSTALL_MAX_ATTEMPTS = 5
const DEFAULT_INSTALL_RETRY_DELAYS_MS = [4000, 8000, 8000, 8000]
/** app_update 单次运行上限：30 分钟对 4 GiB+ 游戏在慢速 CDN 下不够（下载被腰斩后同样报 exit 137） */
const DEFAULT_APP_UPDATE_TIMEOUT_MS = 60 * 60 * 1000

function parseInstallMaxAttempts(): number {
  const raw = readBrandEnv('BSP_STEAMCMD_INSTALL_MAX_ATTEMPTS')?.trim()
  if (!raw) {
    return DEFAULT_INSTALL_MAX_ATTEMPTS
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_INSTALL_MAX_ATTEMPTS
  }
  return Math.min(Math.floor(parsed), 20)
}

function parseInstallRetryDelaysMs(): number[] {
  const raw = readBrandEnv('BSP_STEAMCMD_INSTALL_RETRY_DELAYS_MS')?.trim()
  if (!raw) {
    return [...DEFAULT_INSTALL_RETRY_DELAYS_MS]
  }
  const delays = raw
    .split(',')
    .map(item => Number(item.trim()))
    .filter(value => Number.isFinite(value) && value > 0)
  if (delays.length === 0) {
    return [...DEFAULT_INSTALL_RETRY_DELAYS_MS]
  }
  return delays
}

function parseAppUpdateTimeoutMs(): number {
  const raw = readBrandEnv('BSP_STEAMCMD_APP_UPDATE_TIMEOUT_MS')?.trim()
  if (!raw) {
    return DEFAULT_APP_UPDATE_TIMEOUT_MS
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_APP_UPDATE_TIMEOUT_MS
  }
  return Math.floor(parsed)
}

/** 读取 panel.env 中的 SteamCMD 运行时调优项（安装容器专用） */
export function loadSteamcmdRuntimeConfig(): SteamcmdRuntimeConfig {
  const downloadRegion = readBrandEnv('BSP_STEAMCMD_DOWNLOAD_REGION')?.trim() ?? ''
  const httpProxy = readBrandEnv('BSP_STEAMCMD_HTTP_PROXY')?.trim() ?? ''
  const httpsProxy = readBrandEnv('BSP_STEAMCMD_HTTPS_PROXY')?.trim() || httpProxy
  const noProxy = readBrandEnv('BSP_STEAMCMD_NO_PROXY')?.trim() ?? ''
  const networkModeRaw = readBrandEnv('BSP_STEAMCMD_NETWORK_MODE')?.trim().toLowerCase() ?? ''

  return {
    downloadRegion,
    httpProxy,
    httpsProxy,
    noProxy,
    networkMode: networkModeRaw === 'host' ? 'host' : 'bridge',
    installMaxAttempts: parseInstallMaxAttempts(),
    installRetryDelaysMs: parseInstallRetryDelaysMs(),
  }
}

export function resolveSteamcmdInstallMaxAttempts(): number {
  return parseInstallMaxAttempts()
}

export function resolveSteamcmdInstallRetryDelaysMs(): number[] {
  return parseInstallRetryDelaysMs()
}

/** app_update 超时上限（毫秒）；docker 与 native 两条安装路径共用，避免两处硬编码分叉 */
export function resolveSteamcmdAppUpdateTimeoutMs(): number {
  return parseAppUpdateTimeoutMs()
}

export function formatSteamcmdTimeoutForLog(timeoutMs: number): string {
  return `${Math.round(timeoutMs / 60000)} 分钟`
}

/** 注入 SteamCMD 临时容器的代理与区域环境变量 */
export function buildSteamcmdContainerEnv(config: SteamcmdRuntimeConfig = loadSteamcmdRuntimeConfig()): string[] {
  const env: string[] = []
  if (config.httpProxy) {
    env.push(`http_proxy=${config.httpProxy}`, `HTTP_PROXY=${config.httpProxy}`)
  }
  if (config.httpsProxy) {
    env.push(`https_proxy=${config.httpsProxy}`, `HTTPS_PROXY=${config.httpsProxy}`)
  }
  if (config.noProxy) {
    env.push(`no_proxy=${config.noProxy}`, `NO_PROXY=${config.noProxy}`)
  }
  if (config.downloadRegion) {
    env.push('STEAMCMD_FORCE_DOWNLOAD_REGION=china')
  }
  return env
}
