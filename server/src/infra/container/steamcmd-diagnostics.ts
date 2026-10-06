import { readBrandEnv } from '../../../../shared/brand-env'
import fs from 'node:fs'
import { resolveDockerStatus } from '../docker'
import { resolveRuntimeStatus } from '../runtime'
import { formatSteamcmdDownloadRegionForLog, loadSteamcmdRuntimeConfig } from '../../shared/config/steamcmd'
import { getServerContainerConfig } from '../../shared/config/container'

const STEAMCDN_PROBE_URL = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz'
const STEAM_STORE_HOST = 'store.steampowered.com'

export interface SteamcmdDiagnosticsCheck {
  id: string
  ok: boolean
  message: string
}

export interface SteamcmdDiagnosticsResult {
  checks: SteamcmdDiagnosticsCheck[]
  config: {
    downloadRegion: string
    networkMode: string
    httpProxyConfigured: boolean
    httpsProxyConfigured: boolean
    installMaxAttempts: number
    installRetryDelaysMs: number[]
    steamcmdImage: string
    steamcmdPath: string
    runtimeMode: 'docker' | 'native'
  }
  suggestions: string[]
}

async function probeSteamCdn(timeoutMs = 10_000): Promise<{ ok: boolean, message: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(STEAMCDN_PROBE_URL, {
      method: 'HEAD',
      signal: controller.signal,
    })
    if (response.ok) {
      return { ok: true, message: `SteamCMD 安装包地址可达（面板进程探测，HTTP ${response.status}；不代表 Workshop 文件下载可用）` }
    }
    return { ok: false, message: `SteamCMD 安装包地址响应异常（HTTP ${response.status}）` }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `SteamCMD 安装包地址探测失败：${message}` }
  }
  finally {
    clearTimeout(timer)
  }
}

function buildSuggestions(input: {
  cdnOk: boolean
  runtimeOk: boolean
  runtimeMode: 'docker' | 'native'
  config: ReturnType<typeof loadSteamcmdRuntimeConfig>
}): string[] {
  const suggestions: string[] = []
  if (!input.runtimeOk) {
    suggestions.push(input.runtimeMode === 'native'
      ? 'systemd 用户服务管理器不可用：请确认 bsp 用户已启用 linger 且 user bus 正常。'
      : 'Docker 不可用：请确认 docker.sock 已挂载且 Docker 服务已启动。')
  }
  if (!input.cdnOk) {
    if (!input.config.httpsProxy && !input.config.httpProxy) {
      suggestions.push('可配置 BSP_STEAMCMD_HTTPS_PROXY；游戏 CDN 是否走代理需实际验证。')
    }
    suggestions.push('检查宿主机 DNS（建议 223.5.5.5 / 114.114.114.114）与系统时间同步（chrony）。')
    if (input.runtimeMode === 'docker' && input.config.networkMode !== 'host') {
      suggestions.push('持续超时时可尝试 BSP_STEAMCMD_NETWORK_MODE=host 后重启面板。')
    }
  }
  if (input.config.downloadRegion) {
    suggestions.push(formatSteamcmdDownloadRegionForLog(input.config.downloadRegion))
  }
  if (suggestions.length === 0) {
    suggestions.push('SteamCMD 安装包地址探测通过；游戏和 Workshop 内容服务器尚未验证。安装失败时请查看任务日志中的 SteamCMD 诊断。')
  }
  return suggestions
}

export async function runSteamcmdDiagnostics(): Promise<SteamcmdDiagnosticsResult> {
  const steamcmdConfig = loadSteamcmdRuntimeConfig()
  const containerConfig = getServerContainerConfig()
  const dockerStatus = containerConfig.runtimeMode === 'docker'
    ? await resolveDockerStatus(true)
    : 'stopped'
  const dockerOk = dockerStatus === 'running'
  const runtimeStatus = await resolveRuntimeStatus(true)
  const nativeSteamcmdOk = containerConfig.runtimeMode === 'native'
    && fs.existsSync(containerConfig.nativeSteamcmdPath)
  const runtimeOk = runtimeStatus === 'running'

  const cdnProbe = isSteamcmdDiagnosticsOfflineMode()
    ? { ok: true, message: '已跳过 SteamCMD 安装包地址探测；Workshop 文件下载尚未验证' }
    : await probeSteamCdn()
  const checks: SteamcmdDiagnosticsCheck[] = [
    {
      id: 'runtime',
      ok: runtimeOk,
      message: containerConfig.runtimeMode === 'native'
        ? (runtimeOk ? 'systemd 用户服务管理器可用' : `systemd 用户服务管理器不可用（${runtimeStatus}）`)
        : (dockerOk ? 'Docker 引擎可用' : `Docker 不可用（${dockerStatus}）`),
    },
    {
      id: 'steamcmd_runtime',
      ok: containerConfig.runtimeMode === 'docker' ? dockerOk : nativeSteamcmdOk,
      message: containerConfig.runtimeMode === 'native'
        ? (nativeSteamcmdOk
            ? `Native SteamCMD 已安装：${containerConfig.nativeSteamcmdPath}`
            : `Native SteamCMD 不存在：${containerConfig.nativeSteamcmdPath}`)
        : `SteamCMD 容器镜像：${containerConfig.steamcmdImage}`,
    },
    {
      id: 'steamcdn',
      ok: cdnProbe.ok,
      message: cdnProbe.message,
    },
    {
      id: 'steam_store_dns',
      ok: true,
      message: `Steam 商店参考域名：${STEAM_STORE_HOST}（未执行 DNS 探测，不代表游戏内容服务器可达）`,
    },
    {
      id: 'download_region',
      ok: !steamcmdConfig.downloadRegion,
      message: formatSteamcmdDownloadRegionForLog(steamcmdConfig.downloadRegion),
    },
    {
      id: 'network_mode',
      ok: true,
      message: containerConfig.runtimeMode === 'native'
        ? 'Native SteamCMD 直接使用宿主机网络'
        : `SteamCMD 容器网络模式：${steamcmdConfig.networkMode}`,
    },
  ]

  return {
    checks,
    config: {
      downloadRegion: steamcmdConfig.downloadRegion,
      networkMode: steamcmdConfig.networkMode,
      httpProxyConfigured: Boolean(steamcmdConfig.httpProxy),
      httpsProxyConfigured: Boolean(steamcmdConfig.httpsProxy),
      installMaxAttempts: steamcmdConfig.installMaxAttempts,
      installRetryDelaysMs: steamcmdConfig.installRetryDelaysMs,
      steamcmdImage: containerConfig.steamcmdImage,
      steamcmdPath: containerConfig.nativeSteamcmdPath,
      runtimeMode: containerConfig.runtimeMode,
    },
    suggestions: buildSuggestions({
      cdnOk: cdnProbe.ok,
      runtimeOk,
      runtimeMode: containerConfig.runtimeMode,
      config: steamcmdConfig,
    }),
  }
}

/** 供测试：是否跳过外网探测 */
export function isSteamcmdDiagnosticsOfflineMode(): boolean {
  return readBrandEnv('BSP_STEAMCMD_DIAGNOSTICS_SKIP_NETWORK')?.trim() === '1'
}
